/**
 * sim.js – The deterministic world simulation for lockstep multiplayer.
 *
 * Every peer runs this state machine with identical inputs and gets
 * bit-identical state: player ships, ghost fleet, forts, power-ups, treasure,
 * cannonballs, gold, kills. There is no authority and no state sync — only
 * inputs travel the network (see lockstep.js). A tampered client simply
 * diverges from everyone else's state hash within seconds.
 *
 * Rules for code in this file and everything it calls during step():
 *   • fixed timestep only (FIXED_DT), never wall clock
 *   • dmath / DRng only — no Math.sin/cos/atan2/random/hypot
 *   • iterate players in sorted id order
 */
import * as THREE from 'three'
import { Ship } from './ship.js'
import { waveHeight, getWind } from './world.js'
import { BALL_DAMAGE, BALL_SPEED, BALL_GRAVITY, RELOAD_TIME, MAX_ELEVATION, MIN_ELEVATION, MAX_TRAVERSE, BOW_TRAVERSE } from './combat.js'
import { aiDisplayName } from './ai.js'
import { POWERUP_TYPES } from './powerups.js'
import { DRng, HashAcc, dhypot, dcos, dsin, wrapAngle, hash32, PI } from './dmath.js'

export const TICK_RATE = 20
export const FIXED_DT  = 1 / TICK_RATE
export const TICK_MS   = 1000 / TICK_RATE

const RESPAWN_SECS   = 7
const INVULN_SECS    = 3
const GOLD_GHOST     = 100
const GOLD_BOUNTY    = 25

export class Sim {
  /**
   * @param {object} deps  {scene, world, combat, aiFleet, forts, powerups, sfx}
   * @param {object} hooks
   * @param {string}                 hooks.selfId
   * @param {(text:string) => void}  hooks.feed
   * @param {(id:string) => string}  hooks.resolveName
   * @param {(ev:object) => void}    hooks.onLocal   local-player UI events
   */
  constructor(deps, hooks) {
    Object.assign(this, deps)   // scene, world, combat, aiFleet, forts, powerups, sfx
    this.hooks = hooks

    this.seed      = 0
    this.foundedAt = 0
    this.tick      = 0
    this.rng       = new DRng(1)
    /** @type {Map<string, object>} pid → player record */
    this.players   = new Map()
    this._windOff  = 0
    this.wind      = { dir: 0, speed: 19 }
  }

  simTime() { return this.tick * FIXED_DT }

  /** Start a brand-new world (this peer is the founder). */
  found(seed, foundedAt) {
    this.seed      = seed >>> 0
    this.foundedAt = foundedAt
    this.tick      = 0
    this.rng       = new DRng(this.seed ^ 0x51ab7e3d)
    this._windOff  = (this.seed % 100000)
    this.world.buildIslands(this.seed)
    this.forts.generate(this.seed)
    this.powerups.clearAll()
    this.aiFleet.init(this.rng)
    this.players.clear()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Roster
  // ──────────────────────────────────────────────────────────────────────────

  sortedIds() { return [...this.players.keys()].sort() }

  addPlayer(pid, cls = 'frigate') {
    if (this.players.has(pid)) return
    const spawn = this._pickSpawn()
    const ship = new Ship(this.scene, pid.slice(0, 8), 0xc8a96e,
      pid === this.hooks.selfId, { shipClass: cls })
    ship.position.set(spawn.x, 0, spawn.z)
    ship.rotationY = this.rng.next() * PI * 2
    ship.capturePrev()
    if (pid === this.hooks.selfId) ship.setHealthBarVisible(false)
    this.players.set(pid, {
      id: pid, ship, cls,
      reloadP: 0, reloadS: 0, reloadB: 0,
      reloadMaxP: RELOAD_TIME, reloadMaxS: RELOAD_TIME, reloadMaxB: RELOAD_TIME,
      buffReload: 0, buffArmor: 0, ammoShots: 0, autoShots: 0,
      gold: 0, k: 0, d: 0,
      rudder: 0, heldHeading: null,
      respawnT: -1, invulnT: 0, lastAttacker: null, lastThud: -10,
    })
    this.hooks.feed(`⚓ ${this.hooks.resolveName(pid)} joined the crew`)
  }

  removePlayer(pid) {
    const p = this.players.get(pid)
    if (!p) return
    // Their purse goes overboard where they were
    if (p.gold > 0 && !p.ship.sinking) {
      this.powerups.dropGold(p.ship.position.x, p.ship.position.z, p.gold)
      this.hooks.feed(`🪙 ${this.hooks.resolveName(pid)}'s purse (${p.gold} gold) drifts on the tide…`)
    }
    p.ship.destroy()
    this.players.delete(pid)
    this.hooks.feed(`⚓ ${this.hooks.resolveName(pid)} left the crew`)
  }

  _pickSpawn() {
    const islands = this.world.getIslands()
    for (let tries = 0; tries < 20; tries++) {
      const a = this.rng.next() * PI * 2
      const d = 150 + this.rng.next() * 350
      const x = dcos(a) * d
      const z = dsin(a) * d
      if (islands.every(isl => dhypot(x - isl.x, z - isl.z) > isl.r + 40)) return { x, z }
    }
    return { x: 0, z: 0 }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // One deterministic tick
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} tick
   * @param {Map<string, object>} inputs  pid → input for this tick
   * @param {Array<object>} cmds  roster commands carried in the orderer's input
   */
  step(tick, inputs, cmds) {
    this.tick = tick
    const simTime = this.simTime()
    this.wind = getWind(this._windOff + simTime)

    // Roster changes ride inside the input stream → same tick on every peer
    for (const cmd of cmds) {
      if (cmd.j) this.addPlayer(cmd.j, cmd.c)
      if (cmd.d) this.removePlayer(cmd.d)
    }

    const listener = this._listenerPos()
    const sorted = this.sortedIds()

    // ── Players ────────────────────────────────────────────────────────────
    for (const pid of sorted) {
      const p = this.players.get(pid)
      const ship = p.ship
      const inp = inputs.get(pid) ?? {}
      ship.capturePrev()

      if (ship.sinking) {
        ship.updateLocal(FIXED_DT, 0, 0, null)
        p.respawnT -= FIXED_DT
        if (p.respawnT <= 0) {
          const spawn = this._pickSpawn()
          ship.respawnReset(spawn.x, spawn.z)
          ship.rotationY = this.rng.next() * PI * 2
          p.reloadP = 0; p.reloadS = 0
          p.invulnT = INVULN_SECS
          p.respawnT = -1
          if (pid === this.hooks.selfId) this.hooks.onLocal({ type: 'respawn' })
        }
        continue
      }

      // Input packet fields: s=sail trim, n=wheel crank, z=centre wheel,
      // r=reverse, p/q/b=fire port/starboard/bow, e/v=aim elevation/windage
      // ×1000. (t is the tick number.)
      const sd = Math.max(-1, Math.min(1, inp.s | 0))
      const tn = Math.max(-1, Math.min(1, inp.n | 0))

      // ── Helm (Sea-of-Thieves style) ────────────────────────────────────
      // A/D crank the wheel and it STAYS where you set it; holding both
      // recentres it. With the wheel centred, the helmsman holds the current
      // heading — imperfectly, wandering a little with wind and waves.
      if (inp.z) {
        const step = Math.min(Math.abs(p.rudder), 3.0 * FIXED_DT)
        p.rudder += p.rudder > 0 ? -step : step
      } else if (tn !== 0) {
        p.rudder = Math.max(-1, Math.min(1, p.rudder + tn * 1.6 * FIXED_DT))
      }

      let turn
      if (Math.abs(p.rudder) > 0.06) {
        turn = p.rudder
        p.heldHeading = null
      } else {
        if (p.heldHeading === null) p.heldHeading = ship.rotationY
        const wander = 0.05 * (this.wind.speed / 27)
          * dsin(simTime * 0.13 + (hash32(pid) % 628) * 0.01)
        const err = wrapAngle(p.heldHeading + wander - ship.rotationY)
        turn = Math.max(-0.3, Math.min(0.3, err * 2))
      }

      ship.updateLocal(FIXED_DT, sd, turn, this.wind, !!inp.r)
      this._collideIslands(p)
      ship.setWaveHeight(waveHeight(ship.position.x, ship.position.z, simTime))

      p.reloadP    = Math.max(0, p.reloadP - FIXED_DT)
      p.reloadS    = Math.max(0, p.reloadS - FIXED_DT)
      p.reloadB    = Math.max(0, p.reloadB - FIXED_DT)
      p.buffReload = Math.max(0, p.buffReload - FIXED_DT)
      p.buffArmor  = Math.max(0, p.buffArmor - FIXED_DT)
      p.invulnT    = Math.max(0, p.invulnT - FIXED_DT)

      let fired = false
      if (inp.p) fired = this._fire(p, 1, inp, listener) || fired
      if (inp.q) fired = this._fire(p, -1, inp, listener) || fired
      if (inp.b) fired = this._fire(p, 'bow', inp, listener) || fired
      // Master gunner: every real volley adds one perfectly solved shot
      if (fired && p.autoShots > 0) this._fireAutoAim(p, listener)

      // Leaks can finish a ship off without another shot landing
      if (ship.hp <= 0) this._sinkPlayer(p, p.lastAttacker)
    }

    const playerViews = sorted.map(pid => {
      const p = this.players.get(pid)
      return { id: pid, ship: p.ship, pos: p.ship.position, alive: !p.ship.sinking && p.ship.hp > 0 }
    })

    // ── AI fleet ───────────────────────────────────────────────────────────
    const aiEvents = this.aiFleet.simStep(
      FIXED_DT, playerViews, this.wind, simTime, this.rng,
      (unit, balls) => this.combat.spawnBroadside(balls, unit.id, 1, listener),
    )
    for (const ev of aiEvents) this._onAiSunk(ev.unit, ev.killer, listener)

    // ── Forts ──────────────────────────────────────────────────────────────
    this.forts.simStep(FIXED_DT, playerViews, this.rng, (fort, balls) => {
      this.combat.spawnBroadside(balls, fort.id, 1, listener, 'bolt')
    })

    // ── Power-ups & treasure ───────────────────────────────────────────────
    const puEvents = this.powerups.simStep(FIXED_DT, playerViews, this.rng)
    for (const ev of puEvents) this._applyPickup(ev)

    // ── Cannonballs ────────────────────────────────────────────────────────
    const targets = [
      ...playerViews.filter(v => v.alive).map(v => ({ id: v.id, ship: v.ship, isPlayer: true })),
      ...this.aiFleet.getTargets(),
      ...this.forts.targets(),
    ]
    this.combat.simStep(FIXED_DT, simTime, targets, this.world.getIslands(),
      (target, ball, point) => this._onBallHit(target, ball, point, listener), listener)
  }

  _listenerPos() {
    const me = this.players.get(this.hooks.selfId)
    return me ? me.ship.position : null
  }

  _collideIslands(p) {
    const ship = p.ship
    const pos = ship.position
    for (const isl of this.world.getIslands()) {
      const dx = pos.x - isl.x
      const dz = pos.z - isl.z
      const d  = dhypot(dx, dz)
      const minD = isl.r + 5
      if (d < minD) {
        const inv = 1 / (d || 1)
        pos.x = isl.x + dx * inv * minD
        pos.z = isl.z + dz * inv * minD
        if (Math.abs(ship.speed) > 3 && this.simTime() - p.lastThud > 0.9) {
          p.lastThud = this.simTime()
          if (p.id === this.hooks.selfId) this.sfx.thud(0)
        }
        ship.speed *= 0.85
      }
    }
  }

  _fire(p, side, inp, listener) {
    const isBow  = side === 'bow'
    if (isBow && !(p.ship.bowGuns > 0)) return false
    const loaded = isBow ? p.reloadB <= 0 : (side === 1 ? p.reloadP <= 0 : p.reloadS <= 0)
    if (!loaded || p.ship.sinking) return false

    const reloadTime = p.buffReload > 0 ? RELOAD_TIME * 0.5 : RELOAD_TIME
    if (isBow)           { p.reloadB = reloadTime; p.reloadMaxB = reloadTime }
    else if (side === 1) { p.reloadP = reloadTime; p.reloadMaxP = reloadTime }
    else                 { p.reloadS = reloadTime; p.reloadMaxS = reloadTime }
    p.invulnT = 0   // firing forfeits spawn protection

    const opts = {}
    if (typeof inp.e === 'number') {
      opts.elevation = Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, inp.e / 1000))
    }
    if (typeof inp.v === 'number') {
      const maxT = isBow ? BOW_TRAVERSE : MAX_TRAVERSE
      opts.traverse = Math.max(-maxT, Math.min(maxT, inp.v / 1000))
    }
    let dmgMul = 1
    if (p.ammoShots > 0) {
      p.ammoShots--
      opts.speedMul = 1.35
      dmgMul = 1.5
    }

    const balls = isBow
      ? this.combat.computeBow(p.ship, opts, this.rng)
      : this.combat.computeBroadside(p.ship, side, opts, this.rng)
    this.combat.spawnBroadside(balls, p.id, dmgMul, listener)
    p.ship.triggerRecoil(side)
    return true
  }

  /**
   * Master gunner (🎯): one shot solved EXACTLY from both vectors at the
   * moment of firing — the shooter's velocity (which the ball inherits) and
   * the target's course and speed. Deterministic closed-form intercept:
   * horizontal quadratic for time-to-impact, exact vertical drop solution,
   * iterated so muzzle speed splits consistently between the two.
   */
  _fireAutoAim(p, listener) {
    const ship = p.ship
    const M = {
      x: ship.position.x,
      y: ship.position.y + ship.deckHeight + 1,
      z: ship.position.z,
    }
    const vs = { x: dsin(ship.rotationY) * ship.speed, z: dcos(ship.rotationY) * ship.speed }

    // Nearest enemy in practical range: other captains, then ghost ships
    let tShip = null, best = 190
    for (const pid of this.sortedIds()) {
      if (pid === p.id) continue
      const q = this.players.get(pid)
      if (q.ship.sinking || q.ship.hp <= 0 || q.invulnT > 0) continue
      const d = dhypot(q.ship.position.x - M.x, q.ship.position.z - M.z)
      if (d < best) { best = d; tShip = q.ship }
    }
    for (const u of this.aiFleet.units) {
      if (u.ship.sinking || u.ship.hp <= 0) continue
      const d = dhypot(u.ship.position.x - M.x, u.ship.position.z - M.z)
      if (d < best) { best = d; tShip = u.ship }
    }
    if (!tShip) return

    const ve = { x: dsin(tShip.rotationY) * tShip.speed, z: dcos(tShip.rotationY) * tShip.speed }
    const D  = { x: tShip.position.x - M.x, z: tShip.position.z - M.z }
    const Vr = { x: ve.x - vs.x, z: ve.z - vs.z }
    const dy = (tShip.position.y + 2.2) - M.y
    const s  = BALL_SPEED

    let sh = s * 0.99, t = 0, vy = 0
    for (let i = 0; i < 4; i++) {
      const a = Vr.x * Vr.x + Vr.z * Vr.z - sh * sh
      const b = 2 * (D.x * Vr.x + D.z * Vr.z)
      const c = D.x * D.x + D.z * D.z
      let tt
      if (Math.abs(a) < 1e-9) {
        if (b >= 0) return
        tt = -c / b
      } else {
        const disc = b * b - 4 * a * c
        if (disc < 0) return
        const sq = Math.sqrt(disc)
        const cand = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].filter(v => v > 0.05)
        if (!cand.length) return
        tt = Math.min(...cand)
      }
      if (!(tt > 0) || tt > 4.5) return
      t = tt
      vy = (dy + BALL_GRAVITY * t * t / 2) / t
      const sh2 = s * s - vy * vy
      if (sh2 <= (0.3 * s) * (0.3 * s)) return   // would need an absurd loft
      sh = Math.sqrt(sh2)
    }

    const ix = D.x + Vr.x * t, iz = D.z + Vr.z * t
    const inv = 1 / (dhypot(ix, iz) || 1)
    this.combat.spawnBroadside([[
      M.x, M.y, M.z,
      ix * inv * sh + vs.x,
      vy,
      iz * inv * sh + vs.z,
    ]], p.id, 1, listener)
    p.autoShots--
  }

  _onBallHit(target, ball, point, listener) {
    const zone = target.ship.hitZone(point)
    let dmg = (BALL_DAMAGE + this.rng.int(5)) * (ball.dmgMul || 1)
    if (zone === 'rigging')   dmg *= 0.55
    if (zone === 'waterline') dmg *= 0.8
    dmg = Math.max(1, Math.round(dmg))

    if (target.isPlayer) {
      const p = this.players.get(target.id)
      if (!p || p.invulnT > 0 || p.ship.sinking) return
      if (p.buffArmor > 0) dmg = Math.max(1, Math.round(dmg * 0.5))
      p.lastAttacker = ball.owner
      p.ship.damage(dmg)
      if (zone === 'waterline') p.ship.addLeak()
      if (zone === 'rigging')   p.ship.addRigDamage()
      // A ballista bolt tears through the works and fouls the rigging
      // wherever it lands
      if (ball.kind === 'bolt' && zone !== 'rigging') p.ship.addRigDamage()
      if (p.id === this.hooks.selfId) {
        this.hooks.onLocal({ type: 'hit', zone, bolt: ball.kind === 'bolt' })
      }
      if (p.ship.hp <= 0) this._sinkPlayer(p, ball.owner)
    } else if (target.isAI) {
      const r = this.aiFleet.applyBallHit(target.id, ball.owner, dmg, zone)
      if (r.sunk) this._onAiSunk(r.unit, ball.owner, listener)
    } else if (target.isFort) {
      const r = this.forts.applyBallHit(target.id, ball.owner, dmg)
      if (r.cracked) {
        const fort = r.fort
        const pos = new THREE.Vector3(fort.x, fort.baseY + 6, fort.z)
        const dist = listener ? dhypot(pos.x - listener.x, pos.z - listener.z) : 0
        this.combat.shipExplosion(pos, dist)
        this.powerups.dropGold(fort.lootX, fort.lootZ, fort.gold)
        this.hooks.feed(`🏰 ${this.hooks.resolveName(ball.owner)} cracked a fort — `
          + `its strongbox (${fort.gold} gold) washes into the shallows!`)
      }
    }
  }

  _sinkPlayer(p, killerId) {
    if (p.ship.sinking) return
    p.ship.startSinking()
    p.d++
    p.respawnT = RESPAWN_SECS

    const pos = p.ship.position
    const listener = this._listenerPos()
    const dist = listener ? dhypot(pos.x - listener.x, pos.z - listener.z) : 0
    this.combat.shipExplosion(new THREE.Vector3(pos.x, pos.y + 2, pos.z), dist)

    // The purse goes overboard as a chest — anyone can race for it
    if (p.gold > 0) {
      this.powerups.dropGold(pos.x, pos.z, p.gold)
      this.hooks.feed(`🪙 ${this.hooks.resolveName(p.id)}'s purse (${p.gold} gold) went overboard!`)
      p.gold = 0
    }

    // Kill credit + bounty for a player killer
    const killer = this.players.get(killerId)
    if (killer && killerId !== p.id) {
      killer.k++
      killer.gold += GOLD_BOUNTY
    }
    this.hooks.feed(`⚔ ${this.hooks.resolveName(killerId)} sank ${this.hooks.resolveName(p.id)}!`)

    if (p.id === this.hooks.selfId) {
      this.hooks.onLocal({ type: 'sunk', killer: killerId })
    }
  }

  _onAiSunk(unit, killerId, listener) {
    const pos = unit.ship.position
    const dist = listener ? dhypot(pos.x - listener.x, pos.z - listener.z) : 0
    this.combat.shipExplosion(new THREE.Vector3(pos.x, pos.y + 2, pos.z), dist)
    const killer = this.players.get(killerId)
    if (killer) killer.k++
    this.powerups.dropGold(pos.x, pos.z, GOLD_GHOST)
    this.hooks.feed(`☠ ${this.hooks.resolveName(killerId)} sank a ${aiDisplayName(unit.id)} — `
      + `its plunder (${GOLD_GHOST} gold) floats amid the wreckage!`)
  }

  _applyPickup(ev) {
    const p = this.players.get(ev.pid)
    if (!p) return
    const isMe = ev.pid === this.hooks.selfId
    const info = POWERUP_TYPES[ev.ptype]
    switch (ev.ptype) {
      case 'gold':
        p.gold += ev.amount
        if (isMe) { this.sfx.coins(); this.hooks.feed(`${info.icon} Hauled a chest aboard — ${ev.amount} gold!`) }
        else this.hooks.feed(`${info.icon} ${this.hooks.resolveName(ev.pid)} hauled a chest aboard (${ev.amount} gold)`)
        return
      case 'health': {
        const healed = Math.min(p.ship.maxHp - p.ship.hp, 35)
        p.ship.hp = Math.min(p.ship.maxHp, p.ship.hp + 35)
        p.ship.clearStatusEffects()
        p.ship._redrawHealthBar()
        if (isMe) this.hooks.feed(`${info.icon} Hull repairs — +${Math.round(healed)} hull, leaks plugged`)
        break
      }
      case 'reload':
        p.buffReload += 30
        if (isMe) this.hooks.feed(`${info.icon} Gun crews inspired — half reload for 30s`)
        break
      case 'armor':
        p.buffArmor += 30
        if (isMe) this.hooks.feed(`${info.icon} Armor plating — half damage taken for 30s`)
        break
      case 'ammo':
        p.ammoShots += 3
        if (isMe) this.hooks.feed(`${info.icon} Chain shot loaded — next 3 broadsides fly faster, farther, harder`)
        break
      case 'autoaim':
        p.autoShots += 2
        if (isMe) this.hooks.feed(`${info.icon} Master gunner aboard — your next 2 volleys add one perfectly aimed shot`)
        break
    }
    if (isMe) this.sfx.powerup()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Snapshot / restore / hash
  // ──────────────────────────────────────────────────────────────────────────

  snapshot() {
    const players = []
    for (const pid of this.sortedIds()) {
      const p = this.players.get(pid)
      const s = p.ship
      players.push({
        id: pid, cls: p.cls, x: s.position.x, z: s.position.z, r: s.rotationY,
        sp: s.speed, sl: s.sail, hp: s.hp,
        sk: s.sinking ? s._sinkT : -1, st: s._statusT,
        lk: s._leaks.slice(), rg: s._rigDmg.slice(),
        rp: p.reloadP, rs: p.reloadS, rb: p.reloadB,
        br: p.buffReload, ba: p.buffArmor,
        am: p.ammoShots, aa: p.autoShots, g: p.gold, k: p.k, d: p.d,
        rd: p.rudder, hh: p.heldHeading,
        rt: p.respawnT, iv: p.invulnT, la: p.lastAttacker,
      })
    }
    return {
      seed: this.seed, foundedAt: this.foundedAt, tick: this.tick,
      rng: this.rng.save(),
      players,
      ai: this.aiFleet.save(),
      forts: this.forts.save(),
      pu: this.powerups.save(),
      balls: this.combat.saveBalls(),
    }
  }

  /**
   * Rollback restore: same world, same roster — assign values in place, no
   * object churn. Runs many times a second while remote inputs are late, so
   * it must never rebuild terrain or recreate ships. Falls back to the full
   * restore when the assumption doesn't hold (defensive; the lockstep layer
   * only rolls back within a prediction window where the roster is frozen).
   */
  restoreFast(snap) {
    if ((snap.seed >>> 0) !== this.seed
        || snap.players.length !== this.players.size
        || !snap.players.every(r => this.players.has(r.id))) {
      return this.restore(snap)
    }
    this.tick = snap.tick
    this.rng.load(snap.rng)
    this.aiFleet.load(snap.ai)
    this.forts.load(snap.forts)
    this.powerups.load(snap.pu)
    this.combat.loadBalls(snap.balls)
    for (const row of snap.players) {
      const p = this.players.get(row.id)
      const s = p.ship
      s.position.set(row.x, 0, row.z)
      s.rotationY = row.r
      s.speed = row.sp
      s.sail  = row.sl
      const hpChanged = s.hp !== row.hp
      s.hp = row.hp
      s._statusT = row.st
      s._leaks  = (row.lk ?? []).slice()
      s._rigDmg = (row.rg ?? []).slice()
      if (row.sk >= 0) {
        s.sinking = true
        s._sinkT = row.sk
        s._hpSprite.visible = false
      } else if (s.sinking) {
        // Mispredicted sinking — surface the ship again
        s.sinking = false
        s._sinkT = 0
        s.group.visible = true
        if (row.id !== this.hooks.selfId) s._hpSprite.visible = true
      }
      if (hpChanged) s._redrawHealthBar()
      p.reloadP = row.rp; p.reloadS = row.rs; p.reloadB = row.rb ?? 0
      p.buffReload = row.br; p.buffArmor = row.ba
      p.ammoShots = row.am; p.autoShots = row.aa ?? 0
      p.gold = row.g; p.k = row.k; p.d = row.d
      p.rudder = row.rd ?? 0; p.heldHeading = row.hh ?? null
      p.respawnT = row.rt; p.invulnT = row.iv; p.lastAttacker = row.la
    }
  }

  restore(snap) {
    this.seed      = snap.seed >>> 0
    this.foundedAt = snap.foundedAt
    this.tick      = snap.tick
    this._windOff  = (this.seed % 100000)
    this.world.buildIslands(this.seed)
    this.forts.generate(this.seed)
    // Init the fleet with a throwaway rng (positions are overwritten by load),
    // THEN restore the real stream so no draws are lost or added.
    this.aiFleet.init(new DRng(this.seed))
    this.rng.load(snap.rng)
    this.aiFleet.load(snap.ai)
    this.forts.load(snap.forts)
    this.powerups.load(snap.pu)
    this.combat.loadBalls(snap.balls)

    for (const p of [...this.players.values()]) p.ship.destroy()
    this.players.clear()
    for (const row of snap.players) {
      const ship = new Ship(this.scene, row.id.slice(0, 8), 0xc8a96e,
        row.id === this.hooks.selfId, { shipClass: row.cls ?? 'frigate' })
      ship.position.set(row.x, 0, row.z)
      ship.rotationY = row.r
      ship.speed = row.sp
      ship.sail  = row.sl
      ship.hp    = row.hp
      ship._statusT = row.st
      ship._leaks  = (row.lk ?? []).slice()
      ship._rigDmg = (row.rg ?? []).slice()
      if (row.sk >= 0) { ship.sinking = true; ship._sinkT = row.sk; ship._hpSprite.visible = false }
      ship.capturePrev()
      ship._redrawHealthBar()
      if (row.id === this.hooks.selfId) ship.setHealthBarVisible(false)
      this.players.set(row.id, {
        id: row.id, ship, cls: row.cls ?? 'frigate',
        reloadP: row.rp, reloadS: row.rs, reloadB: row.rb ?? 0,
        reloadMaxP: RELOAD_TIME, reloadMaxS: RELOAD_TIME, reloadMaxB: RELOAD_TIME,
        buffReload: row.br, buffArmor: row.ba, ammoShots: row.am, autoShots: row.aa ?? 0,
        gold: row.g, k: row.k, d: row.d,
        rudder: row.rd ?? 0, heldHeading: row.hh ?? null,
        respawnT: row.rt, invulnT: row.iv, lastAttacker: row.la, lastThud: -10,
      })
    }
  }

  /**
   * State hash, computed per-subsystem so a mismatch NAMES the diverged
   * system (players / AI / forts / power-ups / balls) instead of just
   * screaming. Parts land in this.lastHashParts; the returned value combines
   * them.
   */
  hash() {
    const pl = new HashAcc()
    pl.int(this.tick).int(this.rng.save())
    for (const pid of this.sortedIds()) {
      const p = this.players.get(pid)
      const s = p.ship
      pl.str(pid).num(s.position.x).num(s.position.z).num(s.rotationY)
        .num(s.hp).num(s.sail).num(s.speed)
        .int(p.gold).int(p.k).int(p.d).int(p.ammoShots).int(p.autoShots)
        .num(p.reloadP).num(p.reloadS).num(p.reloadB)
        .num(p.rudder).num(p.heldHeading ?? 0).int(p.heldHeading === null ? 1 : 0)
    }
    const ai = new HashAcc(); this.aiFleet.hash(ai)
    const ft = new HashAcc(); this.forts.hash(ft)
    const pu = new HashAcc(); this.powerups.hash(pu)
    const ba = new HashAcc(); this.combat.ballHash(ba)
    this.lastHashParts = {
      players: pl.value(), ai: ai.value(), forts: ft.value(),
      powerups: pu.value(), balls: ba.value(),
    }
    const acc = new HashAcc()
    for (const v of Object.values(this.lastHashParts)) acc.int(v)
    return acc.value()
  }
}
