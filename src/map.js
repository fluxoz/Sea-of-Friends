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

    // Islands
    for (const isl of game._world.getIslands()) {
      const [mx, my] = this._toMap(isl.x, isl.z, size)
      const r = Math.max(3, isl.r / (WORLD_HALF * 2) * size)
      ctx.strokeStyle = INK
      ctx.lineWidth = 1.2
      if (isl.kind === 'atoll') {
        ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(201, 179, 112, 0.5)'; ctx.fill(); ctx.stroke()
        ctx.beginPath(); ctx.arc(mx, my, r * 0.45, 0, Math.PI * 2)
        ctx.fillStyle = '#bcd0d6'; ctx.fill()
      } else {
        ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2)
        ctx.fillStyle = media[isl.kind] ?? media.isle
        ctx.fill(); ctx.stroke()
        if (isl.kind === 'volcano') {
          ctx.fillStyle = INK
          ctx.beginPath()
          ctx.moveTo(mx, my - r * 0.9)
          ctx.lineTo(mx - r * 0.55, my + r * 0.45)
          ctx.lineTo(mx + r * 0.55, my + r * 0.45)
          ctx.closePath(); ctx.fill()
        }
      }
    }

    // Forts: little keeps — filled while the garrison stands, hollow ruins after
    if (game._forts) {
      for (const f of game._forts.list()) {
        const [mx, my] = this._toMap(f.x, f.z, size)
        ctx.strokeStyle = INK
        ctx.lineWidth = 1.4
        if (f.alive) {
          ctx.fillStyle = '#7a4a2a'
          ctx.fillRect(mx - 4, my - 4, 8, 8)
          ctx.strokeRect(mx - 4, my - 4, 8, 8)
          ctx.fillStyle = '#e8c97e'
          ctx.fillRect(mx - 1.5, my - 8, 3, 4)   // banner
        } else {
          ctx.strokeRect(mx - 4, my - 4, 8, 8)
        }
      }
    }

    // Power-ups
    if (game._powerups) {
      for (const p of game._powerups.list()) {
        const [mx, my] = this._toMap(p.x, p.z, size)
        ctx.fillStyle = '#' + POWERUP_TYPES[p.type].color.toString(16).padStart(6, '0')
        ctx.strokeStyle = INK
        ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      }
    }

    // Ghost ships
    for (const u of game._aiFleet?.units ?? []) {
      if (u.ship.hp <= 0 || u.ship.sinking) continue
      const p = u.ship.getPosition()
      this._drawShip(ctx, size, p.x, p.z, u.ship.getRotationY(), '#69d2b7', 6)
    }

    // Enemy players (their flag colours)
    game.ships.forEach((ship, peerId) => {
      if (ship.sinking || !ship.group.visible) return
      const peer = game.network?.getPeer(peerId)
      const p = ship.getPosition()
      this._drawShip(ctx, size, p.x, p.z, ship.getRotationY(), peer?.color || '#c0392b', 7)
      if (peer?.name) {
        ctx.fillStyle = INK
        ctx.font = '11px Georgia, serif'
        ctx.textAlign = 'center'
        const [mx, my] = this._toMap(p.x, p.z, size)
        ctx.fillText(peer.name, mx, my - 10)
      }
    })

    // You
    if (game.localShip) {
      const p = game.localShip.getPosition()
      this._drawShip(ctx, size, p.x, p.z, game.localShip.getRotationY(), '#b8860b', 9, true)
    }

    // Border + compass rose
    ctx.strokeStyle = INK
    ctx.lineWidth = 3
    ctx.strokeRect(4, 4, size - 8, size - 8)
    ctx.fillStyle = INK
    ctx.font = 'bold 18px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.fillText('N', size - 30, 34)
    ctx.beginPath()
    ctx.moveTo(size - 30, 44); ctx.lineTo(size - 36, 58); ctx.lineTo(size - 30, 52)
    ctx.lineTo(size - 24, 58); ctx.closePath()
    ctx.fill()
  }

  /** Heading triangle for a ship. rot 0 points north (+z / screen up). */
  _drawShip(ctx, size, x, z, rot, color, r, ring = false) {
    const [mx, my] = this._toMap(x, z, size)
    const dx =  Math.sin(rot)
    const dy = -Math.cos(rot)
    ctx.fillStyle = color
    ctx.strokeStyle = INK
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(mx + dx * r * 1.5, my + dy * r * 1.5)                       // bow
    ctx.lineTo(mx - dx * r * 0.9 - dy * r * 0.75, my - dy * r * 0.9 + dx * r * 0.75)
    ctx.lineTo(mx - dx * r * 0.9 + dy * r * 0.75, my - dy * r * 0.9 - dx * r * 0.75)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
    if (ring) {
      ctx.beginPath(); ctx.arc(mx, my, r * 1.9, 0, Math.PI * 2)
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()
    }
  }
}
