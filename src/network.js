/**
 * network.js
 *
 * Peer-to-peer networking using Trystero with the BitTorrent DHT (torrent)
 * strategy — no signalling server; WebRTC DataChannels for transport.
 *
 * Under lockstep the gameplay surface is tiny: per-tick INPUT packets plus
 * the join bootstrap (snapshot request/response), the departure agreement,
 * and periodic state hashes. No game state ever crosses the wire.
 * Chat, player info (name/colour), latency pings, and voice streams remain
 * out-of-band — they are not simulation state.
 */
import { joinRoom, selfId } from 'trystero/torrent'

/** Public STUN servers used by WebRTC for NAT traversal and IPv6. */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

/**
 * TURN as a last resort: symmetric-NAT pairs can't be traversed with STUN
 * alone. The deployment mints short-lived credentials at /turn-creds
 * (a Pages Function); ICE only uses relay candidates when direct paths
 * fail, so this costs nothing for the common case. Local dev and failed
 * fetches degrade to STUN-only — exactly the old behaviour.
 */
let _turnServers = []
export async function fetchTurnServers(timeoutMs = 2500) {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch('/turn-creds', { signal: ctl.signal })
    clearTimeout(timer)
    if (!r.ok) return []
    const creds = await r.json()
    const servers = creds.iceServers ? [creds.iceServers] : []
    _turnServers = servers
    return servers
  } catch {
    return []
  }
}

/**
 * The protocol version is part of the app id, so peers on different builds
 * NEVER meet: a mixed-build crew would desync by construction (the sims
 * differ). Any change to sim/netcode behaviour must bump package.json's
 * version — that is the protocol epoch. __APP_VERSION__ is injected by Vite.
 */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
const APP_ID = `sea-of-friends-${APP_VERSION}`

/** Interval (ms) between latency pings sent to each peer. */
const PING_INTERVAL = 2000

export class NetworkManager {
  constructor(roomId = 'world-1') {
    this.peers = new Map() // peerId → {id, name, color, latency}
    this.selfId = selfId
    this.roomId = roomId
    this._localInfo = null
    this._pingTimestamps = new Map()

    // ── Callbacks ──────────────────────────────────────────────────────────
    this.onPeerJoin  = null
    this.onPeerLeave = null   // cosmetic (labels, chat)
    this.onPeerGone  = null   // lockstep departure protocol
    this.onPeerInfo  = null
    this.onChat      = null
    this.onPeerLatency = null
    // Lockstep
    this.onInput   = null     // (pid, packet)
    this.onSreq    = null     // (pid)
    this.onSnap    = null     // (pid, data)
    this.onJreq    = null     // (pid)
    this.onHashMsg = null     // (pid, {t, h, f})
    this.onLastIn  = null     // (pid, {p, l})
    this.onRelayIn = null     // (pid, {rows})
    this.onBye     = null     // (pid) — deliberate quit, skip parking grace

    // Peer discovery: our own always-up signaling relay (a Durable Object
    // speaking the WebTorrent tracker protocol) first, the public trackers
    // as fallback — they're the flakiest link in the stack. ?relays=…
    // overrides everything (tests, LAN crews).
    const DEFAULT_RELAYS = [
      'wss://sea-of-friends-signal.fluxoz.workers.dev',
      'wss://tracker.webtorrent.dev',
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.btorrent.xyz',
    ]
    const relays = typeof location !== 'undefined'
      ? new URLSearchParams(location.search).get('relays') : null
    const room = joinRoom(
      {
        appId: APP_ID,
        rtcConfig: { iceServers: [...ICE_SERVERS, ..._turnServers] },
        relayUrls: relays ? relays.split(',') : DEFAULT_RELAYS,
        relayRedundancy: 4,
      },
      roomId,
    )
    this._room = room

    const [sendInfo, onInfo]   = room.makeAction('i')
    const [sendChat, onChat]   = room.makeAction('c')
    const [sendPing, onPing]   = room.makeAction('pg')
    const [sendPong, onPong]   = room.makeAction('po')
    const [sendInput, onInput] = room.makeAction('in')
    const [sendSreq, onSreq]   = room.makeAction('sq')
    const [sendSnap, onSnap]   = room.makeAction('sn')
    const [sendJreq, onJreq]   = room.makeAction('jq')
    const [sendHash, onHash]   = room.makeAction('hs')
    const [sendLastIn, onLastIn]   = room.makeAction('li')
    const [sendRelayIn, onRelayIn] = room.makeAction('ri')
    const [sendBye, onBye]         = room.makeAction('by')

    this._sendInfo   = sendInfo
    this._sendChat   = sendChat

    // ── Fast input lane ────────────────────────────────────────────────────
    // Trystero's action channel is reliable-ordered: one lost packet blocks
    // everything behind it until retransmit — exactly the latency spike the
    // rollback layer then has to hide. Inputs instead ride a second,
    // UNRELIABLE unordered datachannel opened symmetrically on Trystero's
    // own RTCPeerConnection (negotiated:true + fixed id → no renegotiation).
    // Loss is covered by redundancy: every packet carries the last few
    // inputs, so a dropped datagram is filled by the next one. Packets that
    // carry roster commands — and any peer whose fast lane isn't open —
    // fall back to the reliable action channel.
    this._fast = new Map()   // pid → RTCDataChannel
    // Test hook: ?droppct=30 randomly discards inbound fast-lane datagrams
    this._dropPct = typeof location !== 'undefined'
      ? +(new URLSearchParams(location.search).get('droppct') || 0) : 0

    this._openFastLane = pid => {
      try {
        const pc = this._room.getPeers()[pid]
        if (!pc || this._fast.has(pid)) return
        const ch = pc.createDataChannel('fastin', {
          negotiated: true, id: 137, ordered: false, maxRetransmits: 0,
        })
        ch.onmessage = ev => {
          if (this.blackhole) return
          if (this._dropPct > 0 && Math.random() * 100 < this._dropPct) return
          try {
            const data = JSON.parse(ev.data)
            if (this.onInput) this.onInput(pid, data)
          } catch { /* malformed datagram — redundancy covers it */ }
        }
        ch.onerror = () => {}
        this._fast.set(pid, ch)
      } catch { /* no fast lane — reliable fallback covers this peer */ }
    }

    this.sendInput = data => {
      // Roster commands must never ride the lossy lane
      const reliableOnly = Array.isArray(data.c) && data.c.length > 0
      let json = null
      for (const pid of this.peers.keys()) {
        const ch = this._fast.get(pid)
        if (!reliableOnly && ch && ch.readyState === 'open') {
          try {
            ch.send(json ?? (json = JSON.stringify(data)))
            continue
          } catch { /* channel died mid-send — fall through to reliable */ }
        }
        sendInput(data, pid)
      }
    }
    this.sendSreq    = data => sendSreq(data)
    this.sendSnap    = (data, pid) => sendSnap(data, pid)
    this.sendJreq    = data => sendJreq(data)
    this.sendHashMsg = data => sendHash(data)
    this.sendLastIn  = data => sendLastIn(data)
    this.sendRelayIn = data => sendRelayIn(data)
    this.sendBye     = () => { try { sendBye({}) } catch { /* leaving anyway */ } }

    // ── Peer lifecycle ─────────────────────────────────────────────────────
    room.onPeerJoin(peerId => {
      this.peers.set(peerId, { id: peerId })
      this._openFastLane(peerId)
      if (this._localInfo) sendInfo(this._localInfo, peerId)
      if (this.onPeerJoin) this.onPeerJoin(peerId)
    })

    room.onPeerLeave(peerId => {
      this._pingTimestamps.delete(peerId)
      this.peers.delete(peerId)
      try { this._fast.get(peerId)?.close() } catch { /* already closed */ }
      this._fast.delete(peerId)
      if (this.onPeerGone) this.onPeerGone(peerId)
      if (this.onPeerLeave) this.onPeerLeave(peerId)
    })

    // ── Incoming ───────────────────────────────────────────────────────────
    onInfo((data, peerId) => {
      const peer = this.peers.get(peerId)
      if (peer) Object.assign(peer, data)
      if (this.onPeerInfo) this.onPeerInfo(peerId, data)
    })

    onChat((data, peerId) => { if (this.onChat) this.onChat(peerId, data) })

    // Test hook: `network.blackhole = true` drops all inbound game traffic
    // while the WebRTC connections stay up — a true network partition.
    onInput((data, peerId)   => { if (!this.blackhole && this.onInput)   this.onInput(peerId, data) })
    onSreq((_d, peerId)      => { if (!this.blackhole && this.onSreq)    this.onSreq(peerId) })
    onSnap((data, peerId)    => { if (!this.blackhole && this.onSnap)    this.onSnap(peerId, data) })
    onJreq((data, peerId)    => { if (!this.blackhole && this.onJreq)    this.onJreq(peerId, data) })
    onHash((data, peerId)    => { if (!this.blackhole && this.onHashMsg) this.onHashMsg(peerId, data) })
    onLastIn((data, peerId)  => { if (!this.blackhole && this.onLastIn)  this.onLastIn(peerId, data) })
    onRelayIn((data, peerId) => { if (!this.blackhole && this.onRelayIn) this.onRelayIn(peerId, data) })
    onBye((_d, peerId)       => { if (this.onBye) this.onBye(peerId) })

    // ── Latency ping / pong ────────────────────────────────────────────────
    onPing((_data, peerId) => { sendPong({}, peerId) })
    onPong((_data, peerId) => {
      const sent = this._pingTimestamps.get(peerId)
      if (sent === undefined) return
      const rtt = Math.round(performance.now() - sent)
      const peer = this.peers.get(peerId)
      if (peer) peer.latency = rtt
      if (this.onPeerLatency) this.onPeerLatency(peerId, rtt)
    })

    this._pingTimer = setInterval(() => {
      this.peers.forEach((_peer, peerId) => {
        this._pingTimestamps.set(peerId, performance.now())
        sendPing({}, peerId)
      })
    }, PING_INTERVAL)

    // ── Audio stream helpers (voice chat) ──────────────────────────────────
    this.addStream    = (stream, targets) => room.addStream(stream, targets)
    this.removeStream = (stream, targets) => room.removeStream(stream, targets)
    this.onStream     = cb              => room.onPeerStream(cb)
  }

  /** Announce our name & colour (cosmetic, out-of-band). */
  setLocalInfo(name, color) {
    this._localInfo = { ...this._localInfo, name, color }
    this._sendInfo(this._localInfo)
  }

  /**
   * Join/leave a crew voice channel. The channel name is a shared secret —
   * whoever announces the same name hears each other everywhere.
   * Pass '' (empty) to leave.
   */
  setVoiceChannel(vc) {
    this._localInfo = { ...this._localInfo, vc: vc || '' }
    this._sendInfo(this._localInfo)
  }

  getLocalVc() { return this._localInfo?.vc || null }

  sendChatMessage(text)  { this._sendChat({ t: text }) }
  sendEmoteMessage(action) { this._sendChat({ t: action, m: 'e' }) }

  /** Leave the room and stop all timers. The instance is dead afterwards. */
  leave() {
    clearInterval(this._pingTimer)
    try { this._room.leave() } catch {}
    this.peers.clear()
  }

  getPeer(peerId) { return this.peers.get(peerId) }
  getPeerIds()    { return [...this.peers.keys()] }
  getLocalColor() { return this._localInfo?.color ?? null }
  getLocalName()  { return this._localInfo?.name ?? null }
  getPeerCount()  { return this.peers.size + 1 }
}
