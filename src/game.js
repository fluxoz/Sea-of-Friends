/**
 * game.js – Three.js scene, camera, input, game loop.
 */
import * as THREE from 'three'
import { Ship, MAX_SHIP_SPEED } from './ship.js'
import { World, waveHeight }   from './world.js'

const SEND_RATE = 80   // ms between network position broadcasts

export class Game {
  constructor(canvas) {
    this.canvas   = canvas
    this.localShip  = null
    this.network    = null
    this.ships      = new Map()   // peerId → Ship
    this.labelEls   = new Map()   // peerId → HTMLElement

    this._chatMode   = false
    this._lastSend   = 0
    this._lastTime   = 0
    this._keys       = {}
    this._camTheta   = 0            // horizontal offset from ship heading
    this._camPhi     = 0.32         // vertical angle (radians)
    this._camDist    = 28
    this._dragMouse  = false
    this._lastMX     = 0
    this._lastMY     = 0

    // Public callbacks
    this.onPlayerCountChange = null
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────────────────────────────────

  init() {
    this._setupRenderer()
    this._setupScene()
    this._setupCamera()
    this._setupLights()

    this._world = new World(this._scene)
    this._world.build()

    this._setupInput()
    window.addEventListener('resize', () => this._onResize())
  }

  _setupRenderer() {
    this._renderer = new THREE.WebGLRenderer({
      canvas:    this.canvas,
      antialias: true,
    })
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this._renderer.setSize(window.innerWidth, window.innerHeight)
    this._renderer.toneMapping         = THREE.ACESFilmicToneMapping
    this._renderer.toneMappingExposure = 0.85
    this._renderer.shadowMap.enabled   = true
    this._renderer.shadowMap.type      = THREE.PCFSoftShadowMap
  }

  _setupScene() {
    this._scene = new THREE.Scene()
    this._scene.fog = new THREE.FogExp2(0x88ccff, 0.00065)
  }

  _setupCamera() {
    this._camera = new THREE.PerspectiveCamera(
      62, window.innerWidth / window.innerHeight, 0.3, 2800,
    )
  }

  _setupLights() {
    // Directional sun
    const sun = new THREE.DirectionalLight(0xfff8e7, 2.2)
    sun.position.set(300, 400, -600)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near   = 1
    sun.shadow.camera.far    = 800
    sun.shadow.camera.left   = -200
    sun.shadow.camera.right  = 200
    sun.shadow.camera.top    = 200
    sun.shadow.camera.bottom = -200
    this._scene.add(sun)

    // Sky / fill
    this._scene.add(new THREE.HemisphereLight(0x88ccff, 0x003355, 0.9))
  }

  _setupInput() {
    document.addEventListener('keydown', e => {
      if (this._chatMode) return
      this._keys[e.code] = true
    })
    document.addEventListener('keyup', e => {
      this._keys[e.code] = false
    })

    // Pointer-lock for desktop mouse-look
    this.canvas.addEventListener('click', () => {
      if (!this._chatMode) this.canvas.requestPointerLock()
    })
    document.addEventListener('pointerlockchange', () => {
      this._pointerLocked = document.pointerLockElement === this.canvas
    })
    document.addEventListener('mousemove', e => {
      if (this._pointerLocked) {
        this._camTheta -= e.movementX * 0.0028
        this._camPhi    = Math.max(0.08, Math.min(1.2, this._camPhi - e.movementY * 0.0028))
      }
    })

    // Touch / mouse drag as fallback
    const onDown = e => {
      const { clientX: x, clientY: y } = e.touches ? e.touches[0] : e
      this._dragMouse = true
      this._lastMX    = x
      this._lastMY    = y
    }
    const onMove = e => {
      if (!this._dragMouse || this._pointerLocked) return
      const { clientX: x, clientY: y } = e.touches ? e.touches[0] : e
      this._camTheta -= (x - this._lastMX) * 0.004
      this._camPhi    = Math.max(0.08, Math.min(1.2, this._camPhi - (y - this._lastMY) * 0.004))
      this._lastMX = x
      this._lastMY = y
    }
    const onUp = () => { this._dragMouse = false }

    this.canvas.addEventListener('mousedown',  onDown)
    this.canvas.addEventListener('mousemove',  onMove)
    this.canvas.addEventListener('mouseup',    onUp)
    this.canvas.addEventListener('touchstart', onDown, { passive: true })
    this.canvas.addEventListener('touchmove',  onMove, { passive: true })
    this.canvas.addEventListener('touchend',   onUp)

    // Scroll to zoom
    this.canvas.addEventListener('wheel', e => {
      this._camDist = Math.max(10, Math.min(80, this._camDist + e.deltaY * 0.05))
    }, { passive: true })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Start (called after name entry)
  // ──────────────────────────────────────────────────────────────────────────

  start(playerName, color, network) {
    this.network = network

    this.localShip = new Ship(this._scene, playerName, color, true)
    this.localShip.position.set(0, 0, 0)

    // ── Network event handlers ────────────────────────────────────────────
    network.onPeerJoin = peerId => {
      if (!this.ships.has(peerId)) {
        const peer = network.getPeer(peerId)
        this._addRemoteShip(peerId, peer?.name || peerId.slice(0, 8), peer?.color)
      }
      this._notifyCount()
    }

    network.onPeerLeave = peerId => {
      this._removeRemoteShip(peerId)
      this._notifyCount()
    }

    network.onPeerInfo = (peerId, data) => {
      let ship = this.ships.get(peerId)
      if (!ship) {
        ship = this._addRemoteShip(peerId, data.name, data.color)
      } else {
        ship.setName(data.name)
        this._updateLabel(peerId, data.name)
      }
    }

    network.onPeerPosition = (peerId, data) => {
      let ship = this.ships.get(peerId)
      if (!ship) {
        const peer = network.getPeer(peerId)
        ship = this._addRemoteShip(peerId, peer?.name || peerId.slice(0, 8), peer?.color)
      }
      ship.setTargetPosition(data.p[0], data.p[1], data.p[2])
      ship.setTargetRotation(data.r)
    }

    network.setLocalInfo(playerName, '#' + color.toString(16).padStart(6, '0'))

    this._animate()
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Remote ship helpers
  // ──────────────────────────────────────────────────────────────────────────

  _addRemoteShip(peerId, name, colorStr) {
    const color = colorStr
      ? parseInt(colorStr.replace('#', ''), 16)
      : (Math.random() * 0xffffff | 0)
    const ship  = new Ship(this._scene, name, color, false)
    this.ships.set(peerId, ship)
    this._createLabel(peerId, name)
    return ship
  }

  _removeRemoteShip(peerId) {
    const ship = this.ships.get(peerId)
    if (ship) { ship.destroy(); this.ships.delete(peerId) }
    this._removeLabel(peerId)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Name labels (HTML overlays projected from 3D)
  // ──────────────────────────────────────────────────────────────────────────

  _createLabel(peerId, name) {
    const el = document.createElement('div')
    el.className  = 'player-label'
    el.textContent = name
    document.body.appendChild(el)
    this.labelEls.set(peerId, el)
  }

  _updateLabel(peerId, name) {
    const el = this.labelEls.get(peerId)
    if (el) el.textContent = name
  }

  _removeLabel(peerId) {
    const el = this.labelEls.get(peerId)
    if (el) el.remove()
    this.labelEls.delete(peerId)
  }

  _updateAllLabels() {
    this.ships.forEach((ship, peerId) => {
      const el = this.labelEls.get(peerId)
      if (!el) return

      const worldPos = ship.getPosition().clone()
      worldPos.y += 20            // above the masthead

      const ndc = worldPos.project(this._camera)
      if (ndc.z > 1) {            // behind camera
        el.style.display = 'none'
        return
      }
      el.style.display = 'block'
      el.style.left = `${(ndc.x * 0.5 + 0.5) * window.innerWidth}px`
      el.style.top  = `${(-ndc.y * 0.5 + 0.5) * window.innerHeight}px`
    })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Main loop
  // ──────────────────────────────────────────────────────────────────────────

  _animate() {
    requestAnimationFrame(() => this._animate())

    const now = performance.now()
    const dt  = Math.min((now - (this._lastTime || now)) / 1000, 0.05)
    this._lastTime = now

    this._world.tick(dt)

    if (this.localShip) {
      this._updateLocalShip(dt)
      this._updateRemoteShips(dt)
      this._updateCamera()
      this._sendPosition(now)
      this._updateHUD()
    }

    this._updateAllLabels()
    this._renderer.render(this._scene, this._camera)
  }

  _updateLocalShip(dt) {
    const k = this._keys
    const thrust = (k['KeyW'] || k['ArrowUp']   ? 1 : 0)
                 + (k['KeyS'] || k['ArrowDown']  ? -0.35 : 0)
    const turn   = (k['KeyA'] || k['ArrowLeft']  ? 1 : 0)
                 + (k['KeyD'] || k['ArrowRight']  ? -1 : 0)

    this.localShip.updateLocal(dt, thrust, turn)

    const p = this.localShip.getPosition()
    this.localShip.setWaveHeight(waveHeight(p.x, p.z, this._world.getTime()))
  }

  _updateRemoteShips(dt) {
    const t = this._world.getTime()
    this.ships.forEach(ship => {
      ship.updateRemote(dt)
      const p = ship.getPosition()
      ship.setWaveHeight(waveHeight(p.x, p.z, t))
    })
  }

  _updateCamera() {
    const shipPos = this.localShip.getPosition()
    const heading = this.localShip.getRotationY()

    // Orbit around ship: theta is relative to ship heading
    const theta = heading + this._camTheta + Math.PI
    const phi   = this._camPhi
    const d     = this._camDist

    const target = new THREE.Vector3(
      shipPos.x + Math.sin(theta) * Math.cos(phi) * d,
      shipPos.y + Math.sin(phi) * d + 4,
      shipPos.z + Math.cos(theta) * Math.cos(phi) * d,
    )
    this._camera.position.lerp(target, 0.12)
    this._camera.lookAt(shipPos.x, shipPos.y + 3, shipPos.z)
  }

  _sendPosition(now) {
    if (now - this._lastSend < SEND_RATE) return
    this._lastSend = now
    if (this.network) {
      this.network.sendPosition(
        this.localShip.getPosition(),
        this.localShip.getRotationY(),
        this.localShip.getNormalisedSpeed(),
      )
    }
  }

  _updateHUD() {
    // Compass
    const heading  = ((-this.localShip.getRotationY() * 180 / Math.PI) % 360 + 360) % 360
    const dirs     = ['N','NE','E','SE','S','SW','W','NW']
    const compass  = document.getElementById('compass')
    if (compass) {
      compass.textContent = dirs[Math.round(heading / 45) % 8]
        + '  ' + Math.round(heading) + '°'
    }

    // Speed bar
    const fill = document.getElementById('speed-fill-inner')
    if (fill) {
      fill.style.width = `${Math.max(0, this.localShip.getNormalisedSpeed() * 100)}%`
    }

    // Peer count
    const countEl = document.getElementById('peer-count')
    if (countEl) {
      const n = this.getPlayerCount()
      countEl.textContent = `⚓ ${n} sailor${n !== 1 ? 's' : ''}`
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  getPlayerCount() { return this.ships.size + 1 }

  setChatMode(active) {
    this._chatMode = active
    if (active && document.pointerLockElement) document.exitPointerLock()
  }

  _notifyCount() {
    if (this.onPlayerCountChange) this.onPlayerCountChange()
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight
    this._camera.aspect = w / h
    this._camera.updateProjectionMatrix()
    this._renderer.setSize(w, h)
  }
}
