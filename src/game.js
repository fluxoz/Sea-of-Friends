/**
 * game.js – Rendering, input capture, camera, and UI on top of the lockstep
 * simulation.
 *
 * Division of labour:
 *   • sim.js owns ALL gameplay state and advances it deterministically at
 *     20 Hz from everyone's inputs (driven by lockstep.js).
 *   • This file renders that state at display rate with interpolation,
 *     captures local input once per tick, and paints the HUD/overlays.
 *   • The lockstep pump runs on a timer, not rAF, so the sim keeps ticking
 *     (and our inputs keep flowing to the crew) while the tab is unfocused.
 */
import * as THREE from 'three'
import { CANNON_REST_ELEVATION, MAX_SHIP_SPEED } from './ship.js'
import { World, waveHeight } from './world.js'
import {
  Combat, BALL_SPEED, BALL_GRAVITY, RELOAD_TIME,
  DEFAULT_ELEVATION, MAX_ELEVATION, MIN_ELEVATION, MAX_TRAVERSE, BOW_TRAVERSE,
  getSoftTexture,
} from './combat.js'
import { SFX } from './sfx.js'
import { AIFleet, aiDisplayName } from './ai.js'
import { Powerups, POWERUP_TYPES } from './powerups.js'
import { Forts } from './forts.js'
import { WorldMap } from './map.js'
import { Sim, FIXED_DT, TICK_MS } from './sim.js'
import { APP_VERSION } from './network.js'
import { Lockstep } from './lockstep.js'

/** Points used to draw the aim-mode trajectory preview. */
const AIM_DOTS = 48

export class Game {
  constructor(canvas) {
    this.canvas  = canvas
    this.network = null
    this.sim     = null
    this.lockstep = null

    // Label / bubble DOM overlays, keyed by pid
    this.labelEls   = new Map()
    this.nameEls    = new Map()
    this.latencyEls = new Map()
    this.chatBubbleEls = new Map()
    this._localBubble  = null

    this._chatMode  = false
    this._keys      = {}
    this._camTheta  = 0
    this._camPhi    = 0.32
    this._camDist   = 28
    this._dragMouse = false
    this._lastMX    = 0
    this._lastMY    = 0
    this._lastRender = 0
    this._playing    = false   // own ship live in the sim

    // Cannon aiming (hold RMB)
    this._aimActive   = false
    this._aimElev     = DEFAULT_ELEVATION
    this._aimSide     = 1
    this._aimTraverse = 0
    this._fireQueued  = false

    this._map  = new WorldMap()
    this._sfx  = new SFX()
    /** pids whose voice + chat we don't want to hear (render/audio side) */
    this.muted = new Set()
    /** votekick tallies: targetPid → Map(voterPid → wall ms) */
    this._votes = new Map()
    this._desyncCounts = new Map()
    this.onKicked = null
    this._menuSeed = (Math.random() * 0xffffffff) >>> 0
    this._menuTime = 0
    this._lastHud  = 0
    this._lastThudMsg = { waterline: 0, rigging: 0 }
    this._lastDesyncMsg = 0
    this._localColor = 0xc8a96e

    // Public callbacks
    this.onSystemMessage = null
    /** @type {import('./audio.js').ProximityAudio|null} */
    this._audio = null
  }

  // ── Convenience accessors over the sim ────────────────────────────────────

  get localShip() {
    return this.sim?.players.get(this.network?.selfId)?.ship ?? null
  }

  get localPlayer() {
    return this.sim?.players.get(this.network?.selfId) ?? null
  }

  /** Other captains' ships, keyed by pid (built on demand — render-side only). */
  get ships() {
    const out = new Map()
    if (this.sim) {
      for (const [pid, p] of this.sim.players) {
        if (pid !== this.network?.selfId) out.set(pid, p.ship)
      }
    }
    return out
  }

  get _world()    { return this.world }
  get _aiFleet()  { return this.aiFleet }
  get _forts()    { return this.forts }
  get _powerups() { return this.powerups }

  // ──────────────────────────────────────────────────────────────────────────
  // Init
  // ──────────────────────────────────────────────────────────────────────────

  init() {
    this._setupRenderer()
    this._setupScene()
    this._setupCamera()
    this._setupLights()

    this.world = new World(this._scene)
    this.world.build()
    this._combat   = new Combat(this._scene, this._sfx)
    this.aiFleet   = new AIFleet(this._scene, this.world, this._combat)
    this.forts     = new Forts(this._scene, this.world, this._combat)
    this.powerups  = new Powerups(this._scene, this.world)

    // Menu backdrop world; becomes the real world if we found the room
    this.world.buildIslands(this._menuSeed)
    this.forts.generate(this._menuSeed)

    this._setupInput()
    window.addEventListener('resize', () => this._onResize())
    this._render()
  }

  _setupRenderer() {
    // Antialiasing comes from our OWN multisampled framebuffer, not the
    // browser's antialiased default framebuffer. The browser-managed MSAA
    // canvas takes a driver/compositor-specific resolve path that some
    // stacks get wrong (frames land offset in the canvas); an explicit
    // render target is resolved by a plain in-API blit and behaves the
    // same on every system.
    this._renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false })
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this._renderer.setSize(window.innerWidth, window.innerHeight)
    this._renderer.toneMapping         = THREE.ACESFilmicToneMapping
    this._renderer.toneMappingExposure = 0.85
    this._renderer.shadowMap.enabled   = true
    this._renderer.shadowMap.type      = THREE.PCFSoftShadowMap
    this._setupMsaaTarget()
    // A lost GL context silently freezes the canvas while the game keeps
    // running — preventDefault allows the browser to restore it, and a full
    // resize pass resyncs the viewport once it comes back
    this.canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault()
      console.warn('[render] WebGL context lost')
    })
    this.canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[render] WebGL context restored')
      this._onResize()
    })
  }

  /** Scene renders into this 4x-MSAA target; a copy pass puts it on screen. */
  _setupMsaaTarget() {
    const ratio = this._renderer.getPixelRatio()
    const w = Math.floor(window.innerWidth * ratio)
    const h = Math.floor(window.innerHeight * ratio)
    // WebGL1 has no multisampled renderbuffers; samples is ignored there
    // and the pipeline degrades gracefully to an aliased offscreen pass
    this._rt = new THREE.WebGLRenderTarget(w, h, {
      samples: this._renderer.capabilities.isWebGL2 ? 4 : 0,
      depthBuffer: true,
    })
    // Tone mapping + sRGB happen while the scene is drawn into the target
    // (materials apply them per-fragment), so the copy must be a raw blit:
    // mark the texture as already-sRGB and keep the quad un-tonemapped.
    this._rt.texture.colorSpace = THREE.SRGBColorSpace
    this._copyScene = new THREE.Scene()
    this._copyCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: this._rt.texture, toneMapped: false }),
    )
    this._copyScene.add(quad)
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
    // Without a bias, surfaces at grazing sun angles self-shadow into
    // diagonal acne stripes (one shadow texel ≈ 0.2 world units here);
    // normalBias pushes the sample off the surface along its normal
    sun.shadow.bias       = -0.0002
    sun.shadow.normalBias = 0.7
    this._scene.add(sun)
    this._scene.add(sun.target)
    this._sun = sun

    this._scene.add(new THREE.HemisphereLight(0x88ccff, 0x003355, 0.9))
  }

  _setupInput() {
    document.addEventListener('keydown', e => {
      if (this._chatMode) return
      if (e.code === 'KeyM' && this._playing && !e.repeat) {
        e.preventDefault()
        this._map.toggle()
        return
      }
      if (e.code === 'Escape' && this._map.open) {
        this._map.setOpen(false)
        return
      }
      this._keys[e.code] = true
    })
    document.addEventListener('keyup', e => { this._keys[e.code] = false })

    this.canvas.addEventListener('click', () => {
      if (!this._chatMode && !this._aimActive) this.canvas.requestPointerLock()
    })
    document.addEventListener('pointerlockchange', () => {
      this._pointerLocked = document.pointerLockElement === this.canvas
    })
    this.canvas.addEventListener('contextmenu', e => e.preventDefault())

    document.addEventListener('mousemove', e => {
      if (!this._pointerLocked) return
      // movementX/Y can be undefined or a giant bogus jump right after the
      // pointer lock engages — either would poison the orbit angles for good
      const mx = Number.isFinite(e.movementX) ? Math.max(-200, Math.min(200, e.movementX)) : 0
      const my = Number.isFinite(e.movementY) ? Math.max(-200, Math.min(200, e.movementY)) : 0
      this._camTheta -= mx * 0.0028
      if (this._aimActive) {
        this._aimElev = Math.max(MIN_ELEVATION,
          Math.min(MAX_ELEVATION, this._aimElev - my * 0.0022))
      } else {
        this._camPhi = Math.max(0.08, Math.min(1.2, this._camPhi - my * 0.0028))
      }
    })

    const onDown = e => {
      if (!e.touches && e.button === 2) {
        if (!this._chatMode) this._aimActive = true
        return
      }
      if (!e.touches && e.button === 0 && this._aimActive) {
        this._fireQueued = true
        return
      }
      const { clientX: x, clientY: y } = e.touches ? e.touches[0] : e
      this._dragMouse = true
      this._lastMX = x
      this._lastMY = y
    }
    const onMove = e => {
      if (this._pointerLocked) return
      const { clientX: x, clientY: y } = e.touches ? e.touches[0] : e
      if (this._aimActive && !e.touches) {
        this._camTheta -= (e.movementX ?? 0) * 0.0028
        this._aimElev = Math.max(MIN_ELEVATION,
          Math.min(MAX_ELEVATION, this._aimElev - (e.movementY ?? 0) * 0.0022))
        return
      }
      if (!this._dragMouse) return
      this._camTheta -= (x - this._lastMX) * 0.004
      this._camPhi    = Math.max(0.08, Math.min(1.2, this._camPhi - (y - this._lastMY) * 0.004))
      this._lastMX = x
      this._lastMY = y
    }
    const onUp = e => {
      if (!e.touches && e.button === 2) { this._aimActive = false; return }
      this._dragMouse = false
    }

    this.canvas.addEventListener('mousedown',  onDown)
    document.addEventListener('mousemove',     onMove)
    document.addEventListener('mouseup',       onUp)
    this.canvas.addEventListener('touchstart', onDown, { passive: true })
    this.canvas.addEventListener('touchmove',  onMove, { passive: true })
    this.canvas.addEventListener('touchend',   onUp)

    this.canvas.addEventListener('wheel', e => {
      // Min 16: any closer and the look-at point (hull) diverges so far from
      // the ship's visual centre (masts) that the ship rides off the frame
      this._camDist = Math.max(16, Math.min(80, this._camDist + e.deltaY * 0.05))
    }, { passive: true })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Start (called after name entry)
  // ──────────────────────────────────────────────────────────────────────────

  start(playerName, color, network, shipClass = 'frigate') {
    this.network = network
    this._localColor = color
    this._shipClass  = shipClass
    this._sfx.init()

    // ── The deterministic simulation ───────────────────────────────────────
    this.sim = new Sim(
      {
        scene: this._scene, world: this.world, combat: this._combat,
        aiFleet: this.aiFleet, forts: this.forts, powerups: this.powerups,
        sfx: this._sfx,
      },
      {
        selfId: network.selfId,
        // Rollback re-simulates ticks, so feed lines and local UI events can
        // be emitted twice for the same tick (or emitted only on the confirmed
        // pass). Dedup on (tick, content): first emission wins, replays are
        // swallowed, and events prediction missed still fire at confirm time.
        feed: text => {
          if (this._eventGate(`f:${this.sim.tick}:${text}`)) this.onSystemMessage?.(text)
        },
        resolveName: id => this._resolveName(id),
        onLocal: ev => {
          const key = `l:${this.sim.tick}:${ev.type}:${ev.zone ?? ''}:${ev.killer ?? ''}`
          if (this._eventGate(key)) this._onLocalSimEvent(ev)
        },
      },
    )
    this._eventKeys = new Set()

    // ── Lockstep netcode ───────────────────────────────────────────────────
    this.lockstep = new Lockstep(network, {
      found: () => {
        // Nobody else holds this sea — resume our saved copy if we have one,
        // otherwise chart fresh waters. The sea persists in localStorage per
        // room code: the last captain ashore keeps the world.
        const saved = this._loadSavedSea()
        if (saved) {
          this.sim.restore(saved.state)
          // The saved crew isn't here — clear their ships quietly (no purse
          // drops, no feed spam) and come aboard ourselves
          for (const p of this.sim.players.values()) p.ship.destroy()
          this.sim.players.clear()
          this.sim.addPlayer(network.selfId, this._shipClass)
          if (saved.self?.name === playerName) {
            const me = this.sim.players.get(network.selfId)
            me.gold = saved.self.gold | 0
            me.k = saved.self.k | 0
            me.d = saved.self.d | 0
          }
          this.onSystemMessage?.(
            `🗺 Familiar waters — resuming your sea (world ${(saved.state.seed >>> 0).toString(16)})`)
          return { seed: saved.state.seed, foundedAt: saved.foundedAt, resumeTick: saved.state.tick }
        }
        const foundedAt = Date.now()
        this.sim.found(this._menuSeed, foundedAt)
        this.sim.addPlayer(network.selfId, this._shipClass)
        this.onSystemMessage?.(
          `🗺 New seas charted — world ${this._menuSeed.toString(16)} (yours to share)`)
        return { seed: this._menuSeed, foundedAt }
      },
      executeTick: (t, inputs, cmds) => {
        this._sfx.beginTick(t)
        try {
          this.sim.step(t, inputs, cmds.map(c => c.j ? { j: c.j, c: c.c } : c.p ? { p: c.p } : { d: c.d }))
        } finally {
          this._sfx.endTick()
        }
      },
      getSnapshot:  () => this.sim.snapshot(),
      rollback:     snap => this.sim.restoreFast(snap),
      loadSnapshot: snap => {
        this.sim.restore(snap)
        this._applyAllCosmetics()
        this.onSystemMessage?.(
          `🗺 Charts received from the crew — world ${(snap.seed >>> 0).toString(16)}`)
      },
      getHash: () => this.sim.hash(),
      getHashParts: () => this.sim.lastHashParts ?? null,
      onStall: blockers => this._showStall(blockers),
      onDesync: (pid, tick, ownParts, theirParts) => {
        // Forensics first (always, even while the feed is throttled): name
        // the diverged subsystem and keep a downloadable evidence bundle.
        const guilty = ownParts && theirParts
          ? Object.keys(ownParts).filter(k => ownParts[k] !== theirParts[k])
          : []
        if (!this._desyncBundle) {
          this._desyncBundle = {
            version: APP_VERSION, tick, peer: pid, guilty,
            ownParts, theirParts,
            confirmedSnap: this.lockstep?._confirmedSnap ?? null,
            recentInputs: [...(this.lockstep?.inputs ?? new Map())].map(([id, buf]) =>
              [id, [...buf.entries()].filter(([t]) => t > tick - 80)]),
            capturedAt: new Date().toISOString(),
          }
          window.__desyncBundle = this._desyncBundle
          console.error('[desync] diverged subsystems:', guilty.join(', ') || 'unknown',
            '— bundle at window.__desyncBundle')
        }
        const now = performance.now()
        if (now - this._lastDesyncMsg < 30000) return
        this._lastDesyncMsg = now
        const what = guilty.length ? ` (diverged: ${guilty.join(', ')})` : ''
        this.onSystemMessage?.(
          `⚠ DESYNC: ${this._resolveName(pid)}'s sea disagrees with yours at tick ${tick}${what} — `
          + `/desync downloads the evidence bundle`)
        const n = (this._desyncCounts.get(pid) ?? 0) + 1
        this._desyncCounts.set(pid, n)
        if (n === 3) {
          this.onSystemMessage?.(
            `⚖ ${this._resolveName(pid)}'s sea keeps disagreeing — a modified client? `
            + `/votekick ${this._resolveName(pid)} to put it to the crew`)
        }
      },
      onKicked: () => {
        this.onSystemMessage?.('⚖ The crew has voted you off the ship.')
        this.onKicked?.()
      },
      onSelfJoined: () => {
        this._playing = true
        this._setOverlay(null)
        // Frame the ship immediately — never inherit the menu orbit's pose
        this._snapCameraToShip()
        // Announce cosmetics so everyone tints our flag
        this.localShip?.setFlagColor(this._localColor)
        setTimeout(() => this._spawnDiagnostic('spawn'), 1500)
        clearInterval(this._diagTimer)
        if (location.search.includes('debug')) {
          this._diagTimer = setInterval(() => this._spawnDiagnostic('tick'), 5000)
        }
      },
      onState: state => {
        if (state === 'joining') this._setOverlay('📜 Receiving charts from the crew…')
        else if (state === 'running' && !this._playing) this._setOverlay('⚓ Coming aboard…')
      },
    })
    this.lockstep.shipClass = shipClass
    this._setOverlay('🗺 Looking for yer crew on the DHT…')

    // The pump runs on a timer so ticks keep flowing when the tab is hidden
    // (rAF stops entirely in background tabs; a stalled peer stalls the crew)
    this._pumpTimer = setInterval(() => {
      this.lockstep.pump(() => this._captureInput())
    }, 25)

    // Persist the sea: the last captain ashore keeps the world
    this._saveTimer = setInterval(() => this._saveSea(), 10000)

    // Opt-in session board: the orderer heartbeats this sea's listing
    this._boardTimer = setInterval(() => {
      if (!this.listPublicly || !this._playing) return
      if (this.lockstep?._orderer() !== this.network.selfId) return
      fetch('https://sea-of-friends-signal.fluxoz.workers.dev/board/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room: this.network.roomId,
          players: this.lockstep._activeCount(),
          age: this.sim.tick,
          v: APP_VERSION,
        }),
      }).catch(() => { /* board down — the sea sails on */ })
    }, 30000)
    this._onPageHide = () => this._saveSea()
    window.addEventListener('pagehide', this._onPageHide)

    // ── Out-of-band peer channels (cosmetic) ───────────────────────────────
    this._nameCache = new Map()
    network.onPeerInfo = (pid, data) => {
      if (data?.name) this._nameCache.set(pid, data.name)
      this._applyCosmetics(pid, data)
    }
    network.setLocalInfo(playerName, '#' + color.toString(16).padStart(6, '0'))

    network.onVote = (pid, data) => {
      if (data?.t) this._tallyVote(pid, data.t)
    }
  }

  // ── Sea persistence ────────────────────────────────────────────────────────

  _seaKey() { return 'sof-sea:' + (this.network?.roomId ?? 'world-1') }

  /** Write the confirmed world state to localStorage (per room code). */
  _saveSea() {
    const snap = this.lockstep?._confirmedSnap
    if (!snap || this.lockstep.state !== 'running' || !this._playing) return
    try {
      const meRow = snap.players.find(r => r.id === this.network.selfId)
      localStorage.setItem(this._seaKey(), JSON.stringify({
        v: 1,
        foundedAt: this.lockstep.foundedAt,
        savedAt: Date.now(),
        self: meRow
          ? { name: this.network.getLocalName?.() ?? '', gold: meRow.g, k: meRow.k, d: meRow.d }
          : null,
        state: snap,
      }))
    } catch { /* storage full or blocked — the sea just isn't persisted */ }
  }

  _loadSavedSea() {
    try {
      const raw = localStorage.getItem(this._seaKey())
      if (!raw) return null
      const saved = JSON.parse(raw)
      if (saved?.v !== 1 || !saved.state || typeof saved.state.seed !== 'number'
          || typeof saved.state.tick !== 'number' || !Array.isArray(saved.state.players)) {
        return null
      }
      return saved
    } catch { return null }
  }

  /** One-shot gate for sim events that rollback re-simulation could repeat. */
  _eventGate(key) {
    if (this._eventKeys.has(key)) return false
    this._eventKeys.add(key)
    if (this._eventKeys.size > 600) {
      const keys = [...this._eventKeys]
      this._eventKeys = new Set(keys.slice(keys.length >> 1))
    }
    return true
  }

  /** Names/colours arrive out-of-band; apply them to sim ships when both exist. */
  _applyCosmetics(pid, data) {
    const p = this.sim?.players.get(pid)
    if (!p || !data) return
    if (data.name) {
      p.ship.setName(data.name)
      this._updateLabel(pid, data.name)
    }
    if (data.color) {
      p.ship.setFlagColor(parseInt(String(data.color).replace('#', ''), 16))
    }
  }

  _applyAllCosmetics() {
    if (!this.sim) return
    for (const pid of this.sim.players.keys()) {
      if (pid === this.network.selfId) {
        this.localShip?.setFlagColor(this._localColor)
      } else {
        this._applyCosmetics(pid, this.network.getPeer(pid))
      }
    }
  }

  /** Display name for a pid, an AI ship, or a fort. */
  _resolveName(id) {
    if (!id) return 'The sea'
    if (id === this.network?.selfId) return this.network.getLocalName() ?? 'You'
    if (String(id).startsWith('ai')) return aiDisplayName(id)
    if (String(id).startsWith('fort')) return "A fort's garrison"
    const peer = this.network?.getPeer(id)
    return peer?.name || this._nameCache?.get(id) || String(id).slice(0, 8)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Input capture (once per lockstep tick)
  // ──────────────────────────────────────────────────────────────────────────

  /** Which battery the camera is looking across: 'bow', port (1), starboard (-1). */
  _cameraBattery() {
    const me = this.localShip
    if (!me) return this._aimSide
    const p = me.group.position
    const lookYaw = Math.atan2(p.x - this._camera.position.x, p.z - this._camera.position.z)
    let rel = lookYaw - me.rotationY
    while (rel >  Math.PI) rel -= Math.PI * 2
    while (rel < -Math.PI) rel += Math.PI * 2
    if (Math.abs(rel) < 0.6 && (me.bowGuns ?? 0) > 0) return 'bow'
    const sn = Math.sin(rel)
    if (Math.abs(sn) > 0.2) this._aimSide = sn > 0 ? 1 : -1
    return this._aimSide
  }

  _captureInput() {
    const k = this._keys
    // A/D crank the wheel (the sim integrates it into a persistent rudder);
    // holding both recentres the wheel
    const left  = k['KeyA'] || k['ArrowLeft']
    const right = k['KeyD'] || k['ArrowRight']
    const input = {
      s: (k['KeyW'] || k['ArrowUp'] ? 1 : 0) + (k['KeyS'] || k['ArrowDown'] ? -1 : 0),
      n: (left ? 1 : 0) + (right ? -1 : 0),
    }
    if (left && right) input.z = 1
    if (k['KeyS'] || k['ArrowDown']) input.r = 1

    const setFire = battery => {
      if (battery === 'bow') input.b = 1
      else if (battery === 1) input.p = 1
      else input.q = 1
    }

    if (this._aimActive && this._playing) {
      // Aimed fire: LMB / Q / E / Space all fire the camera-facing battery
      if (this._fireQueued || k['KeyQ'] || k['KeyE'] || k['Space']) {
        setFire(this._aimBattery ?? this._aimSide)
        input.e = Math.round(this._aimElev * 1000)
        input.v = Math.round(this._aimTraverse * 1000)
      }
    } else {
      // Space fires whichever battery the camera faces; Q/E stay explicit
      if (k['Space']) setFire(this._cameraBattery())
      if (k['KeyQ']) input.p = 1
      if (k['KeyE']) input.q = 1
    }
    this._fireQueued = false
    return input
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Render loop (rAF — pure presentation)
  // ──────────────────────────────────────────────────────────────────────────

  _render() {
    requestAnimationFrame(() => this._render())
    try {
      this._renderFrame()
    } catch (err) {
      // Never let one bad frame freeze the canvas for good — log (throttled)
      // and keep the loop alive so the next frame can recover
      const now = performance.now()
      if (!this._lastRenderErr || now - this._lastRenderErr > 2000) {
        this._lastRenderErr = now
        console.error('[render]', err)
      }
    }
  }

  _renderFrame() {
    const now = performance.now()
    const dtR = Math.min((now - (this._lastRender || now)) / 1000, 0.1)
    this._lastRender = now

    // FPS counter (render-side only; the element is shown via settings)
    this._fpsFrames = (this._fpsFrames || 0) + 1
    if (now - (this._fpsStamp || 0) > 500) {
      if (this._fpsEl === undefined) this._fpsEl = document.getElementById('fps-counter')
      if (this._fpsEl && this._fpsEl.style.display !== 'none') {
        const fps = this._fpsFrames / ((now - (this._fpsStamp || now - 500)) / 1000)
        this._fpsEl.textContent = `${Math.round(fps)} fps`
      }
      this._fpsStamp  = now
      this._fpsFrames = 0
    }

    const running = this.lockstep?.state === 'running'
    let alpha = 1, waveTime

    if (running) {
      const wallTick = (now - this.lockstep.startWall) / TICK_MS
      alpha = Math.max(0, Math.min(1, wallTick - this.lockstep.executed))
      waveTime = Math.max(0, (this.lockstep.executed - 1 + alpha)) * FIXED_DT
      this.world.setTime(waveTime)
    } else {
      this.world.tick(dtR)
      waveTime = this.world.getTime()
    }

    // Ships
    if (this.sim) {
      for (const p of this.sim.players.values()) {
        p.ship.renderUpdate(dtR, alpha, waveTime)
      }
      for (const u of this.aiFleet.units) {
        u.ship.renderUpdate(dtR, alpha, waveTime)
      }
      this._combat.renderStep(dtR, alpha)
      this.powerups.renderStep(dtR, waveTime)
      this._updateWakes(waveTime)
    }

    const me = this.localShip
    if (this._playing && me) {
      this._updateAimVisuals()
      this._updateCamera(me, dtR)
      this._updateHUD(now)
      this._map.update(this)
      this._updateAudioVolumes()

      const p = me.group.position
      this.world.setFocus(p.x, p.z)
      const TEXEL = 400 / 2048
      const sx = Math.round(p.x / TEXEL) * TEXEL
      const sz = Math.round(p.z / TEXEL) * TEXEL
      this._sun.position.set(sx + 300, 400, sz - 600)
      this._sun.target.position.set(sx, 0, sz)

      // Spawn-protection blink
      const lp = this.localPlayer
      if (lp && !me.sinking) {
        me.group.visible = lp.invulnT <= 0 || Math.sin(now * 0.02) > -0.3
      }
    } else {
      this._updateMenuCamera(dtR)
    }

    this._updateAllLabels()
    this._updateLocalBubble()
    // Scene → MSAA target (Three resolves it with an explicit blit), then a
    // plain copy to the never-multisampled canvas — uniform on every system
    this._renderer.setRenderTarget(this._rt)
    this._renderer.render(this._scene, this._camera)
    this._renderer.setRenderTarget(null)
    this._renderer.render(this._copyScene, this._copyCam)
  }

  /** Slow cinematic orbit around the nearest island while on the menu. */
  _updateMenuCamera(dt) {
    this._menuTime += dt
    const isl = this.world.getIslands()[0]
    const cx  = isl ? isl.x : 0
    const cz  = isl ? isl.z : 0
    const R   = isl ? isl.r + 110 : 90
    const a   = this._menuTime * 0.045
    const px  = cx + Math.cos(a) * R
    const pz  = cz + Math.sin(a) * R
    this._camera.position.set(px, 16 + Math.sin(this._menuTime * 0.3) * 2, pz)
    this._camera.lookAt(cx, isl ? 6 : 2, cz)
    this.world.setFocus(px, pz)
    this._sun.position.set(px + 300, 400, pz - 600)
    this._sun.target.position.set(px, 0, pz)
  }

  /** Exact follow-cam position for the ship's current pose (no damping). */
  _cameraTargetFor(me, shipPos = me.group.position) {
    const theta = me.rotationY + this._camTheta + Math.PI
    const phi   = this._camPhi
    const d     = this._camDist
    return new THREE.Vector3(
      shipPos.x + Math.sin(theta) * Math.cos(phi) * d,
      shipPos.y + Math.sin(phi) * d + 4,
      shipPos.z + Math.cos(theta) * Math.cos(phi) * d,
    )
  }

  /** Where the camera aims: hull height at range, nearer the rig up close
   *  (a fixed low aim point pushes the ship off-frame as the zoom tightens). */
  _lookHeight() {
    return 3 + Math.max(0, 28 - this._camDist) * 0.25
  }

  /** Put the camera exactly on station behind the ship, instantly. */
  _snapCameraToShip() {
    const me = this.localShip
    if (!me) return
    this._camTheta = 0
    this._camPhi   = 0.32
    this._camDist  = 28   // a fresh deck always gets the default framing
    // Right after a spawn the render group hasn't been placed yet — anchor
    // on the sim position, which is authoritative the moment the ship exists
    const p = me.position
    this._camera.position.copy(this._cameraTargetFor(me, p))
    this._camera.lookAt(p.x, p.y + this._lookHeight(), p.z)
  }

  _updateCamera(me, dtR) {
    // Self-heal: bad orbit state or a poisoned camera position would otherwise
    // stick forever (lerp propagates NaN, and every later frame inherits it)
    if (!Number.isFinite(this._camTheta) || !Number.isFinite(this._camPhi)
        || !Number.isFinite(this._camDist)
        || !Number.isFinite(this._camera.position.x + this._camera.position.y + this._camera.position.z)) {
      this._snapCameraToShip()
      return
    }

    const shipPos = me.group.position
    const target  = this._cameraTargetFor(me)
    // Frame-rate-independent damping (a per-frame constant stutters at
    // uneven fps and inherits any residual sim jitter). If the camera is
    // far off station (spawn, respawn, teleport), snap instead of easing
    // across the map.
    if (this._camera.position.distanceTo(target) > 120) {
      this._camera.position.copy(target)
    } else {
      this._camera.position.lerp(target, 1 - Math.exp(-dtR * 10))
    }
    this._camera.lookAt(shipPos.x, shipPos.y + this._lookHeight(), shipPos.z)

    // Sense of speed: the FOV opens up as the ship gathers way
    const spd = Math.max(0, me.speed) / MAX_SHIP_SPEED
    const targetFov = 62 + spd * 11
    this._fov = (this._fov ?? 62) + (targetFov - (this._fov ?? 62)) * (1 - Math.exp(-dtR * 3))
    if (Math.abs(this._camera.fov - this._fov) > 0.01) {
      this._camera.fov = this._fov
      this._camera.updateProjectionMatrix()
    }
  }

  /** Foam wake + bow spray behind every moving ship (render-only). */
  _updateWakes(waveTime) {
    const spawnFor = ship => {
      if (!ship.group.visible || ship.sinking) return
      const p = ship.group.position
      if (!ship._wakePrev) { ship._wakePrev = p.clone(); return }
      ship._wakeAcc = (ship._wakeAcc || 0)
        + Math.hypot(p.x - ship._wakePrev.x, p.z - ship._wakePrev.z)
      ship._wakePrev.copy(p)
      if (ship._wakeAcc < 4.5) return
      ship._wakeAcc = 0

      const rot = ship.rotationY
      const fwd = { x: Math.sin(rot), z: Math.cos(rot) }
      // Spray grows with speed — a ship at full clip throws a real bow wave
      const spd = Math.min(1, Math.abs(ship.speed) / MAX_SHIP_SPEED)
      const bow = new THREE.Vector3(
        p.x + fwd.x * ship.halfLength * 0.85, 0, p.z + fwd.z * ship.halfLength * 0.85)
      bow.y = waveHeight(bow.x, bow.z, waveTime) + 0.25
      this._combat.foam(bow, 0.6 + spd * 1.1)
      const stern = new THREE.Vector3(
        p.x - fwd.x * ship.halfLength * 0.9, 0, p.z - fwd.z * ship.halfLength * 0.9)
      stern.y = waveHeight(stern.x, stern.z, waveTime) + 0.2
      this._combat.foam(stern, 1.0 + spd * 1.3)
    }
    if (this.sim) {
      for (const p of this.sim.players.values()) spawnFor(p.ship)
      for (const u of this.aiFleet.units) spawnFor(u.ship)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Aiming (render-side; the FIRE input carries the chosen elevation)
  // ──────────────────────────────────────────────────────────────────────────

  _ensureAimObjects() {
    if (this._aimArc) return
    // A solid tube arc, not dots: dots vanish at far zoom, and WebGL can't
    // draw thick lines. The tube's radius scales with camera distance so
    // the arc reads at any zoom.
    this._aimArc = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xff5a3c, transparent: true, opacity: 0.95,
        depthWrite: false, depthTest: false, fog: false,
      }),
    )
    this._aimArc.renderOrder = 5
    this._aimArc.frustumCulled = false
    this._aimArc.visible = false
    this._scene.add(this._aimArc)
    this._aimPts = Array.from({ length: AIM_DOTS }, () => new THREE.Vector3())

    this._aimRing = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 2.2, 24),
      new THREE.MeshBasicMaterial({
        color: 0xff5a3c, transparent: true, opacity: 0.85,
        depthWrite: false, depthTest: false, fog: false,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    )
    this._aimRing.renderOrder = 5
    this._aimRing.rotation.x = -Math.PI / 2
    this._aimRing.visible = false
    this._scene.add(this._aimRing)
  }

  _updateAimVisuals() {
    this._ensureAimObjects()
    const me = this.localShip
    if (!me || !this._aimActive || me.sinking) {
      this._aimArc.visible = false
      this._aimRing.visible = false
      if (me) {
        for (const b of [1, -1, 'bow']) {
          me.setCannonElevation(b, CANNON_REST_ELEVATION)
          me.setCannonTraverse(b, 0)
        }
      }
      return
    }

    const heading = me.rotationY
    const p = me.group.position
    const lookYaw = Math.atan2(p.x - this._camera.position.x, p.z - this._camera.position.z)
    let rel = lookYaw - heading
    while (rel >  Math.PI) rel -= Math.PI * 2
    while (rel < -Math.PI) rel += Math.PI * 2

    // Battery follows the camera: dead ahead = bow chasers, else broadsides
    let battery
    if (Math.abs(rel) < 0.6 && (me.bowGuns ?? 0) > 0) {
      battery = 'bow'
    } else {
      const sn = Math.sin(rel)
      if (Math.abs(sn) > 0.2) this._aimSide = sn > 0 ? 1 : -1
      battery = this._aimSide
    }
    this._aimBattery = battery

    // Windage: traverse toward the exact look direction, clamped per battery
    let baseAngle, maxTrav
    if (battery === 'bow') { baseAngle = heading; maxTrav = BOW_TRAVERSE }
    else { baseAngle = heading + battery * Math.PI / 2; maxTrav = MAX_TRAVERSE }
    let traverse = lookYaw - baseAngle
    while (traverse >  Math.PI) traverse -= Math.PI * 2
    while (traverse < -Math.PI) traverse += Math.PI * 2
    this._aimTraverse = Math.max(-maxTrav, Math.min(maxTrav, traverse))

    for (const b of [1, -1, 'bow']) {
      me.setCannonElevation(b, b === battery ? this._aimElev : CANNON_REST_ELEVATION)
      me.setCannonTraverse(b, b === battery ? this._aimTraverse : 0)
    }

    // Trajectory preview (cosmetic — sim recomputes the real volley)
    const rot  = heading
    const fwd  = { x: Math.sin(rot), z: Math.cos(rot) }
    const yaw  = baseAngle + this._aimTraverse
    const cosE = Math.cos(this._aimElev)
    const lp   = this.localPlayer
    const v    = BALL_SPEED * (lp && lp.ammoShots > 0 ? 1.35 : 1)

    // The arc starts at the battery's actual muzzle (following the barrel's
    // swivel and elevation), not the hull centre
    let x, y, z
    if (!this._muzzleTmp) this._muzzleTmp = new THREE.Vector3()
    const muzzle = me.getMuzzleWorld(battery, this._muzzleTmp)
    if (muzzle) {
      x = muzzle.x; y = muzzle.y; z = muzzle.z
    } else if (battery === 'bow') {
      x = p.x + fwd.x * me.halfLength * 0.7
      z = p.z + fwd.z * me.halfLength * 0.7
      y = p.y + me.deckHeight
    } else {
      const sideAngle = rot + battery * Math.PI / 2
      x = p.x + Math.sin(sideAngle) * (me.halfWidth + 0.8)
      z = p.z + Math.cos(sideAngle) * (me.halfWidth + 0.8)
      y = p.y + me.deckHeight
    }
    let vx = Math.sin(yaw) * v * cosE + fwd.x * me.speed
    let vz = Math.cos(yaw) * v * cosE + fwd.z * me.speed
    let vy = Math.sin(this._aimElev) * v

    const time = this.world.getTime()
    const STEP = 0.055
    let count  = 0
    for (let i = 0; i < AIM_DOTS; i++) {
      vy -= BALL_GRAVITY * STEP
      x += vx * STEP; y += vy * STEP; z += vz * STEP
      const w = waveHeight(x, z, time)
      this._aimPts[i].set(x, Math.max(y, w + 0.15), z)
      count++
      if (y <= w) break
    }
    if (count >= 2) {
      const curve = new THREE.CatmullRomCurve3(this._aimPts.slice(0, count))
      const radius = 0.3 + this._camDist * 0.02
      const tube = new THREE.TubeGeometry(curve, Math.max(8, count * 2), radius, 6, false)
      this._aimArc.geometry.dispose()
      this._aimArc.geometry = tube
      this._aimArc.visible = true
    } else {
      this._aimArc.visible = false
    }
    this._aimRing.position.set(x, waveHeight(x, z, time) + 0.3, z)
    this._aimRing.visible = true
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Local sim events → UI
  // ──────────────────────────────────────────────────────────────────────────

  _onLocalSimEvent(ev) {
    const now = performance.now()
    switch (ev.type) {
      case 'hit': {
        this._sfx.localHit()
        this._flashVignette()
        if (ev.bolt) {
          this._sfx.ripSail(0)
          if (now - this._lastThudMsg.rigging > 3000) {
            this._lastThudMsg.rigging = now
            this.onSystemMessage?.('🏹 A ballista bolt tears through your rigging!')
          }
        }
        if (ev.zone === 'waterline' && now - this._lastThudMsg.waterline > 3000) {
          this._lastThudMsg.waterline = now
          this.onSystemMessage?.('🌊 Holed at the waterline — taking on water!')
        } else if (ev.zone === 'rigging') {
          this._sfx.ripSail(0)
          if (now - this._lastThudMsg.rigging > 3000) {
            this._lastThudMsg.rigging = now
            this.onSystemMessage?.('⛵ Rigging shot through — losing speed!')
          }
        }
        break
      }
      case 'sunk': {
        const overlay = document.getElementById('sunk-overlay')
        const sunkBy  = document.getElementById('sunk-by')
        if (overlay) overlay.style.display = 'flex'
        if (sunkBy)  sunkBy.textContent = `Sunk by ${this._resolveName(ev.killer)}`
        break
      }
      case 'respawn': {
        const overlay = document.getElementById('sunk-overlay')
        if (overlay) overlay.style.display = 'none'
        this._sfx.respawn()
        this._snapCameraToShip()
        break
      }
    }
  }

  /**
   * Spawn/periodic sanity report: does the visible hull actually sit where
   * the camera is aimed, and what ELSE ship-shaped is on screen? Logged to
   * the console, POSTed to the dev server's /__diag collector, and shown
   * on screen. This exists to chase a camera-offset report that never
   * reproduces headless — remove once the culprit is caught.
   */
  _spawnDiagnostic(tag = 'spawn') {
    const me = this.localShip
    if (!me || !this._playing) return
    const gp  = me.group.position
    const box = new THREE.Box3().setFromObject(me.group)
    const c   = box.getCenter(new THREE.Vector3())
    const cam = this._camera.position
    const ndc = c.clone().project(this._camera)
    const gl  = this._renderer.getContext()
    const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info')
    const gpu = dbgInfo ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) : 'n/a'
    const size = this._renderer.getSize(new THREE.Vector2())
    const rect = this._renderer.domElement.getBoundingClientRect()

    // Every ship-like thing in the scene, with where it lands on screen —
    // if a mystery hull is pinned in a corner, this names it
    const ships = []
    const addShip = (label, obj, visible = true) => {
      const p = new THREE.Vector3()
      obj.getWorldPosition(p)
      const n = p.clone().project(this._camera)
      ships.push({
        label,
        pos: { x: +p.x.toFixed(0), y: +p.y.toFixed(1), z: +p.z.toFixed(0) },
        ndc: { x: +n.x.toFixed(2), y: +n.y.toFixed(2), z: +n.z.toFixed(3) },
        distToCam: +cam.distanceTo(p).toFixed(1),
        visible,
      })
    }
    if (this.sim) {
      for (const [pid, p] of this.sim.players) {
        addShip((pid === this.network?.selfId ? 'SELF:' : 'player:') + String(pid).slice(0, 6),
          p.ship.group, p.ship.group.visible)
      }
    }
    for (const u of this.aiFleet?.units ?? []) addShip('ai:' + u.id, u.ship.group, u.ship.group.visible)
    this._scene.traverse(o => {
      const nm = (o.name || '').toLowerCase()
      if (o.isMesh && (nm.includes('ship') || nm.includes('boat'))) {
        let top = o
        while (top.parent && top.parent !== this._scene) top = top.parent
        if (!ships.some(s => s.label === 'scene:' + nm)) addShip('scene:' + nm, o, o.visible)
      }
    })

    const report = {
      tag, t: Math.round(performance.now() / 1000),
      simPos:   { x: +me.position.x.toFixed(1), y: +me.position.y.toFixed(1), z: +me.position.z.toFixed(1) },
      groupPos: { x: +gp.x.toFixed(1), y: +gp.y.toFixed(1), z: +gp.z.toFixed(1) },
      meshCenter: { x: +c.x.toFixed(1), y: +c.y.toFixed(1), z: +c.z.toFixed(1) },
      meshOnScreen: { x: +ndc.x.toFixed(2), y: +ndc.y.toFixed(2) },
      cam: { x: +cam.x.toFixed(1), y: +cam.y.toFixed(1), z: +cam.z.toFixed(1) },
      orbit: { theta: +this._camTheta.toFixed(2), phi: +this._camPhi.toFixed(2), d: +this._camDist.toFixed(1) },
      cls: this._shipClass, heading: +me.rotationY.toFixed(2),
      playing: this._playing, aim: this._aimActive, locked: this._pointerLocked,
      camFov: +this._camera.fov.toFixed(1), camAspect: +this._camera.aspect.toFixed(3),
      rendererSize: { w: size.x, h: size.y }, pixelRatio: +this._renderer.getPixelRatio().toFixed(2),
      buffer: { w: this._renderer.domElement.width, h: this._renderer.domElement.height },
      glViewport: Array.from(gl.getParameter(gl.VIEWPORT)),
      glScissor: { box: Array.from(gl.getParameter(gl.SCISSOR_BOX)), on: !!gl.isEnabled(gl.SCISSOR_TEST) },
      threeViewport: this._renderer.getViewport(new THREE.Vector4()).toArray(),
      ctxLost: gl.isContextLost(),
      canvasRect: { w: +rect.width.toFixed(0), h: +rect.height.toFixed(0), x: +rect.x.toFixed(0), y: +rect.y.toFixed(0) },
      win: { w: window.innerWidth, h: window.innerHeight, dpr: +window.devicePixelRatio.toFixed(2) },
      gpu: String(gpu).slice(0, 80),
      ships,
    }
    console.log('[spawn-diagnostic]', JSON.stringify(report))
    try { fetch('/__diag', { method: 'POST', body: JSON.stringify(report) }).catch(() => {}) } catch { /* dev-only */ }

    if (!location.search.includes('debug')) return
    let el = document.getElementById('diag-panel')
    if (!el) {
      el = document.createElement('pre')
      el.id = 'diag-panel'
      el.style.cssText = 'position:fixed;left:8px;top:80px;z-index:9999;background:rgba(0,0,0,0.75);'
        + 'color:#8f8;font:11px monospace;padding:8px;max-width:40em;white-space:pre-wrap;border-radius:4px'
      document.body.appendChild(el)
    }
    el.textContent = '⚓ diagnostic (' + tag + ')  ship@screen x:' + ndc.x.toFixed(2)
      + ' y:' + ndc.y.toFixed(2) + '  zoom:' + this._camDist.toFixed(0)
      + '\n' + ships.map(s => `${s.label} ndc ${s.ndc.x},${s.ndc.y} d${s.distToCam}${s.visible ? '' : ' HIDDEN'}`).join('\n')
  }

  _flashVignette() {
    const el = document.getElementById('damage-vignette')
    if (!el) return
    el.style.opacity = '1'
    clearTimeout(this._vignetteTimer)
    this._vignetteTimer = setTimeout(() => { el.style.opacity = '0' }, 120)
  }

  _setOverlay(text) {
    const el = document.getElementById('waiting-overlay')
    if (!el) return
    if (text === null) { el.style.display = 'none'; return }
    el.style.display = 'flex'
    el.querySelector('#waiting-text').textContent = text
  }

  _showStall(blockers) {
    if (!blockers || blockers.length === 0) {
      if (this._stallShown) { this._stallShown = false; if (this._playing) this._setOverlay(null) }
      return
    }
    this._stallShown = true
    const names = blockers.map(b => this._resolveName(b)).join(', ')
    this._setOverlay(`⚓ Waiting for the crew… (${names})`)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HUD (10 Hz)
  // ──────────────────────────────────────────────────────────────────────────

  _updateHUD(now) {
    if (now - this._lastHud < 100) return
    this._lastHud = now
    const me = this.localShip
    const lp = this.localPlayer
    if (!me || !lp) return

    // Compass
    const heading  = ((-me.rotationY * 180 / Math.PI) % 360 + 360) % 360
    const dirs     = ['N','NE','E','SE','S','SW','W','NW']
    const compass  = document.getElementById('compass')
    if (compass) {
      compass.textContent = dirs[Math.round(heading / 45) % 8]
        + '  ' + Math.round(heading) + '°'
    }

    // Speed / sails / wind
    const wind = this.sim.wind
    const effColor = eff => eff >= 1.0 ? '#7ddc6e' : eff > 0.6 ? '#c8a96e' : '#e07050'
    const fill = document.getElementById('speed-fill-inner')
    if (fill) {
      fill.style.width = `${Math.max(0, me.getNormalisedSpeed() * 100)}%`
      fill.style.background = effColor(me._eff)
    }
    const sailText = document.getElementById('sail-text')
    if (sailText) {
      if (me._inIrons && me.sail > 0.05) {
        sailText.textContent = '⚠ IN IRONS'
        sailText.style.color = '#e07050'
      } else {
        sailText.textContent =
          `SAILS ${Math.round(me.sail * 100)}% · ${Math.round(Math.abs(me.speed))}kn`
        sailText.style.color = ''
      }
    }
    const windArrow = document.getElementById('wind-arrow')
    if (windArrow && wind) {
      const rel = wind.dir - me.rotationY
      windArrow.style.transform = `rotate(${-90 - rel * 180 / Math.PI}deg)`
      windArrow.style.color = effColor(me._eff)
    }
    const windSpeedEl = document.getElementById('wind-speed')
    if (windSpeedEl && wind) windSpeedEl.textContent = `${Math.round(wind.speed)}kn`

    // Health
    const hpFill = document.getElementById('hp-fill-inner')
    if (hpFill) {
      const t = me.hp / me.maxHp
      hpFill.style.width = `${Math.max(0, t * 100)}%`
      hpFill.style.background = t > 0.55 ? '#4caf50' : t > 0.28 ? '#f0a020' : '#f44336'
    }
    const hpText = document.getElementById('hp-text')
    if (hpText) hpText.textContent = `${Math.max(0, Math.round(me.hp))}`

    // Rudder / wheel indicator
    const rudderEl = document.getElementById('rudder-marker')
    if (rudderEl) {
      rudderEl.style.left = `${(1 - (lp.rudder + 1) / 2) * 100}%`
      rudderEl.style.background = Math.abs(lp.rudder) < 0.06 ? '#7ddc6e' : '#e8c97e'
    }

    // Reload
    for (const [key, maxKey, elId] of [
      ['reloadP', 'reloadMaxP', 'reload-q'], ['reloadS', 'reloadMaxS', 'reload-e'],
      ['reloadB', 'reloadMaxB', 'reload-b'],
    ]) {
      const el = document.getElementById(elId)
      if (!el) continue
      if (elId === 'reload-b') el.style.display = (me.bowGuns ?? 0) > 0 ? '' : 'none'
      const inner = el.querySelector('.reload-fill')
      const t = 1 - Math.max(0, lp[key]) / (lp[maxKey] || RELOAD_TIME)
      if (inner) inner.style.width = `${t * 100}%`
      el.classList.toggle('ready', t >= 1)
    }

    // Buffs + battle damage status
    const statusEl = document.getElementById('status-row')
    if (statusEl) {
      const bits = []
      if (lp.buffReload > 0) bits.push(`🔵 ${Math.ceil(lp.buffReload)}s`)
      if (lp.buffArmor > 0)  bits.push(`🛡 ${Math.ceil(lp.buffArmor)}s`)
      if (lp.ammoShots > 0)  bits.push(`🔴 ×${lp.ammoShots}`)
      if (lp.autoShots > 0)  bits.push(`🎯 ×${lp.autoShots}`)
      const leaks = me.activeLeaks()
      if (leaks) bits.push(`🌊 LEAK ×${leaks}`)
      const rig = me.activeRigDamage()
      if (rig) bits.push(`⛵ RIG ×${rig}`)
      statusEl.textContent = bits.join('   ')
    }

    // Gold + respawn countdown
    const goldEl = document.getElementById('gold-count')
    if (goldEl) goldEl.textContent = `🪙 ${lp.gold}`
    if (me.sinking) {
      const countEl = document.getElementById('respawn-count')
      if (countEl) countEl.textContent = `Respawning in ${Math.max(0, Math.ceil(lp.respawnT))}…`
    }

    // Peer count + crew list
    const countEl = document.getElementById('peer-count')
    if (countEl) {
      const n = this.sim.players.size
      countEl.textContent = `⚓ ${n} sailor${n !== 1 ? 's' : ''}`
    }

    const listEl = document.getElementById('latency-list')
    if (listEl) {
      listEl.style.display = 'block'
      const upsertRow = (rowId, name, cols, pid) => {
        let row = listEl.querySelector(`[data-peer="${CSS.escape(rowId)}"]`)
        if (!row) {
          row = document.createElement('div')
          row.className = 'latency-row'
          row.dataset.peer = rowId
          const nameSpan = document.createElement('span')
          nameSpan.className = 'latency-row-name'
          row.appendChild(nameSpan)
          row._nameSpan = nameSpan
          row._cols = ['k', 'd', 'g', 'ms'].map(cls => {
            const span = document.createElement('span')
            span.className = 'latency-row-' + cls
            row.appendChild(span)
            return span
          })
          const actions = document.createElement('span')
          actions.className = 'latency-row-actions'
          if (pid) {
            const muteBtn = document.createElement('button')
            muteBtn.className = 'crew-mute'
            muteBtn.title = 'Mute their voice and chat'
            muteBtn.textContent = '🔇'
            muteBtn.addEventListener('click', () => this.toggleMute(pid))
            const kickBtn = document.createElement('button')
            kickBtn.className = 'crew-kick'
            kickBtn.title = 'Vote to kick this captain'
            kickBtn.textContent = '☠'
            kickBtn.addEventListener('click', () => this.castVote(pid))
            actions.appendChild(muteBtn)
            actions.appendChild(kickBtn)
            row._muteBtn = muteBtn
          }
          row.appendChild(actions)
          listEl.appendChild(row)
        }
        row._nameSpan.textContent = name
        cols.forEach((v, i) => { row._cols[i].textContent = v })
        if (row._muteBtn) row._muteBtn.classList.toggle('active', this.muted.has(pid))
      }

      const seen = new Set()
      for (const [pid, p] of this.sim.players) {
        const isMe = pid === this.network.selfId
        const rowId = isMe ? '__local' : pid
        seen.add(rowId)
        const peer = isMe ? null : this.network.getPeer(pid)
        upsertRow(
          rowId,
          isMe ? (this.network.getLocalName() ?? 'You') : (peer?.name || pid.slice(0, 8)),
          [p.k, p.d, p.gold,
            isMe ? '—' : (peer?.latency !== undefined ? `${peer.latency}ms` : '—')],
          isMe ? null : pid,
        )
      }
      listEl.querySelectorAll('.latency-row[data-peer]').forEach(row => {
        if (!seen.has(row.dataset.peer)) row.remove()
      })
    }

    // Label reconcile (create/remove for other captains)
    const labelSeen = new Set()
    for (const [pid] of this.sim.players) {
      if (pid === this.network.selfId) continue
      labelSeen.add(pid)
      if (!this.labelEls.has(pid)) {
        this._createLabel(pid, this._resolveName(pid))
      }
    }
    for (const pid of [...this.labelEls.keys()]) {
      if (!labelSeen.has(pid)) this._removeLabel(pid)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Name labels & chat bubbles (HTML overlays)
  // ──────────────────────────────────────────────────────────────────────────

  _createLabel(pid, name) {
    const el = document.createElement('div')
    el.className = 'player-label'
    const nameEl = document.createElement('span')
    nameEl.className = 'label-name'
    nameEl.textContent = name
    el.appendChild(nameEl)
    const latencyEl = document.createElement('span')
    latencyEl.className = 'label-latency'
    el.appendChild(latencyEl)
    document.body.appendChild(el)
    this.labelEls.set(pid, el)
    this.nameEls.set(pid, nameEl)
    this.latencyEls.set(pid, latencyEl)
  }

  _updateLabel(pid, name) {
    const nameEl = this.nameEls.get(pid)
    if (nameEl) nameEl.textContent = name
  }

  _removeLabel(pid) {
    this.labelEls.get(pid)?.remove()
    this.labelEls.delete(pid)
    this.nameEls.delete(pid)
    this.latencyEls.delete(pid)
    const bubble = this.chatBubbleEls.get(pid)
    if (bubble) {
      clearTimeout(bubble.timer)
      bubble.el.remove()
      this.chatBubbleEls.delete(pid)
    }
  }

  _updateAllLabels() {
    for (const [pid, el] of this.labelEls) {
      const p = this.sim?.players.get(pid)
      if (!p || !p.ship.group.visible || p.ship.sinking) {
        el.style.display = 'none'
        continue
      }
      const latencyEl = this.latencyEls.get(pid)
      if (latencyEl) {
        const peer = this.network?.getPeer(pid)
        latencyEl.textContent = peer?.latency !== undefined ? `${peer.latency}ms` : ''
      }
      const worldPos = p.ship.group.position.clone()
      worldPos.y += 14
      const ndc = worldPos.project(this._camera)
      if (ndc.z > 1) {
        el.style.display = 'none'
      } else {
        el.style.display = 'block'
        el.style.transform = `translate(${(ndc.x * 0.5 + 0.5) * window.innerWidth}px, `
          + `${(-ndc.y * 0.5 + 0.5) * window.innerHeight}px) translate(-50%, -100%)`
      }
      const bubble = this.chatBubbleEls.get(pid)
      if (bubble) {
        const bPos = p.ship.group.position.clone()
        bPos.y += 16
        const bNdc = bPos.project(this._camera)
        if (bNdc.z > 1) bubble.el.style.display = 'none'
        else {
          bubble.el.style.display = ''
          bubble.el.style.transform = `translate(${(bNdc.x * 0.5 + 0.5) * window.innerWidth}px, `
            + `${(-bNdc.y * 0.5 + 0.5) * window.innerHeight}px) translate(-50%, -100%)`
        }
      }
    }
  }

  _updateLocalBubble() {
    if (!this._localBubble || !this.localShip) return
    const pos = this.localShip.group.position.clone()
    pos.y += 16
    const ndc = pos.project(this._camera)
    if (ndc.z > 1) { this._localBubble.el.style.display = 'none'; return }
    this._localBubble.el.style.display = ''
    this._localBubble.el.style.transform = `translate(${(ndc.x * 0.5 + 0.5) * window.innerWidth}px, `
      + `${(-ndc.y * 0.5 + 0.5) * window.innerHeight}px) translate(-50%, -100%)`
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API (chat bubbles, voice, misc — unchanged surface for main.js)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Abandon ship: tear down the session and return to the menu backdrop.
   * The world stays in the scene as the menu's cinematic background; the
   * crew's departure protocol drops our ship (and purse) deterministically.
   */
  stop() {
    this._saveSea()   // the departing captain keeps the sea
    clearInterval(this._pumpTimer)
    clearInterval(this._saveTimer)
    clearInterval(this._boardTimer)
    clearInterval(this._diagTimer)
    if (this._onPageHide) window.removeEventListener('pagehide', this._onPageHide)
    document.getElementById('diag-panel')?.remove()
    this.lockstep = null
    if (this.sim) {
      for (const p of this.sim.players.values()) p.ship.destroy()
      this.sim = null
    }
    this.aiFleet.clearUnits()
    this.powerups.clearAll()
    this._combat.loadBalls([])
    for (const pid of [...this.labelEls.keys()]) this._removeLabel(pid)
    if (this._localBubble) {
      clearTimeout(this._localBubble.timer)
      this._localBubble.el.remove()
      this._localBubble = null
    }
    this._map.setOpen(false)
    this._setOverlay(null)
    const sunk = document.getElementById('sunk-overlay')
    if (sunk) sunk.style.display = 'none'
    this._playing   = false
    this._aimActive = false
    this._keys      = {}
    this._stallShown = false
    this.network = null
    if (document.pointerLockElement) document.exitPointerLock()
  }

  getPlayerCount() { return this.sim ? this.sim.players.size : 1 }

  // ── Votekick & mute ────────────────────────────────────────────────────────

  toggleMute(pid) {
    if (this.muted.has(pid)) {
      this.muted.delete(pid)
      this.onSystemMessage?.(`🔊 Unmuted ${this._resolveName(pid)}`)
    } else {
      this.muted.add(pid)
      this.onSystemMessage?.(`🔇 Muted ${this._resolveName(pid)} — voice and chat`)
    }
  }

  /** Cast (and broadcast) a vote to kick a captain. Majority = strict >50%
   *  of the live crew. The tally is out-of-band; the KICK itself rides the
   *  deterministic orderer machinery in lockstep.kick(). */
  castVote(targetPid) {
    if (!this._playing || targetPid === this.network.selfId) return
    if (!this.sim?.players.has(targetPid)) return
    this.network.sendVote?.({ t: targetPid })
    this._tallyVote(this.network.selfId, targetPid, true)
  }

  _tallyVote(voterPid, targetPid, isLocal = false) {
    if (!this.sim?.players.has(targetPid) || targetPid === voterPid) return
    const VOTE_TTL = 90000
    const now = performance.now()
    let tally = this._votes.get(targetPid)
    if (!tally) { tally = new Map(); this._votes.set(targetPid, tally) }
    const fresh = !tally.has(voterPid) || now - tally.get(voterPid) > VOTE_TTL
    tally.set(voterPid, now)
    for (const [v, at] of tally) if (now - at > VOTE_TTL) tally.delete(v)

    const active = this.lockstep?._activeCount() ?? 1
    const needed = Math.floor(active / 2) + 1
    const count  = tally.size
    const tname  = this._resolveName(targetPid)
    if (active <= 2) {
      if (isLocal) this.onSystemMessage?.(`⚖ A crew of ${active} can't vote anyone off — part ways instead`)
      return
    }
    if (fresh) {
      this.onSystemMessage?.(
        `⚖ ${this._resolveName(voterPid)} votes to kick ${tname} (${count}/${needed} needed`
        + `${count < needed ? ` — /votekick ${tname} to agree` : ''})`)
    }
    if (count >= needed) {
      this._votes.delete(targetPid)
      if (this.lockstep?.kick(targetPid)) {
        this.onSystemMessage?.(`⚖ The crew has spoken — ${tname} is voted off the ship`)
      }
      // Non-orderer peers: the orderer holds the same tally and acts on it
    }
  }

  /**
   * Apply user settings (render/audio side only — nothing here may touch
   * simulation state, or clients with different settings would desync).
   * @param {{fps?: boolean, shadows?: 'high'|'low'|'off', sfxVolume?: number}} s
   */
  applySettings(s) {
    if (s.fps !== undefined) {
      const el = document.getElementById('fps-counter')
      if (el) el.style.display = s.fps ? 'block' : 'none'
    }
    if (s.shadows !== undefined && this._sun) {
      const size = s.shadows === 'low' ? 1024 : 2048
      this._sun.castShadow = s.shadows !== 'off'
      if (this._sun.shadow.mapSize.x !== size) {
        this._sun.shadow.mapSize.set(size, size)
        this._sun.shadow.map?.dispose()
        this._sun.shadow.map = null   // forces reallocation at the new size
      }
    }
    if (s.sfxVolume !== undefined) this._sfx.setVolume(s.sfxVolume)
  }

  setAudio(proximityAudio) { this._audio = proximityAudio }

  setChatMode(active) {
    this._chatMode = active
    if (active && document.pointerLockElement) document.exitPointerLock()
    if (active) this._keys = {}
  }

  showPlayerChat(pid, text, isEmote = false) {
    const existing = this.chatBubbleEls.get(pid)
    if (existing) { clearTimeout(existing.timer); existing.el.remove() }
    this.chatBubbleEls.set(pid, this._spawnBubble(text, isEmote))
  }

  showLocalChat(text, isEmote = false) {
    if (this._localBubble) { clearTimeout(this._localBubble.timer); this._localBubble.el.remove() }
    this._localBubble = this._spawnBubble(text, isEmote)
  }

  _spawnBubble(text, isEmote) {
    const el = document.createElement('div')
    el.className = 'chat-bubble' + (isEmote ? ' emote' : '')
    el.textContent = text
    document.body.appendChild(el)
    const timer = setTimeout(() => {
      el.classList.add('fading')
      setTimeout(() => el.remove(), 650)
    }, 6000)
    return { el, timer }
  }

  _updateAudioVolumes() {
    if (!this._audio || !this._audio.isEnabled() || !this.localShip) return

    // Listener = the camera; voices come from ships, spatialised in 3-D
    const camDir = new THREE.Vector3()
    this._camera.getWorldDirection(camDir)

    const peers = new Map()
    for (const [pid, p] of this.sim.players) {
      if (pid === this.network.selfId) continue
      if (this.muted.has(pid)) continue   // muted captains are never delivered
      const pos = p.ship.group.position
      peers.set(pid, { x: pos.x, y: pos.y, z: pos.z, vc: this.network.getPeer(pid)?.vc || '' })
    }

    this._audio.update({
      listener: this._camera.position,
      forward: { x: camDir.x, z: camDir.z },
      myChannel: this.network.getLocalVc(),
      peers,
      connectedIds: this.network.getPeerIds(),
    })
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight
    this._camera.aspect = w / h
    this._camera.updateProjectionMatrix()
    // Refresh the pixel ratio too — dragging the window to a monitor with a
    // different scale changes it, and a stale ratio distorts the buffer
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this._renderer.setSize(w, h)
    const ratio = this._renderer.getPixelRatio()
    this._rt?.setSize(Math.floor(w * ratio), Math.floor(h * ratio))
  }
}
