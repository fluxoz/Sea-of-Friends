/**
 * loginAmbience.js – Tavern/ocean ambience for the login screen.
 *
 * Plays real recorded audio files (all CC0 public domain):
 *   ocean-waves.mp3  – Freesound #531015 by Noted451
 *   tavern-ambience.mp3 – Freesound #695295 by brunoboselli
 *   seagull.mp3      – Freesound #468426 by ChristianAnd
 *
 * Call start() to begin and stop() to fade out and tear down.
 */

const TRACKS = {
  ocean:   '/audio/ocean-waves.mp3',
  tavern:  '/audio/tavern-ambience.mp3',
  seagull: '/audio/seagull.mp3',
}

const MASTER_VOLUME    = 0.85   // master gain after fade-in
const FADE_IN_SECS     = 3      // fade-in duration in seconds
const FADE_OUT_SECS    = 1      // fade-out duration in seconds

// Seagull cry scheduling: first cry between [INITIAL_MIN, INITIAL_MIN+INITIAL_RANGE] ms,
// then every [INTERVAL_MIN, INTERVAL_MIN+INTERVAL_RANGE] ms thereafter.
const SEAGULL_INITIAL_MIN   = 8000
const SEAGULL_INITIAL_RANGE = 7000
const SEAGULL_INTERVAL_MIN  = 10000
const SEAGULL_INTERVAL_RANGE = 15000

export class LoginAmbience {
  constructor() {
    this._ctx     = null
    this._master  = null   // master GainNode (fade-in/out)
    this._sources = []     // active AudioBufferSourceNodes
    this._timers  = []     // setTimeout handles
    this._buffers = {}     // decoded AudioBuffers keyed by track name
    this._running = false
  }

  /**
   * Begin playback.  Creates an AudioContext, decodes audio files in parallel,
   * then starts the ambient layers.  Returns a Promise that resolves once
   * playback has started (or is skipped if already running).
   *
   * Handles the browser autoplay policy by resuming the AudioContext on the
   * first user interaction (click or keydown) if it starts in a suspended state.
   */
  async start() {
    if (this._running) return
    this._running = true

    this._ctx    = new (window.AudioContext || window.webkitAudioContext)()
    this._master = this._ctx.createGain()
    this._master.gain.setValueAtTime(0, this._ctx.currentTime)
    this._master.gain.linearRampToValueAtTime(MASTER_VOLUME, this._ctx.currentTime + FADE_IN_SECS)
    this._master.connect(this._ctx.destination)

    // Resume on first user gesture if the browser starts the context suspended
    if (this._ctx.state === 'suspended') {
      const resume = () => {
        if (this._ctx) this._ctx.resume()
        document.removeEventListener('click',   resume)
        document.removeEventListener('keydown', resume)
      }
      document.addEventListener('click',   resume, { once: true })
      document.addEventListener('keydown', resume, { once: true })
    }

    await this._loadAll()
    if (!this._running) return   // stop() was called before load finished

    this._startLoop('ocean',  0.70)
    this._startLoop('tavern', 0.45)
    this._scheduleSeagulls()
  }

  /** Fade out over 1 s, then close the AudioContext. */
  stop() {
    if (!this._running) return
    this._running = false

    this._timers.forEach(t => clearTimeout(t))
    this._timers = []

    const { _ctx: ctx, _master: master, _sources: sources } = this
    if (!ctx) return

    master.gain.cancelScheduledValues(ctx.currentTime)
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime)
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + FADE_OUT_SECS)

    setTimeout(() => {
      sources.forEach(s => { try { s.stop() } catch (_) {} })
      try { ctx.close() } catch (_) {}
    }, FADE_OUT_SECS * 1000 + 200)

    this._ctx     = null
    this._master  = null
    this._sources = []
    this._buffers = {}
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Fetch and decode all tracks in parallel; missing ones are silently skipped. */
  async _loadAll() {
    await Promise.all(Object.entries(TRACKS).map(async ([key, url]) => {
      try {
        const res    = await fetch(url)
        const arr    = await res.arrayBuffer()
        this._buffers[key] = await this._ctx.decodeAudioData(arr)
      } catch (err) {
        console.warn(`[LoginAmbience] could not load ${url}:`, err)
      }
    }))
  }

  /**
   * Start a looping track at the given volume level.
   * @param {string} key    – key in this._buffers
   * @param {number} volume – gain value (0–1)
   */
  _startLoop(key, volume) {
    const buf = this._buffers[key]
    if (!buf || !this._ctx) return

    const src = this._ctx.createBufferSource()
    src.buffer = buf
    src.loop   = true

    const gn = this._ctx.createGain()
    gn.gain.value = volume

    src.connect(gn)
    gn.connect(this._master)
    src.start()
    this._sources.push(src)
  }

  /**
   * Play the seagull one-shot once, then reschedule another cry in 10–25 s.
   * First cry is delayed 8–15 s so it doesn't clash with the fade-in.
   */
  _scheduleSeagulls() {
    const schedule = (delay) => {
      if (!this._running) return
      const t = setTimeout(() => {
        if (!this._running) return
        this._playOnce('seagull', 0.5)
        schedule(SEAGULL_INTERVAL_MIN + Math.random() * SEAGULL_INTERVAL_RANGE)
      }, delay)
      this._timers.push(t)
    }
    schedule(SEAGULL_INITIAL_MIN + Math.random() * SEAGULL_INITIAL_RANGE)
  }

  /**
   * Play a buffer once (non-looping) at the given volume.
   * @param {string} key    – key in this._buffers
   * @param {number} volume – gain value (0–1)
   */
  _playOnce(key, volume) {
    const buf = this._buffers[key]
    if (!buf || !this._ctx) return

    const src = this._ctx.createBufferSource()
    src.buffer = buf
    src.loop   = false

    const gn = this._ctx.createGain()
    gn.gain.value = volume

    src.connect(gn)
    gn.connect(this._master)
    src.start()
    this._sources.push(src)
  }
}
