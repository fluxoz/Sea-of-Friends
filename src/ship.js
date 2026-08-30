/**
 * ship.js – Kenney pirate-ship GLB model + deterministic physics.
 *
 * Under lockstep the class is split in two:
 *   • SIMULATION fields (position, rotation, speed, sail, hp, status effects)
 *     are advanced ONLY inside the fixed-timestep sim via updateLocal(),
 *     using dmath — bit-identical on every peer.
 *   • RENDER state (the THREE group, bobbing, heel, flags, cannon poses)
 *     is written ONLY by renderUpdate(), which interpolates between the last
 *     two sim ticks. Cosmetic randomness (bob phase) never touches the sim.
 *
 * Model source: Kenney Pirate Kit (CC0) – https://kenney.nl/assets/pirate-kit
 */
import * as THREE from 'three'
import { WORLD_HALF, waveHeight } from './world.js'
import { cloneAsset, hasAsset }  from './assets.js'
import { dsin, dcos, wrapAngle, PI, HALF_PI } from './dmath.js'

/** Absolute speed cap in world units/s; exported so game.js can normalise the
 *  gauge. Real top speed is the polar multiplier × the true wind speed. */
export const MAX_SHIP_SPEED = 55

/** Starting hit points for player ships. */
export const PLAYER_MAX_HP = 100

/**
 * Playable ship classes. Chosen on the join screen; part of the join command
 * so every peer builds the same hull in the sim.
 *   sideGuns – cannons per broadside     bowGuns – forward chasers
 */
export const SHIP_CLASSES = {
  sloop: {
    label: 'Sloop', modelKey: 'ship-pirate-small', scale: 1.35,
    maxHp: 70, speedMul: 1.12, turnMul: 1.35, sideGuns: 1, bowGuns: 1,
    sailTint: null,
  },
  frigate: {
    label: 'Frigate', modelKey: 'ship-pirate-large', scale: 1.2,
    maxHp: 100, speedMul: 1.0, turnMul: 1.0, sideGuns: 3, bowGuns: 2,
    sailTint: null,
  },
  manowar: {
    label: "Man-o'-War", modelKey: 'ship-pirate-large', scale: 1.55,
    maxHp: 150, speedMul: 0.85, turnMul: 0.72, sideGuns: 5, bowGuns: 4,
    sailTint: 0x6e4444,   // dark crimson canvas — reads as a heavier warship
  },
}

/** Gun stations along the hull for a given broadside count. */
const SIDE_STATIONS = {
  1: [0],
  3: [-0.54, -0.05, 0.43],
  5: [-0.6, -0.33, -0.05, 0.22, 0.46],
}

/** How long the sinking animation plays before the wreck vanishes (s). */
export const SINK_DURATION = 4.5

/** Resting barrel elevation of the deck cannons (radians). */
export const CANNON_REST_ELEVATION = 0.16

/** True wind angles below this (bow into the wind) give no drive: the no-go
 *  zone. To make way upwind you must tack back and forth across it. */
export const NO_GO_ANGLE = 0.56   // ≈ 32°

// ── Locational damage tuning ──────────────────────────────────────────────────
/** Hull flooding per active waterline leak (hp/s). */
export const LEAK_HP_PER_SEC   = 0.55
/** How long one leak bleeds before the crew plugs it (s). */
export const LEAK_DURATION     = 22
/** How long one rigging hit slows the ship (s). */
export const RIG_DMG_DURATION  = 25
/** Speed lost per active rigging hit (fraction of target speed). */
export const RIG_DMG_SLOW      = 0.16
/** Rigging hits that still slow the ship beyond this are ignored. */
export const RIG_DMG_MAX_STACK = 3

/**
 * Polar performance curve: boat speed as a MULTIPLE OF TRUE WIND SPEED, as a
 * function of true wind angle (0 = bow dead into the wind, π = dead run).
 */
const POLAR = [
  [0,   0.00],   // in irons
  [22,  0.00],
  [32,  0.20],   // just out of the no-go zone
  [45,  0.62],   // close-hauled: a percentage of wind speed
  [60,  0.95],
  [90,  1.35],   // beam reach – faster than the wind itself
  [120, 0.98],   // broad reach
  [150, 0.93],
  [180, 1.00],   // dead run – exactly wind speed
]

/** Interpolate the polar curve. @param {number} twa radians, 0..π */
export function sailEfficiency(twa) {
  const deg = Math.min(180, Math.abs(twa) * (180 / PI))
  for (let i = 1; i < POLAR.length; i++) {
    if (deg <= POLAR[i][0]) {
      const [d0, e0] = POLAR[i - 1]
      const [d1, e1] = POLAR[i]
      return e0 + (e1 - e0) * (deg - d0) / (d1 - d0)
    }
  }
  return POLAR[POLAR.length - 1][1]
}

export class Ship {
  /**
   * @param {THREE.Scene} scene
   * @param {string}  name     captain's name
   * @param {number}  color    0xRRGGBB flag colour
   * @param {boolean} isLocal  true for the player-controlled ship
   * @param {object}  [opts]
   * @param {string}  [opts.modelKey='ship-pirate-large']  asset to use
   * @param {number}  [opts.maxHp=PLAYER_MAX_HP]
   * @param {string}  [opts.shipClass]  key into SHIP_CLASSES
   */
  constructor(scene, name, color, isLocal, opts = {}) {
    this.scene   = scene
    this.name    = name
    this.isLocal = isLocal

    // Class definition (AI/ghost ships pass none and get neutral stats)
    const cls = SHIP_CLASSES[opts.shipClass]
    this.shipClass = opts.shipClass ?? null
    this.speedMul  = cls?.speedMul ?? 1
    this.turnMul   = cls?.turnMul  ?? 1
    this.sideGuns  = cls?.sideGuns ?? 3
    this.bowGuns   = cls?.bowGuns  ?? 0
    if (cls) {
      opts = { ...opts, modelKey: cls.modelKey, maxHp: cls.maxHp }
      this._modelScale = cls.scale
      this._sailTint   = cls.sailTint
    }

    // ── SIM: physics state ─────────────────────────────────────────────────
    this.speed     = 0          // current forward speed (m/s)
    this.rotationY = 0          // world-space heading (radians)
    this.position  = new THREE.Vector3(0, 0, 0)
    this.sail      = 0          // canvas set, 0..1
    this._eff      = 1          // last wind efficiency (for the HUD)
    this._inIrons  = false

    // ── SIM: combat state ──────────────────────────────────────────────────
    this.maxHp   = opts.maxHp ?? PLAYER_MAX_HP
    this.hp      = this.maxHp
    this.sinking = false
    this._sinkT  = 0
    this._statusT = 0
    this._leaks   = []   // expiry times: each leak slowly floods the hull
    this._rigDmg  = []   // expiry times: each slows the ship while it lasts
    this._waveY   = 0

    // ── SIM: previous-tick pose for render interpolation ───────────────────
    this._px = 0; this._pz = 0; this._prot = 0

    // ── RENDER-ONLY state ──────────────────────────────────────────────────
    this._heel     = 0
    this._lastTurn = 0
    this._lastRel  = 0
    this._bobPhase = Math.random() * PI * 2   // cosmetic, never in the sim
    this._bobTime  = 0
    this._cannons     = { 1: [], [-1]: [], bow: [] }
    this._cannonElev  = { 1: CANNON_REST_ELEVATION, [-1]: CANNON_REST_ELEVATION, bow: CANNON_REST_ELEVATION }
    this._cannonTrav  = { 1: 0, [-1]: 0, bow: 0 }
    this._recoil      = { 1: 0, [-1]: 0, bow: 0 }

    this.group = new THREE.Group()
    this._buildModel(color, opts.modelKey ?? 'ship-pirate-large')
    this._buildHealthBar()
    scene.add(this.group)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Model construction
  // ──────────────────────────────────────────────────────────────────────────

  _buildModel(color, modelKey) {
    const model = cloneAsset(modelKey)

    const SCALE = this._modelScale ?? 1.2
    model.scale.setScalar(SCALE)

    // Measure the scaled model so hit detection matches the actual hull
    const box  = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    this.halfWidth  = Math.max(1.5, size.x / 2)
    this.halfLength = Math.max(3.0, size.z / 2)
    this.height     = size.y
    this._mastTopY  = box.max.y
    /** Approximate deck level, where cannonballs are fired from. */
    this.deckHeight = Math.max(2.5, size.y * 0.3)

    // ── Tint the ship's flags with the player's identity colour ──────────────
    const flagMat = new THREE.MeshStandardMaterial({
      color,
      emissive:      new THREE.Color(color).multiplyScalar(0.15),
      roughness:     0.8,
      side:          THREE.DoubleSide,
    })
    this._flagMat = flagMat
    model.traverse(child => {
      if (child.isMesh && child.name === 'flag-c') {
        child.material = flagMat
        if (!this._flag) this._flag = child
      }
      if (child.isMesh && child.name === 'sail-b' && !this._mainSail) {
        this._mainSail = child
      }
      // Class livery: tint the canvas (per-clone material, texture preserved)
      if (this._sailTint && child.isMesh && child.name.startsWith('sail')) {
        child.material = child.material.clone()
        child.material.color = new THREE.Color(this._sailTint)
      }
    })

    this.group.add(model)
    this._mountCannons()

    // ── Local-player indicator: glowing ring above the masthead ──────────────
    if (this.isLocal) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.15, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
      )
      ring.rotation.x = PI / 2
      ring.position.y = this._mastTopY + 1.2
      this.group.add(ring)
    }
  }

  /** Mount visible deck cannons: broadside batteries + bow chasers. */
  _mountCannons() {
    if (!hasAsset('cannon')) return
    const stationTable = { 1: [0], 3: [-0.54, -0.05, 0.43], 5: [-0.6, -0.33, -0.05, 0.22, 0.46] }
    const stations = (stationTable[this.sideGuns] ?? stationTable[3])
      .map(a => a * this.halfLength)
    const scale = this.halfLength * 0.16

    for (const side of [1, -1]) {
      for (const along of stations) {
        const cannon = cloneAsset('cannon')
        cannon.scale.setScalar(scale)
        cannon.rotation.order = 'YXZ'
        cannon.rotation.y = side * PI / 2
        cannon.position.set(
          side * this.halfWidth * 0.52,
          this.deckHeight * 0.68,
          along,
        )
        cannon.userData.baseX = cannon.position.x
        this.group.add(cannon)
        this._cannons[side].push(cannon)
      }
    }

    // Bow chasers, spread across the foredeck facing dead ahead
    for (let i = 0; i < this.bowGuns; i++) {
      const cannon = cloneAsset('cannon')
      cannon.scale.setScalar(scale * 0.85)
      cannon.rotation.order = 'YXZ'
      cannon.rotation.y = 0
      const lat = this.bowGuns === 1 ? 0
        : (i / (this.bowGuns - 1) - 0.5) * this.halfWidth * 0.9
      cannon.position.set(lat, this.deckHeight * 0.72, this.halfLength * 0.6)
      cannon.userData.baseZ = cannon.position.z
      this.group.add(cannon)
      this._cannons.bow.push(cannon)
    }
  }

  /** Pitch one side's barrels (radians above horizontal). Render-only. */
  setCannonElevation(side, elev) {
    this._cannonElev[side] = elev
  }

  /** Swivel one battery's barrels toward the aim (render-only). */
  setCannonTraverse(side, t) {
    this._cannonTrav[side] = t
  }

  /** Kick one side's cannons inboard; they spring back over ~0.4 s. */
  triggerRecoil(side) {
    this._recoil[side] = 1
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Floating health bar (hidden for the local ship – the HUD shows it instead)
  // ──────────────────────────────────────────────────────────────────────────

  _buildHealthBar() {
    this._hpCanvas = document.createElement('canvas')
    this._hpCanvas.width  = 64
    this._hpCanvas.height = 8
    this._hpTexture = new THREE.CanvasTexture(this._hpCanvas)

    const mat = new THREE.SpriteMaterial({
      map: this._hpTexture,
      transparent: true,
      depthWrite: false,
    })
    this._hpSprite = new THREE.Sprite(mat)
    this._hpSprite.position.y = this._mastTopY + 2.2
    this._hpSprite.scale.set(9, 1.1, 1)
    this._hpSprite.visible = !this.isLocal
    this.group.add(this._hpSprite)
    this._redrawHealthBar()
  }

  _redrawHealthBar() {
    const ctx = this._hpCanvas.getContext('2d')
    const t   = Math.max(0, this.hp / this.maxHp)
    ctx.clearRect(0, 0, 64, 8)
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, 0, 64, 8)
    ctx.fillStyle = t > 0.55 ? '#4caf50' : t > 0.28 ? '#f0a020' : '#f44336'
    ctx.fillRect(1, 1, 62 * t, 6)
    this._hpTexture.needsUpdate = true
  }

  setHealthBarVisible(visible) {
    this._hpSprite.visible = visible
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIM: combat
  // ──────────────────────────────────────────────────────────────────────────

  /** Apply damage. Returns the new hp. */
  damage(amount) {
    this.hp = Math.max(0, this.hp - amount)
    this._redrawHealthBar()
    return this.hp
  }

  startSinking() {
    this.sinking = true
    this._sinkT  = 0
    this.speed   = 0
    this.clearStatusEffects()
    this._hpSprite.visible = false
  }

  /** Bring a ship back to life at the given position. */
  respawnReset(x, z) {
    this.hp      = this.maxHp
    this.sinking = false
    this._sinkT  = 0
    this.speed   = 0
    this.sail    = 0
    this._heel   = 0
    this.clearStatusEffects()
    this.position.set(x, 0, z)
    this._px = x; this._pz = z
    this.group.visible = true
    this._hpSprite.visible = !this.isLocal
    this._redrawHealthBar()
  }

  /**
   * Which part of the ship a world-space impact point struck.
   * @returns {'waterline'|'hull'|'rigging'}
   */
  hitZone(p) {
    const dy = p.y - this.position.y
    if (dy < 1.7) return 'waterline'
    if (dy > this.deckHeight + 1.6) return 'rigging'
    return 'hull'
  }

  addLeak(duration = LEAK_DURATION)      { this._leaks.push(this._statusT + duration) }
  addRigDamage(duration = RIG_DMG_DURATION) { this._rigDmg.push(this._statusT + duration) }
  activeLeaks()     { return this._leaks.length }
  activeRigDamage() { return this._rigDmg.length }
  clearStatusEffects() {
    this._leaks.length  = 0
    this._rigDmg.length = 0
  }

  _updateStatusEffects(dt) {
    this._statusT += dt
    if (this._leaks.length) {
      this._leaks = this._leaks.filter(t => t > this._statusT)
      if (this._leaks.length && this.hp > 0) {
        this.hp = Math.max(0, this.hp - LEAK_HP_PER_SEC * this._leaks.length * dt)
        this._redrawHealthBar()
      }
    }
    if (this._rigDmg.length) {
      this._rigDmg = this._rigDmg.filter(t => t > this._statusT)
    }
  }

  /**
   * True if a world-space point is inside the ship's hull box.
   */
  containsPoint(p, pad = 0) {
    const dx = p.x - this.position.x
    const dz = p.z - this.position.z
    const cos = dcos(-this.rotationY)
    const sin = dsin(-this.rotationY)
    const lx = dx * cos - dz * sin
    const lz = dx * sin + dz * cos
    const dy = p.y - this.position.y
    return Math.abs(lx) <= this.halfWidth  + pad
        && Math.abs(lz) <= this.halfLength + pad
        && dy >= -1.5 && dy <= this.height + pad
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIM: fixed-timestep physics (deterministic — dmath only)
  // ──────────────────────────────────────────────────────────────────────────

  /** Record the current pose as the interpolation baseline for this tick. */
  capturePrev() {
    this._px   = this.position.x
    this._pz   = this.position.z
    this._prot = this.rotationY
  }

  /**
   * Advance one fixed simulation step.
   * @param {number} dt         FIXED_DT
   * @param {number} sailDelta  -1..1
   * @param {number} turn       -1..1 rudder
   * @param {{dir:number, speed:number}|null} wind
   * @param {boolean} [reverse]
   */
  updateLocal(dt, sailDelta, turn, wind, reverse = false) {
    if (this.sinking) { this._sinkT += dt; return }

    const TAU_ACCEL = 3.5
    const TAU_COAST = 8.0

    this.sail = Math.max(0, Math.min(1, this.sail + sailDelta * dt * 0.8))

    let eff = 1, windSpeed = 19, rel = 0, twa = PI
    if (wind) {
      rel = wrapAngle(wind.dir - this.rotationY)
      twa       = PI - Math.abs(rel)
      eff       = sailEfficiency(twa)
      windSpeed = wind.speed
    }
    this._eff      = eff
    this._inIrons  = twa < NO_GO_ANGLE
    this._lastRel  = rel
    this._lastTurn = turn
    this._windSpd  = windSpeed

    this._updateStatusEffects(dt)

    const rigFactor = 1 - RIG_DMG_SLOW * Math.min(RIG_DMG_MAX_STACK, this._rigDmg.length)
    const target = (reverse && this.sail < 0.05)
      ? -4
      : Math.min(MAX_SHIP_SPEED, this.sail * eff * windSpeed * rigFactor * this.speedMul)

    const tau = Math.abs(target) > Math.abs(this.speed) ? TAU_ACCEL : TAU_COAST
    this.speed += (target - this.speed) * Math.min(1, dt / tau)

    // Hard rudder bleeds speed
    this.speed *= 1 - Math.abs(turn) * (Math.abs(this.speed) / MAX_SHIP_SPEED) * 0.35 * dt

    const turnRate = 0.7 * (Math.abs(this.speed) / MAX_SHIP_SPEED + 0.12) * this.turnMul
    this.rotationY = wrapAngle(this.rotationY + turn * turnRate * dt)

    this.position.x += dsin(this.rotationY) * this.speed * dt
    this.position.z += dcos(this.rotationY) * this.speed * dt

    this.position.x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, this.position.x))
    this.position.z = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, this.position.z))
  }

  /** Lift the ship to the current ocean-wave height at its (x, z). */
  setWaveHeight(y) {
    this._waveY = y
    if (!this.sinking) this.position.y = y * 0.55
  }

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER: interpolated visuals (free to use Math.*)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} dtRender  wall-clock seconds since last render frame
   * @param {number} alpha     0..1 interpolation between prev and current tick
   * @param {number} waveTime  interpolated sim time for wave sampling
   */
  renderUpdate(dtRender, alpha, waveTime) {
    if (!this.group.visible) return

    let ix = this._px + (this.position.x - this._px) * alpha
    let iz = this._pz + (this.position.z - this._pz) * alpha
    let dr = this.rotationY - this._prot
    while (dr >  PI) dr -= PI * 2
    while (dr < -PI) dr += PI * 2
    let irot = this._prot + dr * alpha

    // Exponential pose smoothing (~70 ms) irons out lockstep tick jitter:
    // ticks land on the pump timer, not on frame boundaries, so the raw
    // interpolation clock stutters against `executed` at speed.
    if (!this._rp || Math.abs(ix - this._rp.x) > 40 || Math.abs(iz - this._rp.z) > 40) {
      this._rp = { x: ix, z: iz, r: irot }     // snap on spawn/teleport
    }
    const k = 1 - Math.exp(-dtRender * 14)
    this._rp.x += (ix - this._rp.x) * k
    this._rp.z += (iz - this._rp.z) * k
    let dr2 = irot - this._rp.r
    while (dr2 >  PI) dr2 -= PI * 2
    while (dr2 < -PI) dr2 += PI * 2
    this._rp.r += dr2 * k
    ix = this._rp.x; iz = this._rp.z; irot = this._rp.r

    if (this.sinking) {
      const t = this._sinkT
      if (t >= SINK_DURATION) { this.group.visible = false; return }
      this.group.position.set(ix, this._waveY * 0.55 - t * t * 0.9, iz)
      this.group.rotation.y = irot
      this.group.rotation.z = Math.min(0.9, t * 0.28)
      this.group.rotation.x = Math.min(0.5, t * 0.14)
      return
    }

    const wy = waveHeight(ix, iz, waveTime) * 0.55
    this.group.position.set(ix, wy, iz)
    this.group.rotation.y = irot

    // Bob + heel (render-only)
    this._bobTime += dtRender
    const heelTarget = (dsin(this._lastRel) * (this._windSpd ?? 19) * 0.0035) * this.sail
                     + this._lastTurn * (this.speed / MAX_SHIP_SPEED) * 0.06
    this._heel += (heelTarget - this._heel) * Math.min(1, 2 * dtRender)

    const t     = this._bobTime
    const phase = this._bobPhase
    this.group.rotation.z = Math.sin(t * 0.7 + phase) * 0.035 + this._heel
    this.group.rotation.x = Math.sin(t * 0.5 + phase + 1) * 0.025

    if (this._flag) {
      this._flag.rotation.y = Math.sin(t * 2.5) * 0.3 + 0.3
    }
    if (this._mainSail) {
      const belly = Math.abs(this.speed) > 0.5 ? Math.sin(t * 1.2) * 0.06 : 0
      this._mainSail.rotation.y = belly
    }

    // Cannon recoil + elevation
    for (const side of [1, -1]) {
      this._recoil[side] = Math.max(0, this._recoil[side] - dtRender * 2.5)
      const elev   = this._cannonElev[side]
      const trav   = this._cannonTrav[side]
      const recoil = this._recoil[side]
      for (const cannon of this._cannons[side]) {
        cannon.rotation.y = side * PI / 2 + trav
        cannon.rotation.x = -elev
        cannon.position.x = cannon.userData.baseX - side * recoil * recoil * 0.7
      }
    }
    this._recoil.bow = Math.max(0, this._recoil.bow - dtRender * 2.5)
    for (const cannon of this._cannons.bow) {
      cannon.rotation.y = this._cannonTrav.bow
      cannon.rotation.x = -this._cannonElev.bow
      cannon.position.z = cannon.userData.baseZ - this._recoil.bow * this._recoil.bow * 0.7
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Getters / lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  getPosition()  { return this.position }
  getRotationY() { return this.rotationY }
  getSpeed()     { return this.speed }
  setName(name)  { this.name = name }

  /** Retint the identity flag (cosmetic; arrives async over the info channel). */
  setFlagColor(color) {
    if (!this._flagMat) return
    this._flagMat.color.set(color)
    this._flagMat.emissive.set(color).multiplyScalar(0.15)
  }

  getNormalisedSpeed(maxSpeed = MAX_SHIP_SPEED) {
    return Math.max(0, this.speed) / maxSpeed
  }

  /** Remove the ship from the scene and free GPU resources it owns. */
  destroy() {
    this.scene.remove(this.group)
    this._hpTexture?.dispose()
  }
}
