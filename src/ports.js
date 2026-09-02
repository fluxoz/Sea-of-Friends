/**
 * ports.js – Neutral trading coves where captains dock and spend plunder.
 *
 * Three ports per sea, placed deterministically from the world seed on
 * well-spread mid-size isles away from forts. The anchorage is a circle of
 * calm water off the island's lowest shore; glide in slow with sails struck
 * and yer moored. All placement math is seed-deterministic (every peer
 * builds the identical port list); visuals are render-side Kenney props.
 *
 * The store catalog lives here too so the sim (validation/effects) and the
 * UI (panel rows) can never disagree about prices.
 */
import * as THREE from 'three'
import { cloneAsset, hasAsset } from './assets.js'
import { dcos, dsin, dhypot } from './dmath.js'

export const DOCK_RADIUS = 24

export const STORE_ITEMS = [
  { key: 'repair', icon: '🔧', name: 'Hull repairs',  desc: 'Patch her up to full',            price: 2, perHp: true },
  { key: 'plank',  icon: '🪵', name: 'Oak planking',  desc: '+25 max hull, rides heavier',     price: 60, max: 2 },
  { key: 'cannon', icon: '🧨', name: 'Extra cannons', desc: '+1 gun per broadside',            price: 80, max: 2 },
  { key: 'sails',  icon: '⛵', name: 'Silk sails',    desc: '+12% top speed',                  price: 70, max: 1 },
  { key: 'chain',  icon: '🔗', name: 'Chain shot ×2', desc: 'Next 2 broadsides fly fast & hard', price: 45 },
  { key: 'keg',    icon: '💥', name: 'Powder keg',    desc: 'Next broadside +40% — risky',     price: 50 },
]

const PORT_NAMES = [
  'Port Salt', 'Tortuga Cove', 'Gullwing Bay', 'Rumrunner Rest', 'Port Mango',
  'Driftwood Quay', 'Barnacle Bight', 'Old Anchorage', 'Port Plunder',
  'Smuggler’s Nook', 'Cutlass Cove', 'Port Marrow',
]

export class Ports {
  constructor(scene, world) {
    this.scene = scene
    this.world = world
    /** @type {Array<{x:number, z:number, name:string, group:THREE.Group}>} */
    this.list = []
  }

  clear() {
    for (const p of this.list) {
      if (p.group) this.scene.remove(p.group)
    }
    this.list = []
  }

  /** Seed-deterministic placement; forts is the fort list to keep clear of. */
  generate(seed, forts = []) {
    this.clear()
    // Tiny deterministic PRNG (mulberry-style, integer ops only)
    let s = (seed >>> 0) ^ 0x704f5e7a
    const rng = () => {
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    const isles = this.world.getIslands().filter(i =>
      i.kind === 'isle' && i.r >= 24 && i.r <= 70
      && forts.every(f => dhypot(i.x - f.x, i.z - f.z) > 200))
    if (!isles.length) return

    // Greedy spread: random first pick, then maximize distance to chosen
    const chosen = [isles[(rng() * isles.length) | 0]]
    while (chosen.length < 3 && chosen.length < isles.length) {
      let best = null, bestD = -1
      for (const c of isles) {
        if (chosen.includes(c)) continue
        const d = Math.min(...chosen.map(o => dhypot(c.x - o.x, c.z - o.z)))
        if (d > bestD) { bestD = d; best = c }
      }
      if (!best) break
      chosen.push(best)
    }

    const nameOff = (rng() * PORT_NAMES.length) | 0
    chosen.forEach((isl, i) => {
      // Anchor off the lowest stretch of shoreline
      const a0 = rng() * Math.PI * 2
      let a = a0, low = Infinity
      for (let k = 0; k < 16; k++) {
        const a2 = a0 + (k / 16) * Math.PI * 2
        const h = isl.heightAt
          ? isl.heightAt(isl.x + dcos(a2) * isl.r * 0.9, isl.z + dsin(a2) * isl.r * 0.9)
          : 0
        if (h < low) { low = h; a = a2 }
      }
      const ax = isl.x + dcos(a) * (isl.r + 18)
      const az = isl.z + dsin(a) * (isl.r + 18)
      const name = PORT_NAMES[(nameOff + i) % PORT_NAMES.length]
      this.list.push({ x: ax, z: az, name, group: this._buildVisuals(ax, az, a) })
    })
  }

  /** Render-side props: a dock reaching toward open water, colours flying,
   *  buoys marking the anchorage. */
  _buildVisuals(ax, az, shoreAngle) {
    const g = new THREE.Group()
    const yaw = Math.PI / 2 - shoreAngle
    if (hasAsset('dock')) {
      const d = cloneAsset('dock')
      d.scale.setScalar(3.4)
      d.position.set(0, 0.6, 0)
      d.rotation.y = yaw
      g.add(d)
    }
    if (hasAsset('flag-high')) {
      const f = cloneAsset('flag-high')
      f.scale.setScalar(3.2)
      f.position.set(dcos(shoreAngle) * 6, 4.2, dsin(shoreAngle) * 6)
      g.add(f)
    }
    if (hasAsset('barrel')) {
      for (let i = 0; i < 3; i++) {
        const b = cloneAsset('barrel')
        b.scale.setScalar(2.0)
        b.position.set(-dcos(shoreAngle) * (3 + i * 2.2) + dsin(shoreAngle) * 2,
          4.4, -dsin(shoreAngle) * (3 + i * 2.2) - dcos(shoreAngle) * 2)
        g.add(b)
      }
    }
    if (hasAsset('buoy-flag')) {
      for (const side of [-1, 1]) {
        const b = cloneAsset('buoy-flag')
        b.scale.setScalar(3.0)
        const ba = shoreAngle + side * 0.9
        b.position.set(dcos(ba) * (DOCK_RADIUS - 3), 0, dsin(ba) * (DOCK_RADIUS - 3))
        g.add(b)
      }
    }
    g.position.set(ax, 0, az)
    this.scene.add(g)
    return g
  }

  /** Index of the port whose anchorage contains (x, z), else -1. */
  nearest(x, z) {
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i]
      if (dhypot(x - p.x, z - p.z) < DOCK_RADIUS) return i
    }
    return -1
  }
}
