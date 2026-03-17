/**
 * soundscape.js – Ambient ocean soundscape and ship sound effects.
 *
 * All audio is synthesised procedurally using the Web Audio API.
 * No external audio files are required.
 *
 * Layers:
 *   • Ocean waves  – three-band filtered noise with wave-rhythm LFOs
 *   • Wind         – high-passed noise; volume scales with ship speed
 *   • Seagulls     – occasional procedural gull cries (random 8–30 s apart)
 *   • Ship sounds  – low-freq hull creak + rigging hum, both speed-reactive
 */

const DEFAULT_VOLUME = 0.7

/** Fill a mono AudioBuffer channel with white noise (designed for looping). */
function fillNoise(buffer) {
  const ch = buffer.getChannelData(0)
  for (let i = 0; i < ch.length; i++) {
    ch[i] = Math.random() * 2 - 1
  }
}

export class Soundscape {
  constructor() {
    this._ctx        = null
    this._masterGain = null
    this._enabled    = false
    this._muted      = false
    this._volume     = DEFAULT_VOLUME

    /** Speed-reactive wind layer (plain GainNode – no LFO). */
    this._windGain = null
    /** Master ship-sound gain (scales creak + rigging with ship speed). */
    this._shipGain = null

    /** setTimeout handle for seagull scheduling. */
    this._gullTimeout = null
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Create the AudioContext and start all continuous sound layers.
   * Must be called from inside a user-gesture handler (e.g. a button click).
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

    this._masterGain = this._ctx.createGain()
    this._masterGain.gain.value = this._volume
    this._masterGain.connect(this._ctx.destination)

    this._buildOcean()
    this._buildWind()
    this._buildShipSounds()
    this._scheduleNextGull()

    this._enabled = true
    return true
  }

  /** Tear down all nodes and close the AudioContext. */
  stop() {
    if (!this._enabled) return
    clearTimeout(this._gullTimeout)
    this._gullTimeout = null
    this._ctx?.close().catch(() => {})
    this._ctx        = null
    this._masterGain = null
    this._windGain   = null
    this._shipGain   = null
    this._enabled    = false
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Create and immediately start a looping white-noise AudioBufferSourceNode.
   * @param {number} seconds  Duration of the noise buffer; 3+ recommended.
   */
  _noiseSource(seconds = 4) {
    const ctx  = this._ctx
    const buf  = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate)
    fillNoise(buf)
    const src  = ctx.createBufferSource()
    src.buffer = buf
    src.loop   = true
    src.start()
    return src
  }

  /**
   * Create a GainNode whose gain AudioParam is continuously modulated by an
   * LFO oscillator.  The resulting gain swings between (center − depth) and
   * (center + depth).
   *
   * @param {number} lfoHz   LFO oscillation frequency in Hz
   * @param {number} center  Mean (intrinsic) gain value
   * @param {number} depth   Half-amplitude of the LFO modulation
   * @param {'sine'|'triangle'} [shape]
   * @returns {GainNode}
   */
  _lfoGain(lfoHz, center, depth, shape = 'sine') {
    const ctx      = this._ctx
    const gainNode = ctx.createGain()
    gainNode.gain.value = center

    const osc = ctx.createOscillator()
    osc.type = shape
    osc.frequency.value = lfoHz

    const mod = ctx.createGain()
    mod.gain.value = depth
    osc.connect(mod)
    mod.connect(gainNode.gain)
    osc.start()

    return gainNode
  }

  // ── Ocean ──────────────────────────────────────────────────────────────────

  _buildOcean() {
    const ctx = this._ctx

    // Layer 1 – deep low-frequency rumble with slow wave-rhythm LFO
    {
      const src = this._noiseSource(5)
      const lpf = ctx.createBiquadFilter()
      lpf.type = 'lowpass'
      lpf.frequency.value = 280
      lpf.Q.value = 0.6
      const g = this._lfoGain(0.28, 0.25, 0.13)
      src.connect(lpf)
      lpf.connect(g)
      g.connect(this._masterGain)
    }

    // Layer 2 – mid-range wave surge with wave-rhythm LFO (~0.4 Hz)
    {
      const src = this._noiseSource(6)
      const bpf = ctx.createBiquadFilter()
      bpf.type = 'bandpass'
      bpf.frequency.value = 480
      bpf.Q.value = 0.8
      const lpf = ctx.createBiquadFilter()
      lpf.type = 'lowpass'
      lpf.frequency.value = 900
      const g = this._lfoGain(0.40, 0.32, 0.18)
      src.connect(bpf)
      bpf.connect(lpf)
      lpf.connect(g)
      g.connect(this._masterGain)
    }

    // Layer 3 – high-frequency hiss / sea spray (subtle)
    {
      const src = this._noiseSource(3)
      const hpf = ctx.createBiquadFilter()
      hpf.type = 'highpass'
      hpf.frequency.value = 3000
      const lpf = ctx.createBiquadFilter()
      lpf.type = 'lowpass'
      lpf.frequency.value = 7000
      const g = this._lfoGain(0.22, 0.07, 0.035, 'triangle')
      src.connect(hpf)
      hpf.connect(lpf)
      lpf.connect(g)
      g.connect(this._masterGain)
    }
  }

  // ── Wind ──────────────────────────────────────────────────────────────────

  _buildWind() {
    const ctx = this._ctx
    const src = this._noiseSource(5)

    const hpf = ctx.createBiquadFilter()
    hpf.type = 'highpass'
    hpf.frequency.value = 2000

    const lpf = ctx.createBiquadFilter()
    lpf.type = 'lowpass'
    lpf.frequency.value = 5000

    this._windGain = ctx.createGain()
    this._windGain.gain.value = 0.04   // quiet at rest; rises with speed

    src.connect(hpf)
    hpf.connect(lpf)
    lpf.connect(this._windGain)
    this._windGain.connect(this._masterGain)
  }

  // ── Ship sounds ────────────────────────────────────────────────────────────

  _buildShipSounds() {
    const ctx = this._ctx

    // Master ship-sound gain – scaled by update() with ship speed
    this._shipGain = ctx.createGain()
    this._shipGain.gain.value = 0.5
    this._shipGain.connect(this._masterGain)

    // Hull creak – very low frequency, extremely slow LFO
    {
      const src = this._noiseSource(8)
      const bpf = ctx.createBiquadFilter()
      bpf.type = 'bandpass'
      bpf.frequency.value = 160
      bpf.Q.value = 3
      const g = this._lfoGain(0.07, 0.032, 0.026, 'triangle')
      src.connect(bpf)
      bpf.connect(g)
      g.connect(this._shipGain)
    }

    // Rigging hum – mid-frequency, moderate LFO for rope-tension flutter
    {
      const src = this._noiseSource(5)
      const bpf = ctx.createBiquadFilter()
      bpf.type = 'bandpass'
      bpf.frequency.value = 1100
      bpf.Q.value = 1.8
      const g = this._lfoGain(0.55, 0.038, 0.022)
      src.connect(bpf)
      bpf.connect(g)
      g.connect(this._shipGain)
    }
  }

  // ── Seagulls ──────────────────────────────────────────────────────────────

  _scheduleNextGull() {
    const delay = 8000 + Math.random() * 22000  // 8 – 30 s
    this._gullTimeout = setTimeout(() => {
      if (!this._enabled) return
      this._playGulls()
      this._scheduleNextGull()
    }, delay)
  }

  /** Emit a cluster of 1–3 gull cries spaced slightly apart. */
  _playGulls() {
    const numCries = 1 + (Math.random() > 0.45 ? 1 : 0) + (Math.random() > 0.78 ? 1 : 0)
    let t = this._ctx.currentTime + 0.10
    for (let i = 0; i < numCries; i++) {
      this._singleCry(t)
      t += 0.40 + Math.random() * 0.35
    }
  }

  /**
   * Synthesise a single descending gull cry using a sawtooth oscillator with
   * vibrato, a pitch-slide envelope, and a bandpass filter for timbre shaping.
   *
   * @param {number} startAt  AudioContext time to begin the cry
   */
  _singleCry(startAt) {
    const ctx      = this._ctx
    const duration = 0.25 + Math.random() * 0.30

    // Sawtooth oscillator – rich in harmonics for a raw screech quality
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'

    // Vibrato: a secondary oscillator that modulates the pitch
    const vib    = ctx.createOscillator()
    vib.type     = 'sine'
    vib.frequency.value = 7 + Math.random() * 5
    const vibMod = ctx.createGain()
    vibMod.gain.value = 18 + Math.random() * 18
    vib.connect(vibMod)
    vibMod.connect(osc.frequency)

    // Pitch envelope: starts high, slides down (characteristic gull cry)
    const f0 = 1050 + Math.random() * 600
    osc.frequency.setValueAtTime(f0 * 1.30, startAt)
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.70, startAt + duration)

    // Amplitude envelope: sharp attack, exponential decay
    const peak = 0.14 + Math.random() * 0.06
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, startAt)
    env.gain.linearRampToValueAtTime(peak, startAt + 0.03)
    env.gain.setValueAtTime(peak, startAt + duration * 0.40)
    env.gain.exponentialRampToValueAtTime(0.001, startAt + duration)

    // Bandpass filter to shape the timbre into bird-like tones
    const bpf = ctx.createBiquadFilter()
    bpf.type = 'bandpass'
    bpf.frequency.value = 1700
    bpf.Q.value = 1.4

    osc.connect(bpf)
    bpf.connect(env)
    env.connect(this._masterGain)

    const stopAt = startAt + duration + 0.05
    vib.start(startAt); vib.stop(stopAt)
    osc.start(startAt); osc.stop(stopAt)
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
      this._windGain.gain.setTargetAtTime(0.04 + s * 0.18, t, 0.9)
    }

    // Ship creak and rigging increase with motion (slower time-constant 1.4 s)
    if (this._shipGain) {
      this._shipGain.gain.setTargetAtTime(0.5 + s * 1.0, t, 1.4)
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
