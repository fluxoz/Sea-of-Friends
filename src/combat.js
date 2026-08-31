/**
 * combat.js – Cannonballs, broadside firing, particle effects, hit detection.
 *
 * Under lockstep everything that affects the outcome is deterministic:
 *   • Ball positions/velocities are plain numbers advanced only in simStep()
 *     with the fixed timestep and dmath.
 *   • All randomness (spread, jitter) comes from the sim's seeded RNG stream,
 *     passed in by the caller.
 *   • Meshes, particles, and audio are render-side; renderStep() interpolates
 *     ball meshes between the last two sim ticks.
 */
import * as THREE from 'three'
import { waveHeight } from './world.js'
import { dsin, dcos, dhypot } from './dmath.js'

// ── Ballistics tuning ─────────────────────────────────────────────────────────
export const BALL_SPEED      = 65     // muzzle velocity (world units / s)
export const BALL_GRAVITY    = 22
export const BALL_DAMAGE     = 12     // per ball; a full 3-ball broadside ≈ 36
export const RELOAD_TIME     = 3.0    // seconds per side
export const BROADSIDE_BALLS = 3
const BALL_TTL     = 6                // safety despawn (s)
const BALL_RADIUS  = 0.45

/** Default barrel elevation (radians) for un-aimed quick broadsides. */
export const DEFAULT_ELEVATION = 0.16
/** Highest the barrels can be aimed (radians). Range ≈ 170 world units. */
export const MAX_ELEVATION     = 0.55
/** Lowest aimed elevation. */
export const MIN_ELEVATION     = 0.03
/** How far a broadside can be traversed off the perpendicular (radians).
 *  ±57°: from near the bow to well aft — only a cone dead astern is blind. */
export const MAX_TRAVERSE      = 1.0
/** Bow chasers' traverse either side of dead ahead (radians). */
export const BOW_TRAVERSE      = 0.62

/** Ballista bolts fly faster and flatter than round shot. */
export const BOLT_SPEED = 88

/**
 * Elevation that lands a shot `dist` away when fired from `height` above the
 * water at muzzle speed `v`. Bisection over the height-aware range formula —
 * deterministic (sqrt/dsin/dcos only). The flat-ground closed form overshoots
 * badly from fort towers.
 */
export function solveElevation(v, dist, height) {
  const g = BALL_GRAVITY
  const rangeAt = e => {
    const vy = v * dsin(e), vh = v * dcos(e)
    return (vh / g) * (vy + Math.sqrt(vy * vy + 2 * g * Math.max(0, height)))
  }
  let lo = 0.005, hi = 0.6
  if (rangeAt(hi) < dist) return hi     // out of reach — loft as far as we can
  if (rangeAt(lo) > dist) return lo     // practically point blank
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (rangeAt(mid) < dist) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// ── Shared GPU resources ──────────────────────────────────────────────────────
const _ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 8, 6)
const _ballMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, metalness: 0.4 })
const _boltShaftGeo = new THREE.CylinderGeometry(0.14, 0.14, 3.4, 6)
const _boltTipGeo   = new THREE.ConeGeometry(0.3, 0.9, 6)
const _boltFinGeo   = new THREE.BoxGeometry(0.06, 0.5, 0.7)
const _boltWoodMat  = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 })
const _boltIronMat  = new THREE.MeshStandardMaterial({ color: 0x44484c, roughness: 0.5, metalness: 0.6 })

/** A big ballista arrow, modelled along +Z so it can be aimed with lookAt. */
function makeBoltMesh() {
  const g = new THREE.Group()
  const shaft = new THREE.Mesh(_boltShaftGeo, _boltWoodMat)
  shaft.rotation.x = Math.PI / 2
  g.add(shaft)
  const tip = new THREE.Mesh(_boltTipGeo, _boltIronMat)
  tip.rotation.x = Math.PI / 2
  tip.position.z = 2.0
  g.add(tip)
  for (const a of [0, Math.PI / 2]) {
    const fin = new THREE.Mesh(_boltFinGeo, _boltIronMat)
    fin.position.z = -1.5
    fin.rotation.z = a
    g.add(fin)
  }
  return g
}

/** Soft radial-gradient texture shared by all particles (tinted per-sprite). */
let _softTex = null
export function getSoftTexture() {
  if (_softTex) return _softTex
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  _softTex = new THREE.CanvasTexture(c)
  return _softTex
}

export class Combat {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./sfx.js').SFX} sfx
   */
  constructor(scene, sfx) {
    this.scene = scene
    this.sfx   = sfx
    /** SIM: {x,y,z, px,py,pz, vx,vy,vz, owner, dmgMul, ttl, mesh} */
    this._balls     = []
    /** RENDER: pooled sprites */
    this._particles = []
    this._tex = getSoftTexture()
    this._spritePool = []
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIM: firing
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Deterministic broadside volley.
   * @param {import('./ship.js').Ship} ship
   * @param {number} side  +1 = port (Q), -1 = starboard (E)
   * @param {object} opts  {count, jitterScale, elevation, traverse, speedMul}
   * @param {import('./dmath.js').DRng} rng  the SIM's rng stream
   * @returns {number[][]} array of [px,py,pz,vx,vy,vz]
   */
  computeBroadside(ship, side, opts = {}, rng) {
    const {
      jitterScale = 1,
      elevation   = DEFAULT_ELEVATION,
      traverse    = 0,
      speedMul    = 1,
    } = opts
    const count = opts.count ?? ship.sideGuns ?? BROADSIDE_BALLS

    const rot = ship.rotationY
    const pos = ship.position
    const fwd  = { x: dsin(rot), z: dcos(rot) }
    const sideAngle = rot + side * (Math.PI / 2)

    const balls = []
    for (let i = 0; i < count; i++) {
      const along = (count === 1 ? 0 : (i / (count - 1) - 0.5)) * ship.halfLength * 1.1
      const px = pos.x + fwd.x * along + dsin(sideAngle) * (ship.halfWidth + 0.8)
      const pz = pos.z + fwd.z * along + dcos(sideAngle) * (ship.halfWidth + 0.8)
      const py = pos.y + ship.deckHeight

      const yaw   = sideAngle + traverse + (rng.next() - 0.5) * 0.09 * jitterScale
      const speed = BALL_SPEED * speedMul * (1 + (rng.next() - 0.5) * 0.14 * jitterScale)
      const elev  = elevation * (1 + (rng.next() - 0.5) * 0.15 * jitterScale)
      const cosE  = dcos(elev)
      balls.push([
        px, py, pz,
        dsin(yaw) * speed * cosE + fwd.x * ship.speed,
        dsin(elev) * speed,
        dcos(yaw) * speed * cosE + fwd.z * ship.speed,
      ])
    }
    return balls
  }

  /**
   * Deterministic bow-chaser volley: fires dead ahead (± a small windage
   * traverse) from the foredeck. Chasers shoot a touch straighter than the
   * broadside guns.
   */
  computeBow(ship, opts = {}, rng) {
    const {
      elevation = DEFAULT_ELEVATION,
      traverse  = 0,
      speedMul  = 1,
    } = opts
    const count = opts.count ?? ship.bowGuns ?? 1

    const rot = ship.rotationY
    const pos = ship.position
    const fwd = { x: dsin(rot), z: dcos(rot) }
    const rightA = rot + Math.PI / 2

    const balls = []
    for (let i = 0; i < count; i++) {
      const lat = count === 1 ? 0 : (i / (count - 1) - 0.5) * ship.halfWidth * 0.9
      const px = pos.x + fwd.x * ship.halfLength * 0.7 + dsin(rightA) * lat
      const pz = pos.z + fwd.z * ship.halfLength * 0.7 + dcos(rightA) * lat
      const py = pos.y + ship.deckHeight

      const yaw   = rot + traverse + (rng.next() - 0.5) * 0.05
      const speed = BALL_SPEED * speedMul * (1 + (rng.next() - 0.5) * 0.08)
      const elev  = elevation * (1 + (rng.next() - 0.5) * 0.1)
      const cosE  = dcos(elev)
      balls.push([
        px, py, pz,
        dsin(yaw) * speed * cosE + fwd.x * ship.speed,
        dsin(elev) * speed,
        dcos(yaw) * speed * cosE + fwd.z * ship.speed,
      ])
    }
    return balls
  }

  /**
   * Add a volley to the simulation (with render-side muzzle effects).
   * @param {number[][]} balls
   * @param {string} ownerId
   * @param {number} dmgMul
   * @param {THREE.Vector3|null} listenerPos  for SFX attenuation (render-side)
   * @param {'ball'|'bolt'} [kind]  bolt = ballista arrow (visual + rig-shredding)
   */
  spawnBroadside(balls, ownerId, dmgMul, listenerPos, kind = 'ball') {
    for (const b of balls) {
      const mesh = this._takeBallMesh(kind)
      mesh.position.set(b[0], b[1], b[2])
      this.scene.add(mesh)
      this._balls.push({
        x: b[0], y: b[1], z: b[2],
        px: b[0], py: b[1], pz: b[2],
        vx: b[3], vy: b[4], vz: b[5],
        owner: ownerId, dmgMul, kind, ttl: BALL_TTL, mesh,
        home: -2,   // resolved on first sim step: island the muzzle sat inside
      })
      // Muzzle flash + smoke (render-only)
      const pos = mesh.position
      this._burst(pos, { count: 2, color: 0xffcc66, size: 3.2, speed: 2, life: 0.18, additive: true })
      this._burst(pos, {
        count: 4, color: 0xbbbbbb, size: 2.4, speed: 3.5, life: 0.9,
        dir: new THREE.Vector3(b[3], b[4], b[5]).normalize(),
      })
    }
    if (balls.length && listenerPos) {
      const dist = Math.hypot(balls[0][0] - listenerPos.x, balls[0][2] - listenerPos.z)
      if (kind === 'bolt') this.sfx.ballista(dist)
      else this.sfx.cannon(dist, balls.length)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIM: fixed-timestep ball physics + collisions (deterministic)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} dt        FIXED_DT
   * @param {number} simTime   tick-derived seconds
   * @param {Array<{id:string, ship:object, isLocal?:boolean, isAI?:boolean, isFort?:boolean}>} targets
   * @param {Array<{x,z,r,h}>} islands
   * @param {(target:object, ball:object, point:THREE.Vector3) => void} onHit
   * @param {THREE.Vector3|null} listenerPos  render-side SFX attenuation
   */
  simStep(dt, simTime, targets, islands, onHit, listenerPos) {
    for (let i = this._balls.length - 1; i >= 0; i--) {
      const ball = this._balls[i]
      ball.px = ball.x; ball.py = ball.y; ball.pz = ball.z
      ball.vy -= BALL_GRAVITY * dt
      ball.x += ball.vx * dt
      ball.y += ball.vy * dt
      ball.z += ball.vz * dt
      ball.ttl -= dt

      const distToListener = listenerPos
        ? Math.hypot(ball.x - listenerPos.x, ball.z - listenerPos.z) : 0

      // Water splashdown
      if (ball.y <= waveHeight(ball.x, ball.z, simTime)) {
        this._splash(ball)
        this.sfx.splash(distToListener)
        this._removeBall(i)
        continue
      }

      // Ship & fort hits — before terrain, so hillside forts are hittable
      let hitShip = false
      const point = new THREE.Vector3(ball.x, ball.y, ball.z)
      for (const target of targets) {
        if (ball.owner === target.id) continue
        if (target.isAI && String(ball.owner).startsWith('ai')) continue
        if (target.isFort && String(ball.owner).startsWith('fort')) continue
        const ship = target.ship
        if (!ship || ship.sinking || !ship.group.visible) continue
        if (ship.containsPoint(point, BALL_RADIUS)) {
          this._burst(point, { count: 3, color: 0xffaa44, size: 2.6, speed: 3, life: 0.22, additive: true })
          this._burst(point, { count: 6, color: 0x8a6a4a, size: 1.8, speed: 6, life: 0.7 })
          this.sfx.woodHit(distToListener)
          onHit(target, ball, point)
          hitShip = true
          break
        }
      }
      if (hitShip) { this._removeBall(i); continue }

      // Island impact — but a shot never collides with the island its own
      // muzzle stood on (forts fire from INSIDE their island's collision
      // circle; without this grace their bolts detonate on the parapet)
      if (ball.home === -2) {
        ball.home = islands.findIndex(isl =>
          dhypot(ball.px - isl.x, ball.pz - isl.z) < (isl.rt ?? isl.r))
      }
      let hitIsland = false
      for (let ii = 0; ii < islands.length; ii++) {
        if (ii === ball.home) continue
        const isl = islands[ii]
        const bound = isl.rt ?? isl.r
        if (dhypot(ball.x - isl.x, ball.z - isl.z) < bound
            && ball.y < (isl.heightAt ? isl.heightAt(ball.x, ball.z) : isl.h + 4)) {
          this._burst(point, { count: 5, color: 0xc2a36b, size: 2.2, speed: 4, life: 0.6 })
          this.sfx.thud(distToListener)
          hitIsland = true
          break
        }
      }
      if (hitIsland || ball.ttl <= 0) this._removeBall(i)
    }
  }

  /** Snapshot the ball list (for late-join state transfer). */
  saveBalls() {
    return this._balls.map(b =>
      [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.owner, b.dmgMul, b.ttl, b.kind, b.home])
  }

  loadBalls(rows) {
    while (this._balls.length) this._removeBall(this._balls.length - 1)
    for (const r of rows ?? []) {
      const kind = r[9] ?? 'ball'
      const mesh = this._takeBallMesh(kind)
      mesh.position.set(r[0], r[1], r[2])
      this.scene.add(mesh)
      this._balls.push({
        x: r[0], y: r[1], z: r[2], px: r[0], py: r[1], pz: r[2],
        vx: r[3], vy: r[4], vz: r[5],
        owner: r[6], dmgMul: r[7], ttl: r[8], kind, mesh,
        home: r[10] ?? -2,
      })
    }
  }

  ballHash(acc) {
    acc.int(this._balls.length)
    for (const b of this._balls) {
      acc.num(b.x).num(b.y).num(b.z).str(String(b.owner))
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER: interpolation + particles
  // ──────────────────────────────────────────────────────────────────────────

  renderStep(dtRender, alpha) {
    for (const ball of this._balls) {
      const mx = ball.px + (ball.x - ball.px) * alpha
      const my = ball.py + (ball.y - ball.py) * alpha
      const mz = ball.pz + (ball.z - ball.pz) * alpha
      ball.mesh.position.set(mx, my, mz)
      if (ball.kind === 'bolt') {
        ball.mesh.lookAt(mx + ball.vx, my + ball.vy, mz + ball.vz)
      }
    }

    for (let i = this._particles.length - 1; i >= 0; i--) {
      const pt = this._particles[i]
      pt.life -= dtRender
      if (pt.life <= 0) {
        this._releaseSprite(pt.sprite)
        this._particles.splice(i, 1)
        continue
      }
      pt.vel.y -= (pt.gravity || 0) * dtRender
      pt.sprite.position.addScaledVector(pt.vel, dtRender)
      const t = pt.life / pt.maxLife
      pt.sprite.material.opacity = t * pt.baseOpacity
      const s = pt.baseSize * (1 + (1 - t) * pt.grow)
      pt.sprite.scale.set(s, s, 1)
    }
  }

  /** A patch of foam that rides the surface (bow spray / wake trails). */
  foam(pos, scale = 1) {
    this._burst(pos, {
      count: 1, color: 0xeaf6fb, size: 2.6 * scale, speed: 0.6,
      life: 1.8, flat: true,
    })
  }

  /** Dramatic explosion for a ship or fort that has just been destroyed. */
  shipExplosion(pos, listenerDist = 0) {
    this._burst(pos, { count: 6, color: 0xffbb33, size: 6, speed: 8, life: 0.4, additive: true })
    this._burst(pos, { count: 14, color: 0x555555, size: 4.5, speed: 7, life: 1.8 })
    this._burst(pos, { count: 8, color: 0xd8ecf5, size: 3, speed: 9, life: 0.8, gravity: 12 })
    this.sfx.shipSunk(listenerDist)
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _removeBall(i) {
    const ball = this._balls[i]
    this.scene.remove(ball.mesh)
    // Pool the mesh — rollback re-simulation reloads the ball list many
    // times a second, and mesh churn at that rate stalls the GPU pipeline
    const pool = this._meshPool ?? (this._meshPool = { ball: [], bolt: [] })
    if (pool[ball.kind]?.length < 64) pool[ball.kind].push(ball.mesh)
    this._balls.splice(i, 1)
  }

  _takeBallMesh(kind) {
    const pool = this._meshPool ?? (this._meshPool = { ball: [], bolt: [] })
    return pool[kind]?.pop()
      ?? (kind === 'bolt' ? makeBoltMesh() : new THREE.Mesh(_ballGeo, _ballMat))
  }

  _splash(ball) {
    this._burst(new THREE.Vector3(ball.x, ball.y, ball.z), {
      count: 6, color: 0xd8ecf5, size: 2.2, speed: 5, life: 0.55,
      dir: new THREE.Vector3(0, 1, 0), gravity: 14,
    })
  }

  _acquireSprite(color, additive) {
    let sprite = this._spritePool.pop()
    if (!sprite) {
      sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._tex, transparent: true, depthWrite: false,
      }))
    }
    sprite.material.color.set(color)
    sprite.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending
    sprite.material.opacity  = 0.85
    return sprite
  }

  _releaseSprite(sprite) {
    this.scene.remove(sprite)
    if (this._spritePool.length < 300) this._spritePool.push(sprite)
    else sprite.material.dispose()
  }

  _burst(pos, { count, color, size, speed, life, dir = null, additive = false, gravity = 0, flat = false }) {
    for (let i = 0; i < count; i++) {
      const sprite = this._acquireSprite(color, additive)
      sprite.position.copy(pos)
      sprite.scale.set(size, size, 1)

      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        Math.random() * 0.9 + 0.1,
        (Math.random() - 0.5) * 2,
      )
      if (dir) vel.addScaledVector(dir, 1.2)
      vel.normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.7))
      if (flat) vel.y *= 0.05

      this.scene.add(sprite)
      this._particles.push({
        sprite, vel,
        life: life * (0.7 + Math.random() * 0.6),
        maxLife: life,
        baseSize: size,
        baseOpacity: 0.85,
        grow: 1.6,
        gravity,
      })
    }
  }
}
