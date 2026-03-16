/**
 * ship.js – Procedural 3D ship model + physics for local and remote players.
 */
import * as THREE from 'three'
import { WORLD_HALF } from './world.js'

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
    const hullMat  = new THREE.MeshPhongMaterial({ color })
    const woodMat  = new THREE.MeshPhongMaterial({ color: 0x7b4f25 })
    const deckMat  = new THREE.MeshPhongMaterial({ color: 0xa07840 })
    const sailMat  = new THREE.MeshPhongMaterial({ color: 0xf5f0e0, side: THREE.DoubleSide })
    const ironMat  = new THREE.MeshPhongMaterial({ color: 0x2c2c2c })

    // Hull body
    const hull = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 10), hullMat)
    hull.position.y = 0.5
    hull.castShadow = true
    this.group.add(hull)

    // Bow (wedge front) – use a 4-sided cone turned sideways
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(0, 2.1, 3.2, 4), hullMat)
    bow.position.set(0, 0.2, 5.8)
    bow.rotation.x = -Math.PI / 2
    bow.rotation.y = Math.PI / 4
    bow.castShadow = true
    this.group.add(bow)

    // Stern upper structure
    const stern = new THREE.Mesh(new THREE.BoxGeometry(4, 2.2, 3), woodMat)
    stern.position.set(0, 2.5, -3.5)
    stern.castShadow = true
    this.group.add(stern)

    // Deck planks
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.25, 9), deckMat)
    deck.position.y = 1.85
    deck.receiveShadow = true
    this.group.add(deck)

    // Main mast
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 15, 8), woodMat)
    mast.position.set(0, 9.5, 0)
    mast.castShadow = true
    this.group.add(mast)

    // Fore-mast
    const foreMast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 10, 8), woodMat)
    foreMast.position.set(0, 7, 3.5)
    foreMast.castShadow = true
    this.group.add(foreMast)

    // Yard arms
    const addYard = (y, z, len) => {
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 6), woodMat)
      yard.rotation.z = Math.PI / 2
      yard.position.set(0, y, z)
      this.group.add(yard)
      return yard
    }
    addYard(14, 0, 8.5)
    addYard(9.5, 0, 7)
    addYard(11, 3.5, 5)

    // Main sail
    this._mainSail = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 5.5), sailMat)
    this._mainSail.position.set(0, 11, 0.4)
    this._mainSail.castShadow = true
    this.group.add(this._mainSail)

    // Upper main topsail
    const topSail = new THREE.Mesh(new THREE.PlaneGeometry(5, 4), sailMat)
    topSail.position.set(0, 14.5, 0.3)
    this.group.add(topSail)

    // Fore sail
    const foreSail = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), sailMat)
    foreSail.position.set(0, 9, 3.8)
    this.group.add(foreSail)

    // Bowsprit (diagonal spar at front)
    const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 7, 6), woodMat)
    bowsprit.position.set(0, 2.5, 6.5)
    bowsprit.rotation.x = -Math.PI / 5
    this.group.add(bowsprit)

    // Jib sail
    const jibGeo = new THREE.BufferGeometry()
    const verts = new Float32Array([0,3.5,5.5,  0,1.5,7.5,  0,-0.5,10.5])
    jibGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    jibGeo.setIndex([0,1,2, 2,1,0])
    jibGeo.computeVertexNormals()
    this.group.add(new THREE.Mesh(jibGeo, sailMat))

    // Flag at masthead
    const flagMat = new THREE.MeshPhongMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.2),
      side: THREE.DoubleSide,
    })
    this._flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), flagMat)
    this._flag.position.set(0.8, 17.2, 0)
    this.group.add(this._flag)

    // Cannons (3 per side)
    const cannonGeo = new THREE.CylinderGeometry(0.2, 0.25, 1.6, 8)
    for (const side of [-1, 1]) {
      for (const z of [-2, 0, 2]) {
        const cannon = new THREE.Mesh(cannonGeo, ironMat)
        cannon.position.set(side * 2.25, 1.3, z)
        cannon.rotation.z = (side * Math.PI) / 2
        this.group.add(cannon)
      }
    }

    // Wheel (decorative)
    const wheelRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.6, 0.07, 6, 12),
      woodMat,
    )
    wheelRim.position.set(0, 3, -4)
    wheelRim.rotation.x = Math.PI / 6
    this.group.add(wheelRim)

    // Local-player indicator: glowing ring above ship
    if (this.isLocal) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.15, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
      )
      ring.rotation.x = Math.PI / 2
      ring.position.y = 18.5
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

    // Flag flap
    if (this._flag) {
      this._flag.rotation.y = Math.sin(t * 2.5) * 0.3 + 0.3
    }

    // Sail belly when moving
    if (this._mainSail) {
      const belly = Math.abs(this.speed) > 0.5 ? Math.sin(t * 1.2) * 0.04 : 0
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
