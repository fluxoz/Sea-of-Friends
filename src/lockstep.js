/**
 * lockstep.js – Deterministic lockstep netcode with prediction + rollback.
 *
 * Only INPUTS travel the network, and two timelines run over them:
 *
 *   CONFIRMED — advances only when every active peer's real input for the
 *   tick is in hand (classic lockstep). All consequential machinery lives
 *   here: roster commands, state-hash exchange, join snapshots, departures.
 *   Bit-identical on every peer, verified by the hash tripwire.
 *
 *   PREDICTED — what the renderer sees. It runs ahead of confirmed toward
 *   the wall clock using real inputs where they've already arrived and
 *   synthesized ones (course held, guns silent) where they haven't. When
 *   reality disagrees, the sim rolls back to the confirmed snapshot and
 *   re-simulates — so a laggy peer costs a small correction, not a freeze.
 *   The window is capped (PREDICT_MAX); a peer who stays silent past the
 *   cap stalls the screen briefly and is then ejected via the departure
 *   protocol, exactly as if they had disconnected. They can rejoin.
 *
 * Roster changes (joins, departures) ride inside the input stream of the
 * "orderer" (lowest active peer id), which gives them a deterministic tick on
 * every peer — and they are honoured only on the confirmed timeline.
 *
 * Late joiners bootstrap from any running peer's CONFIRMED snapshot and
 * fast-forward on live inputs.
 */
import { TICK_MS } from './sim.js'

const INPUT_DELAY   = 2        // ticks of latency-hiding input delay (100 ms)
const MAX_CATCHUP   = 30       // max ticks executed per pump (stall recovery)
const HASH_EVERY    = 40       // ticks between state-hash broadcasts (2 s)
const JOIN_MARGIN   = 10       // ticks between a join command and required inputs
const BOOT_WAIT_MS  = 6000     // how long to look for an existing crew
const SREQ_MS       = 1500
const LEAVE_WAIT_MS = 1500
const STALL_TICKS   = 8        // behind-schedule threshold before "waiting…"
const PREDICT_MAX   = 40       // prediction window: 2 s of ticks past confirmed
const EJECT_MS      = 6000     // confirmed frozen this long → drop the blockers
const PARK_GRACE_MS = 45000    // a dropped peer's ship holds station this long

export class Lockstep {
  /**
   * @param {import('./network.js').NetworkManager} network
   * @param {object} hooks
   * @param {() => {seed:number, foundedAt:number}} hooks.found        create a fresh world; self already added
   * @param {(tick:number, inputs:Map, cmds:Array) => void} hooks.executeTick
   * @param {() => object}    hooks.getSnapshot
   * @param {(s:object) => void} hooks.loadSnapshot  full load (late join)
   * @param {(s:object) => void} hooks.rollback      fast in-place restore
   * @param {() => number}    hooks.getHash
   * @param {(names:string[]|null) => void} hooks.onStall
   * @param {(pid:string, tick:number) => void} hooks.onDesync
   * @param {() => void}      hooks.onSelfJoined   own ship is live in the sim
   * @param {(state:string) => void} hooks.onState  'boot'|'joining'|'running'
   */
  constructor(network, hooks) {
    this.network = network
    this.hooks   = hooks
    this.selfId  = network.selfId

    this.state     = 'boot'
    this.foundedAt = 0
    this._bootDeadline = performance.now() + BOOT_WAIT_MS
    this._lastSreq = 0
    this._jreqSent = 0
    this._selfLive = false

    // Two timelines. `confirmed` advances only on complete real inputs and
    // carries everything consequential (roster cmds, hashes, join snapshots).
    // `executed` is the PREDICTED head the renderer sees: it runs ahead of
    // confirmed on predicted inputs and is rolled back + re-simulated when
    // reality disagrees. executed ≥ confirmed always.
    this.executed  = 0
    this.confirmed = 0
    this.sendTick  = 1
    this.startWall = 0
    this.rollbacks = 0             // diagnostic counter
    this._confirmedSnap = null     // sim snapshot at `confirmed`
    this._predDirty = false        // a real input landed inside the window
    this._predBase  = new Map()    // pid → last real packet (prediction base)
    this._confirmedAt = performance.now()
    // Test hooks: ?lagms=250 delays inbound input delivery (rollback
    // torture); ?parkms=5000 shortens the reconnect grace for CI
    const params = typeof location !== 'undefined'
      ? new URLSearchParams(location.search) : new Map()
    this._testLag = +(params.get('lagms') || 0)
    this._parkGrace = +(params.get('parkms') || 0) || PARK_GRACE_MS

    /** @type {Map<string, {start:number, end:number|null, reports?:Map, leaveStarted?:number}>} */
    this.roster = new Map()
    /** @type {Map<string, Map<number, object>>} pid → tick → input packet */
    this.inputs = new Map()
    this._pendingJoins = []      // orderer: pids awaiting a join command
    this._pendingCmds  = []      // orderer: park/drop commands to embed
    this._sentCmdsFor  = new Set()
    this._parkExpiry   = new Map()  // pid → wall deadline for a parked ship
    this._deliberate   = new Set()  // peers that said goodbye (skip parking)
    this._banned       = new Map()  // orderer: kicked pid → readmit-after (wall ms)
    this.kicked        = false      // we were voted off — stop auto-rejoining
    this._hashes = new Map()     // tick → own hash

    this._wire()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Network wiring
  // ──────────────────────────────────────────────────────────────────────────

  _wire() {
    const net = this.network

    net.onInput = (pid, data) => {
      if (!data || typeof data.t !== 'number') return
      if (this._testLag > 0) setTimeout(() => this._receiveInput(pid, data), this._testLag)
      else this._receiveInput(pid, data)
    }

    net.onSreq = pid => {
      if (this.state !== 'running' || !this._confirmedSnap) return
      // Any running peer's snapshot is valid — deterministic state. Serve the
      // CONFIRMED state (never a predicted one) plus the real inputs past it.
      const pending = []
      for (const [ppid, buf] of this.inputs) {
        for (const [t, inp] of buf) {
          if (t > this.confirmed) pending.push([ppid, inp])
        }
      }
      net.sendSnap({
        foundedAt: this.foundedAt,
        state: this._confirmedSnap,
        roster: [...this.roster.entries()].map(([id, r]) => [id, r.start, r.end]),
        pending,
      }, pid)
    }

    net.onSnap = (_pid, data) => {
      if (!data || !data.state) return
      if (this.state === 'running') {
        // Founder collision: the older sea wins; the newer founder re-joins.
        if (data.foundedAt < this.foundedAt) this._demote()
        else return
      }
      this._adopt(data)
    }

    net.onJreq = (pid, data) => {
      if (this.state !== 'running' || this._orderer() !== this.selfId) return
      const ban = this._banned.get(pid)
      if (ban !== undefined) {
        if (performance.now() < ban) return   // voted off — not yet welcome back
        this._banned.delete(pid)
      }
      if (this.roster.has(pid) && this.roster.get(pid).end === null) return
      if (!this._pendingJoins.some(j => j.pid === pid)) {
        this._pendingJoins.push({ pid, cls: data?.c })
      }
    }

    net.onHashMsg = (pid, data) => {
      if (!data) return
      if (this.state === 'running' && typeof data.f === 'number' && data.f < this.foundedAt) {
        // We're on a younger fork of reality — defer to the older sea.
        this._demote()
        return
      }
      // A YOUNGER fork's hashes are not comparable to ours and they will
      // demote themselves — comparing would spray phantom desyncs (and the
      // fork-streak rule must never trigger across different foundings)
      if (typeof data.f === 'number' && data.f > this.foundedAt) return
      if (this.state !== 'running' || typeof data.t !== 'number') return
      const own = this._hashes.get(data.t)
      if (own === undefined) return
      if (own.h === data.h) {
        this._forkStreak = 0
        return
      }
      this.hooks.onDesync(pid, data.t, own.pp, data.pp)
      // Partition healing: a network split leaves two live seas with the
      // SAME foundedAt that ejected each other; when connectivity returns,
      // their hashes disagree forever. After a persistent streak, exactly
      // one side yields: the smaller crew, or on a tie the one whose lowest
      // pid sorts higher. Losers demote and rejoin from the winner's
      // snapshot — same machinery as any late join.
      this._forkStreak = (this._forkStreak || 0) + 1
      if (this._forkStreak >= 3 && typeof data.n === 'number') {
        const myN = this._activeCount()
        const myLow = this._orderer()
        if (data.n > myN || (data.n === myN && data.low != null && myLow > data.low)) {
          this._forkStreak = 0
          this._demote()
        }
      }
    }

    net.onLastIn = (pid, data) => {
      if (!data) return
      // The crew is agreeing on OUR departure — we stalled too long and got
      // ejected. Continuing would fork the timeline (our roster still thinks
      // we're the orderer), so demote and rejoin from a fresh snapshot.
      // Spoof guard: a forged report about us is only credible if our
      // confirmed timeline has ACTUALLY been stalled — a healthy peer
      // ignores it (a griefer could otherwise bounce anyone at will).
      if (data.p === this.selfId && this.state === 'running') {
        const stalled = performance.now() - this._confirmedAt > 3000
        if (stalled) this._demote()
        return
      }
      const entry = this.roster.get(data.p)
      if (entry && entry.reports) entry.reports.set(pid, data.l | 0)
    }

    net.onRelayIn = (_pid, data) => {
      if (!data || !Array.isArray(data.rows)) return
      for (const [ppid, inp] of data.rows) this._bufferInput(ppid, inp)
    }

    net.onPeerGone = pid => this._beginLeave(pid)

    // A peer that says goodbye is quitting on purpose — no parking grace
    net.onBye = pid => this._deliberate.add(pid)
  }

  _receiveInput(pid, packet) {
    this._acceptInput(pid, packet)
    // Redundant history: fills the holes left by lost fast-lane datagrams
    if (Array.isArray(packet.h)) {
      for (const past of packet.h) {
        if (past && typeof past.t === 'number') this._acceptInput(pid, past)
      }
    }
  }

  _acceptInput(pid, packet) {
    this._bufferInput(pid, packet)
    // A real input landing inside the predicted window invalidates the
    // prediction built without it
    if (packet.t > this.confirmed && packet.t <= this.executed && pid !== this.selfId) {
      this._predDirty = true
    }
  }

  _bufferInput(pid, packet) {
    let buf = this.inputs.get(pid)
    if (!buf) { buf = new Map(); this.inputs.set(pid, buf) }
    if (!buf.has(packet.t)) buf.set(packet.t, packet)
  }

  _lastTickOf(pid) {
    const buf = this.inputs.get(pid)
    if (!buf) return 0
    let max = 0
    for (const t of buf.keys()) if (t > max) max = t
    return max
  }

  _orderer() {
    let low = null
    for (const [pid, r] of this.roster) {
      if (r.end !== null) continue
      if (low === null || pid < low) low = pid
    }
    return low
  }

  _activeCount() {
    let n = 0
    for (const r of this.roster.values()) if (r.end === null) n++
    return n
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  _found() {
    // found() either charts a fresh sea (tick 0) or resumes a saved one —
    // resumeTick restarts the clock where the saved world left off, and the
    // ORIGINAL foundedAt is kept so a resumed sea outranks fresh founders
    // of the same room in a founder collision.
    const { foundedAt, resumeTick } = this.hooks.found()
    const t0 = resumeTick ?? 0
    this.foundedAt = foundedAt
    this.executed  = t0
    this.confirmed = t0
    this.sendTick  = t0 + 1
    this.startWall = performance.now() - t0 * TICK_MS
    this.roster.set(this.selfId, { start: t0 + 1, end: null })
    this._confirmedSnap = this.hooks.getSnapshot()
    this._confirmedAt = performance.now()
    this._startReplay()
    this.state = 'running'
    this._selfLive = true
    this.hooks.onState('running')
    this.hooks.onSelfJoined()
  }

  /**
   * Replay recording: a deterministic sim means a snapshot plus the input
   * stream IS a bit-perfect replay. Records the confirmed timeline only —
   * predictions never happened.
   */
  _startReplay() {
    this._replay = {
      startedAt: Date.now(),
      foundedAt: this.foundedAt,
      startTick: this.confirmed,
      snap: JSON.parse(JSON.stringify(this._confirmedSnap)),
      records: [],
    }
  }

  getReplay() { return this._replay }

  _adopt(data) {
    this.hooks.loadSnapshot(data.state)
    this.foundedAt = data.foundedAt
    this.executed  = data.state.tick
    this.confirmed = data.state.tick
    this._confirmedSnap = data.state
    this._confirmedAt = performance.now()
    this.sendTick  = data.state.tick + 1
    this.startWall = performance.now() - data.state.tick * TICK_MS
    this.roster.clear()
    for (const [id, start, end] of data.roster ?? []) {
      this.roster.set(id, { start, end: end ?? null })
    }
    for (const [ppid, inp] of data.pending ?? []) this._bufferInput(ppid, inp)
    this._selfLive = this.roster.has(this.selfId) && this.roster.get(this.selfId).end === null
    this._startReplay()
    this.state = 'running'
    this.hooks.onState('running')
  }

  _demote() {
    this.state = 'joining'
    this._selfLive = false
    this.roster.clear()
    this.inputs.clear()
    this._hashes.clear()
    this._pendingJoins = []
    this.hooks.onState('joining')
  }

  // ──────────────────────────────────────────────────────────────────────────
  // The pump — call every ~25 ms from a timer (not rAF: must run in background)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {() => object} makeInput  captures the local input for one tick
   */
  pump(makeInput) {
    if (this.hold) return   // test hook: simulate a frozen peer
    const now = performance.now()

    if (this.state === 'boot') {
      if (now - this._lastSreq > SREQ_MS) { this._lastSreq = now; this.network.sendSreq({}) }
      if (now >= this._bootDeadline) this._found()
      return
    }

    if (this.state === 'joining') {
      if (now - this._lastSreq > SREQ_MS) { this._lastSreq = now; this.network.sendSreq({}) }
      return
    }

    // ── running ────────────────────────────────────────────────────────────
    const dueTick = Math.floor((now - this.startWall) / TICK_MS)

    // Ask to be let aboard until our own join command lands (not after a
    // votekick — the crew doesn't want us back)
    if (!this._selfLive && !this.kicked && now - this._jreqSent > 2000) {
      this._jreqSent = now
      this.network.sendJreq({ c: this.shipClass })
    }

    // Send inputs ahead of execution (INPUT_DELAY hides network latency).
    // Each packet carries the last few inputs redundantly: the fast lane is
    // deliberately lossy, and any dropped datagram is filled by the next.
    while (this.sendTick <= dueTick + INPUT_DELAY) {
      const t = this.sendTick++
      const packet = { t, ...makeInput() }
      const cmds = this._takeCmds(t)
      if (cmds.length) packet.c = cmds
      this._bufferInput(this.selfId, packet)
      if (!this._sentRecent) this._sentRecent = []
      if (this._sentRecent.length) packet.h = this._sentRecent.slice(-8)
      this.network.sendInput(packet)
      const { h, ...bare } = packet
      this._sentRecent.push(bare)
      if (this._sentRecent.length > 8) this._sentRecent.shift()
    }

    // ── 1. Advance the CONFIRMED timeline on complete real inputs ──────────
    // Any confirmed progress (and any late real input inside the window)
    // means the predicted overlay was built on stale data: roll the sim back
    // to the confirmed state first, then re-predict after.
    if (this._canExecute(this.confirmed + 1) || this._predDirty) {
      if (this.executed > this.confirmed) {
        this.hooks.rollback(this._confirmedSnap)
        this.executed = this.confirmed
        this.rollbacks++
      }
      this._predDirty = false
      let n = 0
      while (this.confirmed < dueTick && this._canExecute(this.confirmed + 1)
             && n++ < MAX_CATCHUP) {
        this._executeConfirmed(this.confirmed + 1)
      }
      if (n > 0) {
        this.executed = this.confirmed
        this._confirmedSnap = this.hooks.getSnapshot()
        this._confirmedAt = now
        // Prediction bases: everyone's real packet at the confirmed tick
        this._predBase.clear()
        for (const [pid, r] of this.roster) {
          if (!this._activeAt(r, this.confirmed)) continue
          const pk = this.inputs.get(pid)?.get(this.confirmed)
          if (pk) this._predBase.set(pid, pk)
        }
      }
    }

    // ── 2. PREDICT forward toward the wall clock, capped ───────────────────
    const target = Math.min(dueTick, this.confirmed + PREDICT_MAX)
    let steps = 0
    while (this.executed < target && steps++ < MAX_CATCHUP) {
      this._executePredicted(this.executed + 1)
    }

    // Pinned at the prediction cap: freeze our own pacing too, so the input
    // stream and the wall clock don't run away and owe a giant burst later
    if (this.executed >= this.confirmed + PREDICT_MAX && dueTick > this.executed + 2) {
      this.startWall = now - (this.executed + 2) * TICK_MS
    } else {
      // Time sync: persistently predicting far ahead means our clock leads
      // the crew's (snapshot-transfer skew, drift). Bleed it back a little
      // each pump so the prediction window converges to the real network
      // latency instead of staying inflated forever. Bounded and one-sided:
      // peers only slow down, so the crew settles on the slowest clock.
      const lag = this.executed - this.confirmed
      if (lag > 6) this.startWall += Math.min(2, (lag - 6) * 0.2)
    }

    // ── 3. Departure bookkeeping + unresponsive-peer eject ─────────────────
    this._settleLeaves(now)
    if (this._selfLive && now - this._confirmedAt > EJECT_MS) {
      for (const pid of this._blockersAt(this.confirmed + 1)) this._beginLeave(pid)
    }

    // Stall reporting (only once the SCREEN freezes — prediction hides the rest)
    if (this.executed < dueTick - STALL_TICKS) {
      this.hooks.onStall(this._blockersAt(this.confirmed + 1))
    } else {
      this.hooks.onStall(null)
    }
  }

  /**
   * Votekick: the crew agreed (majority tallied out-of-band) — the orderer
   * ejects the target through the normal departure agreement, marks the
   * departure deliberate (no parking grace), and refuses re-admission for a
   * while. The {d, k:1} command tells the target it was a kick, not a drop.
   */
  kick(pid) {
    if (this._orderer() !== this.selfId || pid === this.selfId) return false
    const entry = this.roster.get(pid)
    if (!entry || entry.end !== null) return false
    this._deliberate.add(pid)
    this._kicking = (this._kicking ?? new Set()).add(pid)
    this._banned.set(pid, performance.now() + 5 * 60 * 1000)
    this._beginLeave(pid)
    return true
  }

  _blockersAt(t) {
    const blockers = []
    for (const [pid, r] of this.roster) {
      if (pid === this.selfId) continue
      if (!this._activeAt(r, t)) continue
      if (!this.inputs.get(pid)?.has(t)) blockers.push(pid)
    }
    return blockers
  }

  /**
   * One predicted tick: real packets where they've arrived, synthesized ones
   * (helm held, guns silent) for peers whose inputs are still in flight.
   * Roster commands are never honoured here — they belong to the confirmed
   * timeline, where every peer processes them at the same tick.
   */
  _executePredicted(t) {
    const inputs = new Map()
    for (const [pid, r] of this.roster) {
      if (!this._activeAt(r, t)) continue
      const real = this.inputs.get(pid)?.get(t)
      if (real) {
        inputs.set(pid, real)
        this._predBase.set(pid, real)
      } else {
        const base = this._predBase.get(pid)
        // Hold course and trim; never predict a fire or a roster command
        inputs.set(pid, base
          ? { t, s: base.s, n: base.n, z: base.z, r: base.r, e: base.e, v: base.v }
          : { t })
      }
    }
    this.hooks.executeTick(t, inputs, [])
    this.executed = t
  }

  _activeAt(r, t) {
    return t >= r.start && (r.end === null || t <= r.end)
  }

  _canExecute(t) {
    for (const [pid, r] of this.roster) {
      if (!this._activeAt(r, t)) continue
      if (!this.inputs.get(pid)?.has(t)) return false
    }
    return true
  }

  _executeConfirmed(t) {
    const inputs = new Map()
    const cmds = []
    const orderer = this._orderer()
    for (const [pid, r] of this.roster) {
      if (!this._activeAt(r, t)) continue
      const packet = this.inputs.get(pid).get(t)
      inputs.set(pid, packet)
      // Roster commands are honoured only from the current orderer's stream;
      // self-scoped store buys ({b, w:self}) are honoured from any peer
      if (pid !== orderer && Array.isArray(packet.c)) {
        for (const cmd of packet.c) {
          if (cmd.b !== undefined && cmd.w === pid) cmds.push(cmd)
        }
      }
      if (pid === orderer && Array.isArray(packet.c)) {
        for (const cmd of packet.c) {
          cmds.push(cmd)
          if (cmd.j) this.roster.set(cmd.j, { start: t + INPUT_DELAY + JOIN_MARGIN, end: null })
          if (cmd.d) {
            const e = this.roster.get(cmd.d)
            if (e && e.end === null) e.end = t
            this._sentCmdsFor.delete(cmd.d)   // they may rejoin later
            // Ejected while alive (we stalled too long): go re-join —
            // unless it was a votekick, in which case stay gone
            if (cmd.d === this.selfId) {
              this._selfLive = false
              if (cmd.k) {
                this.kicked = true
                this.hooks.onKicked?.()
              }
            }
          }
          // {p}: park — the sim anchors the ship; roster end was already
          // agreed in the departure settlement, so nothing changes here
          if (cmd.p) this._sentCmdsFor.delete(cmd.p)
        }
      }
    }

    if (this._replay && this._replay.records.length < 400000) {
      const rec = [t, [...inputs].map(([pid, pk]) => {
        if (!pk.h && !pk.c) return [pid, pk]
        const { h, c, ...bare } = pk
        return [pid, bare]
      })]
      if (cmds.length) rec.push(cmds)
      this._replay.records.push(rec)
    }

    this.hooks.executeTick(t, inputs, cmds)
    this.confirmed = t

    // Own ship comes alive the tick our join command executes
    if (!this._selfLive) {
      const r = this.roster.get(this.selfId)
      if (r && r.end === null) {
        this._selfLive = true
        // Make sure our input stream reaches our required start tick promptly
        this.sendTick = Math.max(this.sendTick, this.confirmed + 1)
        this.hooks.onSelfJoined()
      }
    }

    // Periodic state-hash exchange (this is the anti-tamper tripwire).
    // n/low describe our crew so a healed partition can pick a winner.
    if (t % HASH_EVERY === 0) {
      const h = this.hooks.getHash()
      const pp = this.hooks.getHashParts?.() ?? null
      this._hashes.set(t, { h, pp })
      if (this._hashes.size > 12) {
        const oldest = Math.min(...this._hashes.keys())
        this._hashes.delete(oldest)
      }
      this.network.sendHashMsg({
        t, h, pp, f: this.foundedAt,
        n: this._activeCount(), low: this._orderer(),
      })
    }

    // Prune old input buffers
    if (t % 100 === 0) {
      for (const buf of this.inputs.values()) {
        for (const bt of buf.keys()) if (bt < t - 400) buf.delete(bt)
      }
    }
  }

  /** Queue a command to ride this peer's next input packet — it lands on the
   *  confirmed timeline at the same tick for everyone (e.g. store buys). */
  queueCmd(cmd) {
    (this._localCmds ?? (this._localCmds = [])).push(cmd)
  }

  _takeCmds(_tick) {
    const cmds = []
    if (this._localCmds?.length) {
      cmds.push(...this._localCmds)
      this._localCmds = []
    }
    if (this._orderer() === this.selfId) {
      for (const join of this._pendingJoins) {
        if (!this._sentCmdsFor.has(join.pid)) {
          this._sentCmdsFor.add(join.pid)
          this._parkExpiry.delete(join.pid)   // coming back aboard — unpark
          cmds.push({ j: join.pid, c: join.cls })
        }
      }
      this._pendingJoins = []
      cmds.push(...this._pendingCmds)
      this._pendingCmds = []
    }
    return cmds
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Departures: agree on the leaver's final input tick, then drop them
  // ──────────────────────────────────────────────────────────────────────────

  _beginLeave(pid) {
    const entry = this.roster.get(pid)
    if (!entry || entry.end !== null || entry.leaveStarted) return
    entry.leaveStarted = performance.now()
    entry.reports = new Map([[this.selfId, this._lastTickOf(pid)]])
    this.network.sendLastIn({ p: pid, l: this._lastTickOf(pid) })
  }

  _settleLeaves(now) {
    for (const [pid, entry] of this.roster) {
      if (!entry.leaveStarted || entry.end !== null) continue
      if (now - entry.leaveStarted < LEAVE_WAIT_MS) continue

      const reports = [...entry.reports.values()]
      const maxLast = Math.max(...reports)
      const minLast = Math.min(...reports)

      // If we hold inputs someone else is missing, relay them
      if (this._lastTickOf(pid) === maxLast && maxLast > minLast) {
        const rows = []
        const buf = this.inputs.get(pid)
        if (buf) {
          for (let t = minLast + 1; t <= maxLast; t++) {
            if (buf.has(t)) rows.push([pid, buf.get(t)])
          }
        }
        if (rows.length) this.network.sendRelayIn({ rows })
      }

      // Deterministic across peers: derived only from the shared reports.
      // confirmed can never pass the leaver's missing input, so every peer
      // holds all their inputs ≤ maxLast after the relay. A leaver who never
      // sent anything gets an empty active range (end < start).
      entry.end = Math.max(maxLast, entry.start - 1)
      entry.leaveStarted = null

      // The orderer schedules what happens to their ship. A deliberate
      // goodbye (quit button, page close) drops it at once; a silent
      // disconnect PARKS it — the ship holds station for PARK_GRACE_MS so a
      // wifi blip puts the captain back aboard, purse intact. Expiry turns
      // the park into a normal drop.
      if (this._orderer() === this.selfId || this._orderer() === pid) {
        this._pendingJoins = this._pendingJoins.filter(j => j.pid !== pid)
      }
      if (this._ordererAfter(pid) === this.selfId) {
        if (this._deliberate.has(pid)) {
          const cmd = { d: pid }
          if (this._kicking?.has(pid)) { cmd.k = 1; this._kicking.delete(pid) }
          this._pendingCmds.push(cmd)
          this._deliberate.delete(pid)
        } else {
          this._pendingCmds.push({ p: pid })
          this._parkExpiry.set(pid, now + this._parkGrace)
        }
      }
    }

    // Parked ships whose captains never came back go down for real
    if (this._orderer() === this.selfId) {
      for (const [pid, deadline] of this._parkExpiry) {
        if (now >= deadline) {
          this._parkExpiry.delete(pid)
          this._pendingCmds.push({ d: pid })
        }
      }
    }
  }

  /** Who orders roster changes once `leaving` is excluded. */
  _ordererAfter(leaving) {
    let low = null
    for (const [pid, r] of this.roster) {
      if (pid === leaving) continue
      if (r.end !== null && r.end < this.confirmed) continue
      if (low === null || pid < low) low = pid
    }
    return low
  }
}
