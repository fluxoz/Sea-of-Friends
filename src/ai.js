/**
 * ai.js – Ghost-ship AI enemies, fully deterministic under lockstep.
 *
 * There is no authority any more: EVERY peer simulates the whole fleet with
 * the same fixed timestep, the same dmath, and the same seeded RNG stream —
 * so the ghosts are bit-identical everywhere with zero network traffic.
 * Gameplay outcomes (sinkings, kill credit) are emitted as events for the
 * caller (sim.js) to turn into feed messages and treasure drops.
 */
import { Ship, NO_GO_ANGLE } from './ship.js'
import { waveHeight, WORLD_HALF } from './world.js'
import { BALL_SPEED, solveElevation } from './combat.js'
import { dsin, dcos, datan2, dhypot, wrapAngle, PI } from './dmath.js'

export const AI_COUNT   = 3
const AI_MAX_HP         = 50
const AI_SAIL_CAP       = 0.92    // ghosts never quite match a perfectly trimmed player
const AGGRO_RANGE       = 420
const FIRE_RANGE        = 110
const AI_RELOAD         = 4.5
const RESPAWN_DELAY     = 14
const AI_NAME           = 'Ghost Ship'

export function aiDisplayName(_id) { return AI_NAME }

export class AIFleet {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./world.js').World} world
   * @param {import('./combat.js').Combat} combat
   */
  constructor(scene, world, combat) {
    this.scene  = scene
    this.world  = world
    this.combat = combat
    /** @type {Array<{id:string, ship:Ship, wander:{x:number,z:number}|null, reload:number, respawnT:number, lastHitBy:string|null}>} */
    this.units = []
  }

  /** Create the fleet at seeded positions (called once when the sim starts). */
  init(rng) {
    this.clearUnits()
    for (let i = 0; i < AI_COUNT; i++) {
      const ship = new Ship(this.scene, AI_NAME, 0x88ffcc, false, {
        modelKey: 'ship-ghost',
        maxHp: AI_MAX_HP,
      })
      const spawn = this._pickSpawn(rng)
      ship.position.set(spawn.x, 0, spawn.z)
      ship.rotationY = rng.next() * PI * 2
      ship.capturePrev()
      this.units.push({
        id: `ai${i}`, ship,
        wander: null,
        reload: 3 + rng.next() * 3,
        respawnT: 0,
        lastHitBy: null,
      })
    }
  }

  clearUnits() {
    for (const u of this.units) u.ship.destroy()
    this.units = []
  }

  /** Random spot away from the centre spawn area and clear of islands. */
  _pickSpawn(rng) {
    const islands = this.world.getIslands()
    for (let tries = 0; tries < 20; tries++) {
      const a = rng.next() * PI * 2
      const d = 250 + rng.next() * 500
      const x = dcos(a) * d
      const z = dsin(a) * d
      if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) continue
      if (islands.every(isl => dhypot(x - isl.x, z - isl.z) > isl.r + 40)) {
        return { x, z }
      }
    }
    return { x: 400, z: 400 }
  }

  /** Targets for the combat system (alive ghost ships only). */
  getTargets() {
    return this.units
      .filter(u => !u.ship.sinking && u.ship.hp > 0)
      .map(u => ({ id: u.id, ship: u.ship, isAI: true }))
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIM: one fixed step for the whole fleet
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} dt  FIXED_DT
   * @param {Array<{id:string, pos:{x,z}, alive:boolean}>} players  sorted order
   * @param {{dir,speed}} wind
   * @param {number} simTime
   * @param {import('./dmath.js').DRng} rng
   * @param {(unit, balls) => void} onFire   sim spawns the volley
   * @returns {Array<{type:'aiSunk', unit, killer:string|null}>} events
   */
  simStep(dt, players, wind, simTime, rng, onFire) {
    const events = []
    const alivePlayers = players.filter(p => p.alive)
    const islands = this.world.getIslands()

    for (const u of this.units) {
      const ship = u.ship
      ship.capturePrev()

      // Leaks can finish a ghost ship off between broadsides
      if (ship.hp <= 0 && !ship.sinking) {
        this._sinkUnit(u, u.lastHitBy)
        events.push({ type: 'aiSunk', unit: u, killer: u.lastHitBy })
      }

      // ── Down / respawning ────────────────────────────────────────────────
      if (ship.hp <= 0) {
        ship.updateLocal(dt, 0, 0, null)    // advances the sinking animation
        u.respawnT -= dt
        if (u.respawnT <= 0) {
          const spawn = this._pickSpawn(rng)
          ship.respawnReset(spawn.x, spawn.z)
          ship.rotationY = rng.next() * PI * 2
          u.reload = 3
          u.lastHitBy = null
        }
        continue
      }

      // ── Pick a target ────────────────────────────────────────────────────
      const pos = ship.position
      let target = null
      let best   = AGGRO_RANGE
      for (const p of alivePlayers) {
        const d = dhypot(p.pos.x - pos.x, p.pos.z - pos.z)
        if (d < best) { best = d; target = p }
      }

      // ── Steering ─────────────────────────────────────────────────────────
      let desiredHeading
      let thrust = 1
      if (target) {
        const toTarget = datan2(target.pos.x - pos.x, target.pos.z - pos.z)
        if (best > 85) {
          desiredHeading = toTarget
        } else if (best < 35) {
          desiredHeading = toTarget + PI
          thrust = 0.8
        } else {
          const cw  = toTarget + PI / 2
          const ccw = toTarget - PI / 2
          desiredHeading = Math.abs(wrapAngle(cw - ship.rotationY)) < Math.abs(wrapAngle(ccw - ship.rotationY))
            ? cw : ccw
          thrust = 0.65
        }
      } else {
        if (!u.wander || dhypot(u.wander.x - pos.x, u.wander.z - pos.z) < 60) {
          u.wander = this._pickSpawn(rng)
        }
        desiredHeading = datan2(u.wander.x - pos.x, u.wander.z - pos.z)
        thrust = 0.55
      }

      // Respect the no-go zone: tack instead of pinching straight upwind
      if (wind) {
        const windFrom = wind.dir + PI
        const off = wrapAngle(desiredHeading - windFrom)
        const TACK = NO_GO_ANGLE + 0.22
        if (Math.abs(off) < TACK) {
          const cur = wrapAngle(ship.rotationY - windFrom)
          const sign = Math.abs(off) > 0.06 ? Math.sign(off) : (cur >= 0 ? 1 : -1)
          desiredHeading = windFrom + sign * TACK
        }
      }

      // Island avoidance: look ahead (scaled to speed) and veer off
      const lookahead = 45 + Math.abs(ship.speed) * 2.5
      const aheadX = pos.x + dsin(ship.rotationY) * lookahead
      const aheadZ = pos.z + dcos(ship.rotationY) * lookahead
      for (const isl of islands) {
        if (dhypot(aheadX - isl.x, aheadZ - isl.z) < isl.r + 18) {
          desiredHeading = datan2(pos.x - isl.x, pos.z - isl.z)
          thrust = 0.9
          break
        }
      }

      const dr = wrapAngle(desiredHeading - ship.rotationY)
      const turn = Math.max(-1, Math.min(1, dr * 2.2))

      const desiredSail = thrust * AI_SAIL_CAP
      const sailDelta   = Math.max(-1, Math.min(1, (desiredSail - ship.sail) * 4))
      ship.updateLocal(dt, sailDelta, turn, wind)
      ship.setWaveHeight(waveHeight(ship.position.x, ship.position.z, simTime))

      // ── Firing ───────────────────────────────────────────────────────────
      u.reload -= dt
      if (target && u.reload <= 0 && best < FIRE_RANGE) {
        const bearing = datan2(target.pos.x - pos.x, target.pos.z - pos.z) - ship.rotationY
        if (Math.abs(dcos(bearing)) < 0.5) {
          const side = dsin(bearing) > 0 ? 1 : -1
          const elevation = Math.max(0.03,
            solveElevation(BALL_SPEED, Math.max(8, best - 2), ship.deckHeight)
            + (rng.next() - 0.5) * 0.05)
          const balls = this.combat.computeBroadside(ship, side, {
            count: 2, jitterScale: 2.2, elevation,
          }, rng)
          ship.triggerRecoil(side)
          onFire(u, balls)
          u.reload = AI_RELOAD + rng.next() * 2
        }
      }
    }

    return events
  }

  /**
   * A cannonball struck a ghost ship (called from the sim's hit resolution).
   * @returns {{sunk:boolean}}
   */
  applyBallHit(aiId, ownerId, dmg, zone = 'hull') {
    const u = this.units.find(u => u.id === aiId)
    if (!u || u.ship.hp <= 0) return { sunk: false }
    u.lastHitBy = ownerId
    u.ship.damage(dmg)
    if (zone === 'waterline') u.ship.addLeak()
    if (zone === 'rigging')   u.ship.addRigDamage()
    if (u.ship.hp <= 0) {
      this._sinkUnit(u, ownerId)
      return { sunk: true, unit: u }
    }
    return { sunk: false }
  }

  _sinkUnit(u, _killerId) {
    u.ship.startSinking()
    u.respawnT = RESPAWN_DELAY
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Snapshot / hash (lockstep support)
  // ──────────────────────────────────────────────────────────────────────────

  save() {
    return this.units.map(u => ({
      x: u.ship.position.x, z: u.ship.position.z,
      r: u.ship.rotationY, sp: u.ship.speed, sl: u.ship.sail,
      hp: u.ship.hp, sk: u.ship.sinking ? u.ship._sinkT : -1,
      st: u.ship._statusT,
      // COPIES, never references: rollback retains this snapshot while the
      // live sim keeps mutating — aliased arrays here corrupted ghost leak
      // state on every rollback and desynced the fleet across peers
      lk: u.ship._leaks.slice(), rg: u.ship._rigDmg.slice(),
      wd: u.wander ? { x: u.wander.x, z: u.wander.z } : null,
      rl: u.reload, rt: u.respawnT, lh: u.lastHitBy,
    }))
  }

  load(rows) {
    rows.forEach((r, i) => {
      const u = this.units[i]
      if (!u) return
      const s = u.ship
      s.position.set(r.x, 0, r.z)
      s.rotationY = r.r
      s.speed = r.sp
      s.sail  = r.sl
      s.hp    = r.hp
      s._statusT = r.st
      s._leaks  = (r.lk ?? []).slice()
      s._rigDmg = (r.rg ?? []).slice()
      if (r.sk >= 0) { s.sinking = true; s._sinkT = r.sk; s._hpSprite.visible = false }
      else { s.sinking = false; s._sinkT = 0; s.group.visible = true }
      s.capturePrev()
      s._redrawHealthBar()
      u.wander = r.wd ? { x: r.wd.x, z: r.wd.z } : null
      u.reload = r.rl
      u.respawnT = r.rt
      u.lastHitBy = r.lh
    })
  }

  hash(acc) {
    for (const u of this.units) {
      acc.num(u.ship.position.x).num(u.ship.position.z)
         .num(u.ship.rotationY).num(u.ship.hp).num(u.reload)
    }
  }
}
