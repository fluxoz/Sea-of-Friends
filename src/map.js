/**
 * map.js – The captain's chart: a parchment world map toggled with M.
 *
 * Draws the seeded islands, your own ship, every enemy player, the ghost
 * fleet, and active power-ups onto a 2-D canvas overlay.
 */
import { WORLD_HALF } from './world.js'
import { POWERUP_TYPES } from './powerups.js'

const INK    = '#4a3018'
const media  = { isle: '#7a9450', volcano: '#5d5348', atoll: '#c9b370', reef: '#8a8578' }

export class WorldMap {
  constructor() {
    this.open = false
    this._overlay = document.getElementById('map-overlay')
    this._canvas  = document.getElementById('map-canvas')
    this._ctx     = this._canvas ? this._canvas.getContext('2d') : null
    this._lastDraw = 0
  }

  toggle() { this.setOpen(!this.open) }

  setOpen(open) {
    this.open = open
    if (this._overlay) this._overlay.style.display = open ? 'flex' : 'none'
  }

  /** Redraw at ~10 fps while open. Called every frame from the game loop. */
  update(game) {
    if (!this.open || !this._ctx) return
    const now = performance.now()
    if (now - this._lastDraw < 100) return
    this._lastDraw = now
    this._draw(game)
  }

  // ──────────────────────────────────────────────────────────────────────────

  _toMap(x, z, size) {
    // +z is north (screen up), +x east (screen right)
    return [
      (x + WORLD_HALF) / (WORLD_HALF * 2) * size,
      size - (z + WORLD_HALF) / (WORLD_HALF * 2) * size,
    ]
  }

  _draw(game) {
    const ctx  = this._ctx
    const size = this._canvas.width
    const k    = size / 620   // marker/font scale relative to the old chart

    // Parchment ground
    ctx.clearRect(0, 0, size, size)
    const bg = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.75)
    bg.addColorStop(0, '#ead9ab')
    bg.addColorStop(1, '#d3ba85')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, size, size)

    // Grid of "chart lines"
    ctx.strokeStyle = 'rgba(74, 48, 24, 0.16)'
    ctx.lineWidth = 1
    const cells = 9
    for (let i = 1; i < cells; i++) {
      const p = (i / cells) * size
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke()
    }

    // Islands: true topography sampled from each island's height function —
    // the same terrain the sim collides with, banded like a survey chart
    this._renderTerrain(game, size)
    if (this._terrain) ctx.drawImage(this._terrain, 0, 0)

    // Trading ports — an anchor marks each neutral cove
    for (const port of game.ports?.list ?? []) {
      const [mx, my] = this._toMap(port.x, port.z, size)
      ctx.font = `bold ${13 * k}px Georgia, serif`
      ctx.textAlign = 'center'
      ctx.fillStyle = '#8a5c14'
      ctx.fillText('⚓', mx, my + 4 * k)
      ctx.font = `${9 * k}px Georgia, serif`
      ctx.fillText(port.name, mx, my + 15 * k)
    }

    // Forts: little keeps — filled while the garrison stands, hollow ruins after
    if (game._forts) {
      for (const f of game._forts.list()) {
        const [mx, my] = this._toMap(f.x, f.z, size)
        ctx.strokeStyle = INK
        ctx.lineWidth = 1.4 * k
        if (f.alive) {
          ctx.fillStyle = '#7a4a2a'
          ctx.fillRect(mx - 4 * k, my - 4 * k, 8 * k, 8 * k)
          ctx.strokeRect(mx - 4 * k, my - 4 * k, 8 * k, 8 * k)
          ctx.fillStyle = '#e8c97e'
          ctx.fillRect(mx - 1.5 * k, my - 8 * k, 3 * k, 4 * k)   // banner
        } else {
          ctx.strokeRect(mx - 4 * k, my - 4 * k, 8 * k, 8 * k)
        }
      }
    }

    // Power-ups
    if (game._powerups) {
      for (const p of game._powerups.list()) {
        const [mx, my] = this._toMap(p.x, p.z, size)
        ctx.fillStyle = '#' + POWERUP_TYPES[p.type].color.toString(16).padStart(6, '0')
        ctx.strokeStyle = INK
        ctx.beginPath(); ctx.arc(mx, my, 3.5 * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      }
    }

    // Ghost ships
    for (const u of game._aiFleet?.units ?? []) {
      if (u.ship.hp <= 0 || u.ship.sinking) continue
      const p = u.ship.getPosition()
      this._drawShip(ctx, size, p.x, p.z, u.ship.getRotationY(), '#69d2b7', 6 * k)
    }

    // Enemy players (their flag colours)
    game.ships.forEach((ship, peerId) => {
      if (ship.sinking || !ship.group.visible) return
      const peer = game.network?.getPeer(peerId)
      const p = ship.getPosition()
      this._drawShip(ctx, size, p.x, p.z, ship.getRotationY(), peer?.color || '#c0392b', 7 * k)
      if (peer?.name) {
        ctx.fillStyle = INK
        ctx.font = `${11 * k}px Georgia, serif`
        ctx.textAlign = 'center'
        const [mx, my] = this._toMap(p.x, p.z, size)
        ctx.fillText(peer.name, mx, my - 10 * k)
      }
    })

    // You
    if (game.localShip) {
      const p = game.localShip.getPosition()
      this._drawShip(ctx, size, p.x, p.z, game.localShip.getRotationY(), '#b8860b', 9 * k, true)
    }

    // Border + compass rose
    ctx.strokeStyle = INK
    ctx.lineWidth = 3 * k
    ctx.strokeRect(4 * k, 4 * k, size - 8 * k, size - 8 * k)
    ctx.fillStyle = INK
    ctx.font = `bold ${18 * k}px Georgia, serif`
    ctx.textAlign = 'center'
    ctx.fillText('N', size - 30 * k, 34 * k)
    ctx.beginPath()
    ctx.moveTo(size - 30 * k, 44 * k); ctx.lineTo(size - 36 * k, 58 * k); ctx.lineTo(size - 30 * k, 52 * k)
    ctx.lineTo(size - 24 * k, 58 * k); ctx.closePath()
    ctx.fill()
  }

  /**
   * Bake the topographic island layer once per world: elevation bands
   * (shoal → sand → grass → upland → rock → peak) sampled from heightAt,
   * with an ink coastline. Atoll rings, lagoons, lobed bays, and volcano
   * calderas all emerge from the real terrain.
   */
  _renderTerrain(game, size) {
    const seed = game.sim?.seed ?? 0
    if (this._terrain && this._terrainSeed === seed && this._terrain.width === size) return
    this._terrainSeed = seed
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    const c = cv.getContext('2d')
    const img = c.createImageData(size, size)
    const px = img.data
    const BANDS = [
      [0.4, 214, 194, 140],   // beach sand
      [3.4, 136, 170, 96],    // grass
      [10,  104, 140, 78],    // upland
      [20,  128, 118, 100],   // rock
      [34,  178, 172, 158],   // peak
    ]
    // Cartographic license: islands draw at MAG× their true footprint —
    // at honest scale they are 3px specks with no topography to show
    const MAG = 2.5
    const unitsPerPx = (WORLD_HALF * 2) / size
    for (const isl of game._world.getIslands()) {
      if (!isl.heightAt) {
        continue
      }
      const [mcx, mcy] = this._toMap(isl.x, isl.z, size)
      const half = Math.ceil(isl.r * 1.4 * MAG / (WORLD_HALF * 2) * size) + 1
      const x0 = Math.max(0, mcx - half | 0), x1 = Math.min(size - 1, mcx + half | 0)
      const y0 = Math.max(0, mcy - half | 0), y1 = Math.min(size - 1, mcy + half | 0)
      for (let py = y0; py <= y1; py++) {
        const wz = isl.z - (py - mcy) * unitsPerPx / MAG
        for (let pxx = x0; pxx <= x1; pxx++) {
          const h = isl.heightAt(isl.x + (pxx - mcx) * unitsPerPx / MAG, wz)
          const o = (py * size + pxx) * 4
          if (h <= 0.4) {
            // shoal / lagoon wash
            if (h > -4.5 && px[o + 3] === 0) {
              px[o] = 158; px[o + 1] = 196; px[o + 2] = 192; px[o + 3] = 110
            }
            continue
          }
          let col = BANDS[0]
          for (const b of BANDS) if (h >= b[0]) col = b
          px[o] = col[1]; px[o + 1] = col[2]; px[o + 2] = col[3]; px[o + 3] = 255
        }
      }
    }
    // Ink coastline: land pixels bordering water get the chart pen
    const land = i => px[i * 4 + 3] === 255
    for (let py = 1; py < size - 1; py++) {
      for (let pxx = 1; pxx < size - 1; pxx++) {
        const i = py * size + pxx
        if (!land(i)) continue
        if (!land(i - 1) || !land(i + 1) || !land(i - size) || !land(i + size)) {
          const o = i * 4
          px[o] = 74; px[o + 1] = 48; px[o + 2] = 24
        }
      }
    }
    c.putImageData(img, 0, 0)
    this._terrain = cv
  }

  /** A little ship seen from above: hull, deck line, and a square sail —
   *  bow points along the heading. rot 0 = north (+z / screen up). */
  _drawShip(ctx, size, x, z, rot, color, r, ring = false) {
    const [mx, my] = this._toMap(x, z, size)
    const s = r / 7
    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(rot)
    ctx.scale(s, s)
    ctx.lineWidth = 1.2 / s
    ctx.strokeStyle = INK
    // hull: pointed bow, rounded stern
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(0, -8)
    ctx.quadraticCurveTo(4.6, -3, 4.2, 3.4)
    ctx.quadraticCurveTo(2.6, 5.6, 0, 5.6)
    ctx.quadraticCurveTo(-2.6, 5.6, -4.2, 3.4)
    ctx.quadraticCurveTo(-4.6, -3, 0, -8)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
    // square sail across the beam
    ctx.fillStyle = 'rgba(250, 246, 232, 0.92)'
    ctx.beginPath()
    ctx.moveTo(-4.4, -1.6)
    ctx.quadraticCurveTo(0, -4.4, 4.4, -1.6)
    ctx.quadraticCurveTo(0, -0.2, -4.4, -1.6)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
    ctx.restore()
    if (ring) {
      ctx.beginPath(); ctx.arc(mx, my, r * 1.9, 0, Math.PI * 2)
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()
    }
  }
}
