/**
 * forts.js – Island strongholds that guard treasure. Deterministic under
 * lockstep: generation is seeded, and the dynamic state (HP, reload, rebuild
 * timers) advances identically on every peer inside the fixed-timestep sim.
 */
import * as THREE from 'three'
import { makeRNG } from './world.js'
import { cloneAsset, hasAsset } from './assets.js'
import { BOLT_SPEED, solveElevation } from './combat.js'
import { dsin, dcos, datan2, dhypot } from './dmath.js'

export const FORT_MAX_HP = 80
const FORT_CHANCE  = 0.38
const MAX_FORTS    = 10
const FIRE_RANGE   = 135
const RELOAD_RANGE = [4.5, 8]
const REBUILD_SECS = 180

export class Forts {
  constructor(scene, world, combat) {
    this.scene  = scene
    this.world  = world
    this.combat = combat
    this.forts  = []
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Generation (deterministic from the world seed)
  // ──────────────────────────────────────────────────────────────────────────

  generate(seed) {
    this.clear()
    const rng = makeRNG((seed >>> 0) ^ 0xf047f047)
    for (const island of this.world.getIslands()) {
      if (this.forts.length >= MAX_FORTS) break
      if (island.kind !== 'isle' && island.kind !== 'volcano') continue
      if (rng() > FORT_CHANCE) continue
      this._buildFort(island, rng)
    }
  }

  clear() {
    for (const fort of this.forts) {
      this.scene.remove(fort.group)
      fort.group.traverse(o => {
        if (o.isMesh && o.userData.owned) {
          o.geometry.dispose()
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose())
          else o.material.dispose()
        }
      })
    }
    this.forts = []
  }

  _buildFort(island, rng) {
    const idx    = this.forts.length
    const angle  = rng() * Math.PI * 2
    const dist   = island.r * 0.62
    const x      = island.x + dcos(angle) * dist
    const z      = island.z + dsin(angle) * dist
    // Found the tower on the real terrain (fall back for legacy islands)
    const baseY  = island.heightAt ? Math.max(1.2, island.heightAt(x, z) - 0.5) : 0.9

    const group = new THREE.Group()
    group.position.set(x, baseY, z)

    const stone     = new THREE.MeshPhongMaterial({ color: 0x8b8478 })
    const stoneDark = new THREE.MeshPhongMaterial({ color: 0x6e685e })

    const tower = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 6.2, 11, 10), stone)
    tower.position.y = 5.5
    tower.castShadow = true
    tower.userData.owned = true
    group.add(tower)

    const parapet = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.2, 1.8, 10), stoneDark)
    parapet.position.y = 11.6
    parapet.userData.owned = true
    group.add(parapet)

    for (let m = 0; m < 6; m++) {
      const a = (m / 6) * Math.PI * 2
      const merlon = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 1.1), stoneDark)
      merlon.position.set(dcos(a) * 5.6, 13.2, dsin(a) * 5.6)
      merlon.rotation.y = -a
      merlon.userData.owned = true
      group.add(merlon)
    }

    // The garrison's weapon: a mounted ballista when available, else a cannon
    let cannon = null
    if (hasAsset('x-ballista')) {
      cannon = cloneAsset('x-ballista')
      cannon.position.y = 12.5
      group.add(cannon)
    } else if (hasAsset('cannon')) {
      cannon = cloneAsset('cannon')
      cannon.scale.setScalar(1.6)
      cannon.position.y = 12.4
      group.add(cannon)
    }

    this.scene.add(group)

    this.forts.push({
      id: `fort${idx}`,
      idx,
      x, z, baseY,
      r: 6.8, h: 15,
      hp: FORT_MAX_HP,
      gold: 120 + Math.floor(rng() * 16) * 10,
      lootX: island.x + dcos(angle) * (island.r + 22),
      lootZ: island.z + dsin(angle) * (island.r + 22),
      group, cannon,
      reload:   RELOAD_RANGE[0] + rng() * (RELOAD_RANGE[1] - RELOAD_RANGE[0]),
      rebuildT: 0,
      // Duck-typed "ship" interface so the combat system can target forts
      sinking: false,
      hitZone: () => 'hull',
      containsPoint(p, pad = 0) {
        const dx = p.x - this.x
        const dz = p.z - this.z
        const dy = p.y - this.baseY
        return dx * dx + dz * dz <= (this.r + pad) * (this.r + pad)
            && dy >= -1 && dy <= this.h + pad
      },
    })
  }

  targets() {
    return this.forts
      .filter(f => f.hp > 0)
      .map(f => ({ id: f.id, ship: f, isFort: true }))
  }

  list() {
    return this.forts.map(f => ({ x: f.x, z: f.z, alive: f.hp > 0 }))
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SIM: one fixed step (deterministic on every peer)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} dt  FIXED_DT
   * @param {Array<{id, pos, alive}>} players  sorted order
   * @param {import('./dmath.js').DRng} rng
   * @param {(fort, balls) => void} onFire
   * @returns {Array<{type:'fortRebuilt', fort}>} events
   */
  simStep(dt, players, rng, onFire) {
    const events = []
    const alivePlayers = players.filter(p => p.alive && !p.docked)

    for (const fort of this.forts) {
      if (fort.hp <= 0) {
        fort.rebuildT -= dt
        if (fort.rebuildT <= 0) {
          fort.hp = FORT_MAX_HP
          fort.group.visible = true
          events.push({ type: 'fortRebuilt', fort })
        }
        continue
      }

      let nearest = null, best = FIRE_RANGE
      for (const p of alivePlayers) {
        const d = dhypot(p.pos.x - fort.x, p.pos.z - fort.z)
        if (d < best) { best = d; nearest = p }
      }

      // Cosmetic: the garrison's gun tracks the nearest ship
      if (fort.cannon && nearest) {
        fort.cannon.rotation.y = datan2(nearest.pos.x - fort.x, nearest.pos.z - fort.z)
      }

      fort.reload -= dt
      if (nearest && fort.reload <= 0) {
        // A ballista looses a BOLT: faster and flatter than round shot.
        // Aim slightly short of centre so the bolt strikes the hull.
        const yaw  = datan2(nearest.pos.x - fort.x, nearest.pos.z - fort.z)
          + (rng.next() - 0.5) * 0.05
        const elev = Math.max(0.005,
          solveElevation(BOLT_SPEED, Math.max(8, best - 2), fort.baseY + 12.5)
          + (rng.next() - 0.5) * 0.02)
        const cosE = dcos(elev)
        const balls = [[
          fort.x, fort.baseY + 12.5, fort.z,
          dsin(yaw) * BOLT_SPEED * cosE,
          dsin(elev) * BOLT_SPEED,
          dcos(yaw) * BOLT_SPEED * cosE,
        ]]
        onFire(fort, balls)
        fort.reload = RELOAD_RANGE[0] + rng.next() * (RELOAD_RANGE[1] - RELOAD_RANGE[0])
      }
    }

    return events
  }

  /**
   * A cannonball struck a fort (called from the sim's hit resolution).
   * @returns {{cracked:boolean, fort?:object}}
   */
  applyBallHit(fortId, _ownerId, dmg) {
    const fort = this.forts.find(f => f.id === fortId)
    if (!fort || fort.hp <= 0) return { cracked: false }
    fort.hp = Math.max(0, fort.hp - dmg)
    if (fort.hp <= 0) {
      fort.rebuildT = REBUILD_SECS
      fort.group.visible = false
      return { cracked: true, fort }
    }
    return { cracked: false }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Snapshot / hash
  // ──────────────────────────────────────────────────────────────────────────

  save() {
    return this.forts.map(f =>
      // EXACT values only: rollback restores from snapshots constantly, and
      // any quantisation here rewrites live state → cross-peer divergence
      [f.hp, f.rebuildT, f.reload])
  }

  load(rows) {
    rows?.forEach((r, i) => {
      const fort = this.forts[i]
      if (!fort) return
      fort.hp = r[0]
      fort.rebuildT = r[1]
      fort.reload = r[2]
      fort.group.visible = fort.hp > 0
    })
  }

  hash(acc) {
    for (const f of this.forts) acc.num(f.hp).num(f.rebuildT)
  }
}
