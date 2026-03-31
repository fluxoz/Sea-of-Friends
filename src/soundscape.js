/**
 * soundscape.js – Ambient ocean soundscape and ship sound effects.
 *
 * Audio files (all CC0 / Public Domain, no attribution required):
 *   ocean.mp3    – "Ocean Wide" by JMAustin via greysound (Freesound #31366)
 *   seagulls.mp3 – "Seagulls screeching on the beach" by felix.blume (Freesound #155747)
 *   wind.mp3     – "Still Outdoor Air 2 LOOP" by Geoff-Bremner-Audio (Freesound #829081)
 *   ship.mp3     – "Sailboat Sailing Interior 1" by AugustSandberg (Freesound #252663)
 *
 * Layers:
 *   • Ocean waves  – looping field recording, constant background
 *   • Seagulls     – looping beach ambience with real gull calls
 *   • Wind         – outdoor air loop; volume scales with ship speed
 *   • Ship         – sailboat interior creaks/rigging; volume scales with speed
 */

const DEFAULT_VOLUME = 0.7

/**
 * Paths to sound asset files (relative to the web root / public directory).
 * Using a separate object makes it easy to swap assets without touching logic.
 */
const SOUND_PATHS = {
  ocean:    '/sounds/ocean.mp3',
  seagulls: '/sounds/seagulls.mp3',
  wind:     '/sounds/wind.mp3',
  ship:     '/sounds/ship.mp3',
}

/** Gain values for each layer when the ship is at rest. */
const LAYER_GAINS = {
  ocean:    0.55,
  seagulls: 0.35,
  wind:     0.04,  // rises with speed
  ship:     0.08,  // rises with speed
}

export class Soundscape {
  constructor() {
    this._ctx          = null
    this._masterGain   = null
    this._enabled      = false
    this._muted        = false
    this._volume       = DEFAULT_VOLUME

    /** Speed-reactive gain nodes. */
    this._windGain  = null
    this._shipGain  = null

    /** All active AudioBufferSourceNodes, keyed by layer name. */
    this._sources = {}
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Create the AudioContext and begin loading / playing all sound layers.
   * Must be called from inside a user-gesture handler (e.g. a button click)
   * to satisfy browser autoplay policies.
   *
   * @returns {boolean} false if the Web Audio API is unavailable.
   */
  start() {
    if (this._enabled) return true
    try {
      this._ctx = new AudioContext()
    } catch {
      return false
    }

    // Resume context if the browser created it in a suspended state
    // (autoplay policy may apply even inside a user-gesture handler).
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {})

    this._masterGain = this._ctx.createGain()
    this._masterGain.gain.value = this._volume
    this._masterGain.connect(this._ctx.destination)

    // Fixed-gain layers
    const oceanGain    = this._makeGain(LAYER_GAINS.ocean)
    const seagullsGain = this._makeGain(LAYER_GAINS.seagulls)

    // Speed-reactive gain layers
    this._windGain = this._makeGain(LAYER_GAINS.wind)
    this._shipGain = this._makeGain(LAYER_GAINS.ship)

    // Load and loop all four layers
    this._loadAndLoop('ocean',    oceanGain)
    this._loadAndLoop('seagulls', seagullsGain)
    this._loadAndLoop('wind',     this._windGain)
    this._loadAndLoop('ship',     this._shipGain)

    this._enabled = true
    return true
  }

  /** Tear down all nodes and close the AudioContext. */
  stop() {
    if (!this._enabled) return
    for (const src of Object.values(this._sources)) {
      try { src.stop() } catch { /* already stopped */ }
    }
    this._sources    = {}
    this._ctx?.close().catch(() => {})
    this._ctx        = null
    this._masterGain = null
    this._windGain   = null
    this._shipGain   = null
    this._enabled    = false
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Create a GainNode connected to the master bus. */
  _makeGain(value) {
    const g = this._ctx.createGain()
    g.gain.value = value
    g.connect(this._masterGain)
    return g
  }

  /**
   * Fetch an audio file, decode it, and start it looping through the supplied
   * destination node.  Failures are silently ignored (layer stays silent).
   *
   * @param {string}   name     Key in SOUND_PATHS / this._sources
   * @param {AudioNode} dest    Where to route the source (a GainNode)
   */
  async _loadAndLoop(name, dest) {
    try {
      const response    = await fetch(SOUND_PATHS[name])
      const arrayBuffer = await response.arrayBuffer()
      const audioBuffer = await this._ctx.decodeAudioData(arrayBuffer)

      if (!this._enabled) return  // soundscape was stopped during load

      const src    = this._ctx.createBufferSource()
      src.buffer   = audioBuffer
      src.loop     = true
      src.connect(dest)

      // Fade in over ~2 seconds via the destination gain node to avoid a hard
      // transient.  Use setTargetAtTime (same API as update()) so it doesn't
      // conflict with the speed-reactive automation on wind/ship gain nodes.
      const baseGain = LAYER_GAINS[name]
      const now      = this._ctx.currentTime
      dest.gain.setValueAtTime(0, now)
      dest.gain.setTargetAtTime(baseGain, now, 0.7)

      src.start(0)
      this._sources[name] = src
    } catch (err) {
      console.warn(`[Soundscape] Could not load layer "${name}":`, err)
    }
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  /**
   * Update the speed-reactive sound layers.  Call once per animation frame.
   * @param {number} normSpeed  Normalised ship speed in the range [0, 1].
   */
  update(normSpeed) {
    if (!this._enabled || !this._ctx) return

    const t = this._ctx.currentTime
    const s = Math.max(0, Math.min(1, normSpeed))

    // Wind rises with speed (smooth time-constant 0.9 s)
    if (this._windGain) {
      this._windGain.gain.setTargetAtTime(0.04 + s * 0.20, t, 0.9)
    }

    // Ship sounds increase with motion (slower time-constant 1.4 s)
    if (this._shipGain) {
      this._shipGain.gain.setTargetAtTime(0.08 + s * 0.60, t, 1.4)
    }
  }

  // ── Volume / mute ──────────────────────────────────────────────────────────

  /**
   * Mute or unmute all ambient sounds with a short fade.
   * @param {boolean} muted
   */
  setMuted(muted) {
    this._muted = muted
    if (this._masterGain && this._ctx) {
      this._masterGain.gain.setTargetAtTime(
        muted ? 0 : this._volume,
        this._ctx.currentTime,
        0.2,
      )
    }
  }

  /**
   * Set the master volume (0–1) without affecting the muted state.
   * @param {number} v
   */
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v))
    if (!this._muted && this._masterGain && this._ctx) {
      this._masterGain.gain.setTargetAtTime(this._volume, this._ctx.currentTime, 0.1)
    }
  }

  isMuted()   { return this._muted   }
  isEnabled() { return this._enabled }
}
