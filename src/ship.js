/**
 * ship.js – Kenney pirate-ship GLB model + physics for local and remote players.
 *
 * Model source: Kenney Pirate Kit (CC0) – https://kenney.nl/assets/pirate-kit
 */
import * as THREE from 'three'
import { WORLD_HALF } from './world.js'
import { cloneAsset }  from './assets.js'

/** Maximum forward speed in m/s; exported so game.js can normalise the gauge. */
export const MAX_SHIP_SPEED = 13

export class Ship {
  /**
   * @param {THREE.Scene} scene
   * @param {string}  name     captain's name
   * @param {number}  color    0xRRGGBB hull colour
   * @param {boolean} isLocal  true for the player-controlled ship
   */
  constructor(scene, name, color, isLocal) {
    this.scene   = scene
    this.name    = name
    this.isLocal = isLocal

    // ── Physics state ──────────────────────────────────────────────────────
    this.speed     = 0          // current forward speed (m/s)
    this.rotationY = 0          // world-space heading (radians)
    this.position  = new THREE.Vector3(0, 0, 0)

    // ── Interpolation targets (remote ships) ───────────────────────────────
    this._tgtPos = new THREE.Vector3()
    this._tgtRot = 0

    // ── Wave bobbing ───────────────────────────────────────────────────────
    this._bobPhase = Math.random() * Math.PI * 2
    this._bobTime  = 0

    this.group = new THREE.Group()
    this._buildModel(color)
    scene.add(this.group)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Model construction
  // ──────────────────────────────────────────────────────────────────────────

  _buildModel(color) {
    // ── Load Kenney pirate ship GLB ──────────────────────────────────────────
    // Local player gets the large ship; remotes get the medium.
    const assetKey = this.isLocal ? 'ship-pirate-large' : 'ship-pirate-medium'
    const model    = cloneAsset(assetKey)

    // Bounding box height at scale 1.0: ~9.96 units (ship-pirate-large)
    // Scale up slightly so the ship reads well in the world.
    const SCALE = 1.2
    model.scale.setScalar(SCALE)
    this._mastTopY = 9.96 * SCALE    // ≈ 11.95 – used for label/bubble offsets

    // ── Tint the ship's flags with the player's identity colour ──────────────
    const flagMat = new THREE.MeshStandardMaterial({
      color,
      emissive:      new THREE.Color(color).multiplyScalar(0.15),
      roughness:     0.8,
      side:          THREE.DoubleSide,
    })
    model.traverse(child => {
      if (child.isMesh && child.name === 'flag-c') {
        child.material = flagMat
        if (!this._flag) this._flag = child   // store for animation
      }
      // Grab the main sail for speed-based belly animation
      if (child.isMesh && child.name === 'sail-b' && !this._mainSail) {
        this._mainSail = child
      }
    })

    this.group.add(model)

    // ── Local-player indicator: glowing ring above the masthead ──────────────
    if (this.isLocal) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.15, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
      )
      ring.rotation.x = Math.PI / 2
      ring.position.y = this._mastTopY + 1.2
      this.group.add(ring)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Update (called every frame)
  // ──────────────────────────────────────────────────────────────────────────

  /** Update physics for the locally-controlled ship. */
  updateLocal(dt, thrust, turn) {
    const ACCEL = 6
    const DRAG  = 2.2

    this.speed += thrust * ACCEL * dt
    this.speed -= this.speed * DRAG * dt
    this.speed  = Math.max(-3, Math.min(MAX_SHIP_SPEED, this.speed))

    // Turn rate scales with |speed| so a drifting ship can't spin
    const turnRate = 0.9 * (Math.abs(this.speed) / MAX_SHIP_SPEED + 0.08)
    this.rotationY += turn * turnRate * dt

    this.position.x += Math.sin(this.rotationY) * this.speed * dt
    this.position.z += Math.cos(this.rotationY) * this.speed * dt

    // Soft world boundary
    this.position.x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, this.position.x))
    this.position.z = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, this.position.z))

    this._bobTime += dt
    this._applyTransform()
  }

  /** Smooth-interpolate a remote ship towards its last known position. */
  updateRemote(dt) {
    // Positional lerp
    this.position.lerp(this._tgtPos, Math.min(1, 8 * dt))

    // Angular lerp (shortest path)
    let dr = this._tgtRot - this.rotationY
    while (dr >  Math.PI) dr -= Math.PI * 2
    while (dr < -Math.PI) dr += Math.PI * 2
    this.rotationY += dr * Math.min(1, 8 * dt)

    this._bobTime += dt
    this._applyTransform()
  }

  _applyTransform() {
    this.group.position.copy(this.position)
    this.group.rotation.y = this.rotationY

    // Gentle rolling / pitching from waves
    const t     = this._bobTime
    const phase = this._bobPhase
    this.group.rotation.z = Math.sin(t * 0.7 + phase) * 0.035
    this.group.rotation.x = Math.sin(t * 0.5 + phase + 1) * 0.025

    // Flag flap (rotate all flag-c child meshes sharing the same material)
    if (this._flag) {
      this._flag.rotation.y = Math.sin(t * 2.5) * 0.3 + 0.3
    }

    // Sail belly when moving – gently rotate the sail-b mesh
    if (this._mainSail) {
      const belly = Math.abs(this.speed) > 0.5 ? Math.sin(t * 1.2) * 0.06 : 0
      this._mainSail.rotation.y = belly
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Setters / getters
  // ──────────────────────────────────────────────────────────────────────────

  /** Lift the ship to the current ocean-wave height at its (x, z). */
  setWaveHeight(y) { this.position.y = y * 0.55 }

  setTargetPosition(x, y, z) { this._tgtPos.set(x, y, z) }
  setTargetRotation(r)        { this._tgtRot = r }

  getPosition()  { return this.position }
  getRotationY() { return this.rotationY }
  getSpeed()     { return this.speed }

  setName(name) { this.name = name }

  getNormalisedSpeed(maxSpeed = MAX_SHIP_SPEED) {
    return Math.max(0, this.speed) / maxSpeed
  }

  /** Remove the ship from the scene and free GPU resources. */
  destroy() {
    this.scene.remove(this.group)
    this.group.traverse(child => {
      if (child.geometry) child.geometry.dispose()
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose())
        } else {
          child.material.dispose()
        }
      }
    })
  }
}
