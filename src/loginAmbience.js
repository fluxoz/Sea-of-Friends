/**
 * loginAmbience.js – Procedural tavern/ocean ambience for the login screen.
 *
 * All audio is synthesised via the Web Audio API – no audio files required.
 * Call start() to begin the ambience and stop() to tear it down cleanly.
 */

export class LoginAmbience {
  constructor() {
    this._ctx    = null
    this._master = null  // master GainNode (for fade-in/out)
    this._nodes  = []    // all nodes that need to be disconnected on stop
    this._timers = []    // setInterval / setTimeout handles
    this._running = false
  }

  /** Begin playback.  Creates a new AudioContext and starts all layers. */
  start() {
    if (this._running) return
    this._ctx    = new (window.AudioContext || window.webkitAudioContext)()
    this._master = this._ctx.createGain()
    this._master.gain.setValueAtTime(0, this._ctx.currentTime)
    this._master.gain.linearRampToValueAtTime(1, this._ctx.currentTime + 3)
    this._master.connect(this._ctx.destination)
    this._running = true

    this._addOceanWaves()
    this._addTavernMurmur()
    this._addShipCreaks()
    this._addSeagulls()
  }

  /** Fade out and tear down everything. */
  stop() {
    if (!this._running) return
    this._running = false

    // Clear scheduled timers
    this._timers.forEach(t => clearTimeout(t))
    this._timers = []

    const ctx = this._ctx
    const master = this._master
    const nodes  = this._nodes

    // Fade out over 1 second then close
    master.gain.cancelScheduledValues(ctx.currentTime)
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime)
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + 1)

    setTimeout(() => {
      nodes.forEach(n => { try { n.disconnect() } catch (_) {} })
      try { ctx.close() } catch (_) {}
    }, 1200)

    this._ctx    = null
    this._master = null
    this._nodes  = []
  }

  // ── Private layer builders ─────────────────────────────────────────────────

  /**
   * Layered ocean wave noise: two filtered noise sources with slow LFOs to
   * give the sound a gentle in-and-out breathing quality.
   */
  _addOceanWaves() {
    const ctx = this._ctx

    const createWaveLayer = (filterFreq, lfoRate, lfoDepth, gain) => {
      const buf  = this._makeNoiseBuffer(4)
      const src  = ctx.createBufferSource()
      src.buffer = buf
      src.loop   = true
      src.loopEnd = 4

      const bpf  = ctx.createBiquadFilter()
      bpf.type            = 'bandpass'
      bpf.frequency.value = filterFreq
      bpf.Q.value         = 1.2

      const gainNode  = ctx.createGain()
      gainNode.gain.value = gain

      // LFO modulates gain for wave swell
      const lfo = ctx.createOscillator()
      lfo.type            = 'sine'
      lfo.frequency.value = lfoRate

      const lfoGain = ctx.createGain()
      lfoGain.gain.value = lfoDepth

      lfo.connect(lfoGain)
      lfoGain.connect(gainNode.gain)

      src.connect(bpf)
      bpf.connect(gainNode)
      gainNode.connect(this._master)

      src.start()
      lfo.start()

      this._nodes.push(src, bpf, gainNode, lfo, lfoGain)
    }

    // Deep rumble
    createWaveLayer(120,  0.07, 0.06, 0.18)
    // Mid wave wash
    createWaveLayer(500,  0.11, 0.04, 0.10)
    // High spray shimmer
    createWaveLayer(2000, 0.17, 0.02, 0.04)
  }

  /**
   * Tavern murmur: multiple narrow bandpass noise bands pitched to speech
   * frequencies, with independent slow amplitude modulation.
   */
  _addTavernMurmur() {
    const ctx = this._ctx

    // Distant crowd chatter bands
    const bands = [
      { freq: 300,  q: 3,  gain: 0.06, lfo: 0.23 },
      { freq: 500,  q: 4,  gain: 0.05, lfo: 0.19 },
      { freq: 800,  q: 3,  gain: 0.04, lfo: 0.31 },
      { freq: 1200, q: 5,  gain: 0.03, lfo: 0.27 },
      { freq: 2000, q: 6,  gain: 0.02, lfo: 0.41 },
    ]

    bands.forEach(({ freq, q, gain, lfo: lfoRate }) => {
      const buf = this._makeNoiseBuffer(6)
      const src = ctx.createBufferSource()
      src.buffer  = buf
      src.loop    = true
      src.loopEnd = 6

      const bpf = ctx.createBiquadFilter()
      bpf.type            = 'bandpass'
      bpf.frequency.value = freq
      bpf.Q.value         = q

      const gn = ctx.createGain()
      gn.gain.value = gain

      const lfo     = ctx.createOscillator()
      lfo.type            = 'sine'
      lfo.frequency.value = lfoRate
      const lfoGain = ctx.createGain()
      lfoGain.gain.value = gain * 0.6

      lfo.connect(lfoGain)
      lfoGain.connect(gn.gain)
      src.connect(bpf)
      bpf.connect(gn)
      gn.connect(this._master)
      src.start()
      lfo.start()

      this._nodes.push(src, bpf, gn, lfo, lfoGain)
    })
  }

  /**
   * Occasional wooden ship creak sounds: short filtered resonant pings
   * scheduled randomly every 4–12 seconds.
   */
  _addShipCreaks() {
    const scheduleCreak = () => {
      if (!this._running) return
      const delay = 4000 + Math.random() * 8000
      const t = setTimeout(() => {
        if (!this._running) return
        this._playCreak()
        scheduleCreak()
      }, delay)
      this._timers.push(t)
    }
    scheduleCreak()
  }

  _playCreak() {
    const ctx = this._ctx
    if (!ctx) return
    const now = ctx.currentTime

    const buf  = this._makeNoiseBuffer(0.3)
    const src  = ctx.createBufferSource()
    src.buffer = buf

    const bpf  = ctx.createBiquadFilter()
    bpf.type            = 'bandpass'
    bpf.frequency.value = 200 + Math.random() * 300
    bpf.Q.value         = 8 + Math.random() * 10

    const gn   = ctx.createGain()
    gn.gain.setValueAtTime(0.18, now)
    gn.gain.exponentialRampToValueAtTime(0.001, now + 0.3)

    src.connect(bpf)
    bpf.connect(gn)
    gn.connect(this._master)
    src.start(now)
    src.stop(now + 0.35)
    // Nodes auto-disconnect after playback; track for safety
    this._nodes.push(src, bpf, gn)
  }

  /**
   * Distant seagull cries: quick gliding frequency sweeps scheduled
   * randomly every 8–20 seconds.
   */
  _addSeagulls() {
    const scheduleGull = () => {
      if (!this._running) return
      const delay = 8000 + Math.random() * 12000
      const t = setTimeout(() => {
        if (!this._running) return
        this._playSeagull()
        scheduleGull()
      }, delay)
      this._timers.push(t)
    }
    // First call slightly delayed so it doesn't overlap the fade-in
    const t = setTimeout(scheduleGull, 5000)
    this._timers.push(t)
  }

  _playSeagull() {
    const ctx = this._ctx
    if (!ctx) return
    const now  = ctx.currentTime
    const dur  = 0.35 + Math.random() * 0.25

    const osc  = ctx.createOscillator()
    osc.type   = 'sine'
    const startFreq = 1200 + Math.random() * 400
    osc.frequency.setValueAtTime(startFreq, now)
    osc.frequency.exponentialRampToValueAtTime(startFreq * 0.6, now + dur)

    const gn   = ctx.createGain()
    gn.gain.setValueAtTime(0, now)
    gn.gain.linearRampToValueAtTime(0.06, now + 0.04)
    gn.gain.linearRampToValueAtTime(0.06, now + dur - 0.04)
    gn.gain.linearRampToValueAtTime(0, now + dur)

    osc.connect(gn)
    gn.connect(this._master)
    osc.start(now)
    osc.stop(now + dur + 0.05)
    this._nodes.push(osc, gn)
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  /** Create a mono white-noise AudioBuffer of `seconds` duration. */
  _makeNoiseBuffer(seconds) {
    const ctx         = this._ctx
    const sampleRate  = ctx.sampleRate
    const length      = Math.ceil(sampleRate * seconds)
    const buffer      = ctx.createBuffer(1, length, sampleRate)
    const data        = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1
    }
    return buffer
  }
}
