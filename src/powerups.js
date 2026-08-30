/**
 * powerups.js – Floating pickups + dropped treasure, deterministic under
 * lockstep. Spawn timing/placement comes from the sim's seeded RNG stream,
 * pickups are resolved inside the fixed-timestep sim in sorted player order —
 * so there is no claim protocol at all: every peer computes the same winner.
 */
import * as THREE from 'three'
import { waveHeight } from './world.js'
import { getSoftTexture } from './combat.js'
import { cloneAsset, hasAsset } from './assets.js'
import { dsin, dcos, dhypot, PI } from './dmath.js'

/** Everything there is to know about each power-up type. */
export const POWERUP_TYPES = {
  health: { color: 0x4caf50, name: 'Hull repairs',   icon: '💚' },
  reload: { color: 0x42a5f5, name: 'Fast reload',    icon: '🔵' },
  armor:  { color: 0xffd54f, name: 'Armor plating',  icon: '🛡' },
  ammo:   { color: 0xef5350, name: 'Chain shot',     icon: '🔴' },
  autoaim:{ color: 0xb06ae8, name: 'Master gunner',  icon: '🎯' },
  // Dropped treasure — never spawned randomly, only by sinking ships/forts
  gold:   { color: 0xffc83d, name: 'Treasure',       icon: '🪙' },
}
const TYPE_KEYS = Object.keys(POWERUP_TYPES).filter(t => t !== 'gold')

const MAX_ACTIVE     = 8
const SPAWN_INTERVAL = [7, 15]      // seconds between spawns
const GOLD_TTL       = 240          // unclaimed treasure sinks after this (s)
const PICKUP_RADIUS  = 13
const SPAWN_RING     = [250, 2600]

export class Powerups {
  constructor(scene, world) {
    this.scene = scene
    this.world = world
    /** @type {Map<string, object>} id → item */
    this.items = new Map()
    this._nextId      = 1
    this._nextSpawnIn = 5
    this._tex         = getSoftTexture()
  }

  clearAll() {
    for (const id of [...this.items.keys()]) this._remove(id)
    this._nextId = 1
    this._nextSpawnIn = 5
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIM: one fixed step
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} dt  FIXED_DT
   * @param {Array<{id, ship, alive}>} players  sorted, with sim ships
   * @param {import('./dmath.js').DRng} rng
   * @returns {Array<{type:'pickup', pid, ptype, amount, x, z}>} events
   */
  simStep(dt, players, rng) {
    const events = []

    // Keep the sea stocked (treasure chests don't count against the cap)
    const stocked = [...this.items.values()].filter(p => p.type !== 'gold').length
    this._nextSpawnIn -= dt
    if (stocked < MAX_ACTIVE && this._nextSpawnIn <= 0) {
      this._spawnRandom(rng)
      this._nextSpawnIn = SPAWN_INTERVAL[0]
        + rng.next() * (SPAWN_INTERVAL[1] - SPAWN_INTERVAL[0])
    }

    // Unclaimed treasure eventually sinks
    for (const item of [...this.items.values()]) {
      if (item.type !== 'gold') continue
      item.ttl -= dt
      if (item.ttl <= 0) this._remove(item.id)
    }

    // Pickups, resolved in sorted player order — deterministic winner
    for (const p of players) {
      if (!p.alive) continue
      const pos = p.ship.position
      for (const item of this.items.values()) {
        if (dhypot(pos.x - item.x, pos.z - item.z) < PICKUP_RADIUS) {
          events.push({
            type: 'pickup', pid: p.id, ptype: item.type,
            amount: item.amount || 0, x: item.x, z: item.z,
          })
          this._remove(item.id, true)
          break
        }
      }
    }

    return events
  }

  /** Drop a chest of gold into the water (a sunk ship's purse / fort loot). */
  dropGold(x, z, amount) {
    if (amount <= 0) return
    this._add(`g${this._nextId++}`, 'gold', x, z, amount)
  }

  /** Render: bob + spin the visuals on the waves. */
  renderStep(dtRender, waveTime) {
    for (const item of this.items.values()) {
      const y = waveHeight(item.x, item.z, waveTime)
      item.group.position.y = y + 2.2 + Math.sin(waveTime * 1.4 + item.bobSeed) * 0.5
      item.group.rotation.y += dtRender * 1.2
    }
  }

  /** Positions for the world map. */
  list() {
    return [...this.items.values()].map(p => ({ type: p.type, x: p.x, z: p.z }))
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Snapshot / hash
  // ──────────────────────────────────────────────────────────────────────────

  save() {
    return {
      n: this._nextId,
      s: this._nextSpawnIn,   // exact: rounding here corrupts state on rollback
      i: [...this.items.values()].map(p =>
        [p.id, p.type, p.x, p.z, p.amount || 0, p.ttl ?? 0]),
    }
  }

  load(data) {
    if (!data) { this.clearAll(); return }
    // Fast path for rollback re-loads: items are immutable once spawned
    // except their ttl, so when the id set matches, only assign values —
    // no mesh churn at rollback frequency
    const rows = data.i ?? []
    if (rows.length === this.items.size && rows.every(r => this.items.has(r[0]))) {
      this._nextId = data.n ?? 1
      this._nextSpawnIn = data.s ?? 5
      for (const r of rows) {
        const item = this.items.get(r[0])
        if (item.type === 'gold') item.ttl = r[5]
      }
      return
    }
    this.clearAll()
    this._nextId = data.n ?? 1
    this._nextSpawnIn = data.s ?? 5
    for (const r of rows) {
      this._add(r[0], r[1], r[2], r[3], r[4])
      const item = this.items.get(r[0])
      if (item && item.type === 'gold') item.ttl = r[5]
    }
  }

  hash(acc) {
    acc.int(this.items.size)
    for (const item of this.items.values()) {
      acc.str(String(item.id)).num(item.x).num(item.z).int(item.amount || 0)
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _spawnRandom(rng) {
    const islands = this.world.getIslands()
    for (let tries = 0; tries < 25; tries++) {
      const a = rng.next() * PI * 2
      const d = SPAWN_RING[0] + rng.next() * (SPAWN_RING[1] - SPAWN_RING[0])
      const x = dcos(a) * d
      const z = dsin(a) * d
      if (islands.some(isl => dhypot(x - isl.x, z - isl.z) < isl.r + 25)) continue
      const type = TYPE_KEYS[rng.int(TYPE_KEYS.length)]
      this._add(`p${this._nextId++}`, type, x, z)
      return
    }
  }

  _add(id, type, x, z, amount = 0) {
    if (!POWERUP_TYPES[type] || this.items.has(id)) return
    const color = POWERUP_TYPES[type].color
    const group = new THREE.Group()
    group.position.set(x, 2, z)

    if (type === 'gold' && hasAsset('x-chest')) {
      // A proper treasure chest, ringed by drifting coins; big hauls get a
      // whole spilling pile of plunder
      const chest = cloneAsset('x-chest')
      chest.position.y = -1.6
      group.add(chest)
      if (amount >= 200 && hasAsset('x-treasure')) {
        const pile = cloneAsset('x-treasure')
        pile.position.set(1.6, -1.7, -1.2)
        group.add(pile)
      }
      if (hasAsset('x-coin')) {
        for (let i = 0; i < 3; i++) {
          const coin = cloneAsset('x-coin')
          const a = (i / 3) * Math.PI * 2
          coin.position.set(Math.cos(a) * 2.4, -1.2 + i * 0.15, Math.sin(a) * 2.4)
          coin.rotation.z = Math.PI / 2.3
          group.add(coin)
        }
      }
    } else if (type === 'gold' && hasAsset('chest')) {
      const chest = cloneAsset('chest')
      chest.scale.setScalar(2.4)
      chest.position.y = -1.2
      group.add(chest)
    } else {
      const orb = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.3, 1),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      )
      orb.userData.owned = true
      group.add(orb)
    }

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._tex, color, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    glow.scale.set(9, 9, 1)
    group.add(glow)

    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, 30, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    )
    pillar.position.y = 15
    pillar.userData.owned = true
    group.add(pillar)

    this.scene.add(group)
    this.items.set(id, {
      id, type, x, z, amount, group,
      ttl: type === 'gold' ? GOLD_TTL : Infinity,
      bobSeed: (typeof id === 'string' ? id.length * 1.7 : id),
    })
  }

  _remove(id, sparkle = false) {
    const item = this.items.get(id)
    if (!item) return
    if (sparkle) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._tex, color: 0xffffff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }))
      s.position.copy(item.group.position)
      s.scale.set(14, 14, 1)
      this.scene.add(s)
      setTimeout(() => { this.scene.remove(s); s.material.dispose() }, 220)
    }
    this.scene.remove(item.group)
    item.group.traverse(o => {
      if (o.isSprite || o.userData.owned) {
        if (o.geometry) o.geometry.dispose()
        if (o.material) o.material.dispose()
      }
    })
    this.items.delete(id)
  }
}
