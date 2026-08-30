/**
 * sfx.js – Procedural sound effects engine.
 *
 * Every sound is synthesised with the Web Audio API (noise bursts, filtered
 * sweeps, oscillator glides) so no audio files need to be shipped.  All
 * one-shot effects accept a world-space distance so they attenuate naturally
 * ("a cannon two islands away is a dull thud").
 *
 * This is intentionally separate from ProximityAudio (voice chat) – the two
 * systems own independent AudioContexts and never interact.
 */

/** Distance (world units) beyond which one-shot effects are inaudible. */
const MAX_SFX_DISTANCE = 700

export class SFX {
  constructor() {
    this.ctx      = null
    this._master  = null
    this._noise   = null    // shared 2 s white-noise buffer
    this._gullTimer = null
  }

  /**
   * Create the AudioContext and start the ambient bed.
   * Must be called from a user gesture (the "Set Sail!" click).
   */
  init() {
    if (this.ctx) return
    this.ctx = new (window.AudioContext || window.webkitAudioContext)()

    this._master = this.ctx.createGain()
    this._master.gain.value = (this._volume ?? 1) * 0.6
    this._master.connect(this.ctx.destination)

    // Shared white-noise buffer used by every noise-based effect
    const len = this.ctx.sampleRate * 2
    this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = this._noise.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1

    this._startAmbient()
    this._scheduleGull()
  }

  /** Resume the context if the browser suspended it (autoplay policy). */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
  }

  /** Master effects volume, 0..1. Safe to call before init(). */
  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v))
    if (this._master) this._master.gain.value = this._volume * 0.6
  }

  // ── Rollback replay gate ───────────────────────────────────────────────────
  // The lockstep layer re-simulates ticks (prediction + rollback), so the sim
  // can trigger the same one-shot effect several times for one game moment.
  // While a tick context is set, each (tick, kind, ~distance) fires once; the
  // first execution wins and replays are swallowed. UI sounds outside the sim
  // (menu burn, button feedback) carry no context and are never gated.

  beginTick(tick) {
    this._tickCtx = tick
    if (!this._played) this._played = new Set()
  }

  endTick() { this._tickCtx = null }

  _gate(kind, dist = 0) {
    if (this._tickCtx == null) return true
    const key = `${this._tickCtx}:${kind}:${Math.round(dist / 8)}`
    if (this._played.has(key)) return false
    this._played.add(key)
    if (this._played.size > 500) {
      const keys = [...this._played]
      this._played = new Set(keys.slice(keys.length >> 1))
    }
    return true
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /** Quadratic distance fall-off, 1 at the listener → 0 at MAX_SFX_DISTANCE. */
  _vol(dist) {
    const t = Math.max(0, 1 - dist / MAX_SFX_DISTANCE)
    return t * t
  }

  /** Play the shared noise buffer through a filter + gain envelope. */
  _noiseBurst({ dur, filterType, freqStart, freqEnd, gainPeak, attack = 0.005 }) {
    const t0 = this.ctx.currentTime
    const src = this.ctx.createBufferSource()
    src.buffer = this._noise
    src.loop   = true

    const filter = this.ctx.createBiquadFilter()
    filter.type = filterType
    filter.frequency.setValueAtTime(freqStart, t0)
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur)

    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainPeak), t0 + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    src.connect(filter).connect(gain).connect(this._master)
    src.start(t0)
    src.stop(t0 + dur + 0.05)
  }

  /** Simple oscillator glide with an envelope. */
  _tone({ type, freqStart, freqEnd, dur, gainPeak, attack = 0.01, delay = 0 }) {
    const t0 = this.ctx.currentTime + delay
    const osc = this.ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freqStart, t0)
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur)

    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainPeak), t0 + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    osc.connect(gain).connect(this._master)
    osc.start(t0)
    osc.stop(t0 + dur + 0.05)
  }

  // ── One-shot effects ───────────────────────────────────────────────────────

  /** Cannon blast: deep noise boom + low sine thump. */
  cannon(dist = 0) {
    if (!this.ctx) return
    if (!this._gate('cannon', dist)) return
    this.resume()
    const v = this._vol(dist)
    if (v <= 0) return
    // Far-away cannons sound duller: drop the filter start frequency
    const near = Math.max(0.25, 1 - dist / 300)
    this._noiseBurst({
      dur: 0.5, filterType: 'lowpass',
      freqStart: 260 + 900 * near, freqEnd: 60,
      gainPeak: 0.9 * v,
    })
    this._tone({ type: 'sine', freqStart: 70, freqEnd: 36, dur: 0.4, gainPeak: 0.7 * v })
  }

  /** Cannonball splashdown. */
  splash(dist = 0) {
    if (!this.ctx) return
    if (!this._gate('splash', dist)) return
    const v = this._vol(dist)
    if (v <= 0) return
    this._noiseBurst({
      dur: 0.3, filterType: 'bandpass',
      freqStart: 1500, freqEnd: 350,
      gainPeak: 0.35 * v, attack: 0.01,
    })
  }

  /** Cannonball smashing into a hull: sharp wooden crack. */
  woodHit(dist = 0) {
    if (!this.ctx) return
    if (!this._gate('woodHit', dist)) return
    const v = this._vol(dist)
    if (v <= 0) return
    this._noiseBurst({
      dur: 0.18, filterType: 'bandpass',
      freqStart: 900, freqEnd: 180,
      gainPeak: 0.8 * v, attack: 0.002,
    })
    this._tone({ type: 'square', freqStart: 190, freqEnd: 70, dur: 0.12, gainPeak: 0.2 * v, attack: 0.002 })
  }

  /** Big boom + debris for a ship going down. */
  shipSunk(dist = 0) {
    if (!this.ctx) return
    if (!this._gate('shipSunk', dist)) return
    const v = this._vol(dist)
    if (v <= 0) return
    this._noiseBurst({
      dur: 1.1, filterType: 'lowpass',
      freqStart: 900, freqEnd: 50,
      gainPeak: 0.9 * v,
    })
    // Groaning hull timbers
    this._tone({ type: 'sawtooth', freqStart: 130, freqEnd: 32, dur: 1.6, gainPeak: 0.22 * v, attack: 0.15 })
    // A few bubbles
    for (let i = 0; i < 6; i++) {
      this._tone({
        type: 'sine',
        freqStart: 300 + Math.random() * 500,
        freqEnd:   600 + Math.random() * 700,
        dur: 0.08, gainPeak: 0.10 * v, delay: 0.4 + i * 0.18 + Math.random() * 0.1,
      })
    }
  }

  /** Damage taken by the local player – short alarming thud (no distance). */
  localHit() {
    if (!this.ctx) return
    if (!this._gate('localHit')) return
    this._noiseBurst({
      dur: 0.25, filterType: 'lowpass',
      freqStart: 600, freqEnd: 90,
      gainPeak: 0.8, attack: 0.002,
    })
  }

  /** Cannons ready again – subtle mechanical click. */
  reloadReady() {
    if (!this.ctx) return
    this._tone({ type: 'triangle', freqStart: 900, freqEnd: 650, dur: 0.07, gainPeak: 0.12 })
  }

  /** Respawn shimmer. */
  respawn() {
    if (!this.ctx) return
    if (!this._gate('respawn')) return
    this._tone({ type: 'sine', freqStart: 420, freqEnd: 840, dur: 0.5, gainPeak: 0.2, attack: 0.05 })
    this._tone({ type: 'sine', freqStart: 630, freqEnd: 1260, dur: 0.5, gainPeak: 0.12, attack: 0.05, delay: 0.12 })
  }

  /** The menu scroll going up in flames. */
  burn() {
    if (!this.ctx) return
    this.resume()
    this._noiseBurst({
      dur: 1.3, filterType: 'bandpass',
      freqStart: 900, freqEnd: 2400,
      gainPeak: 0.35, attack: 0.15,
    })
    this._noiseBurst({
      dur: 1.1, filterType: 'lowpass',
      freqStart: 500, freqEnd: 120,
      gainPeak: 0.3, attack: 0.1,
    })
    // a few pops
    for (let i = 0; i < 5; i++) {
      this._tone({
        type: 'square', freqStart: 180 + Math.random() * 300, freqEnd: 60,
        dur: 0.04, gainPeak: 0.08, delay: 0.15 + Math.random() * 0.9,
      })
    }
  }

  /** Ballista loosing a bolt: taut string twang + wooden thunk. */
  ballista(dist = 0) {
    if (!this.ctx) return
    if (!this._gate('ballista', dist)) return
    this.resume()
    const v = this._vol(dist)
    if (v <= 0) return
    // String release: sharp plucked twang gliding down
    this._tone({ type: 'sawtooth', freqStart: 320, freqEnd: 90, dur: 0.12, gainPeak: 0.5 * v, attack: 0.002 })
    this._tone({ type: 'triangle', freqStart: 640, freqEnd: 180, dur: 0.08, gainPeak: 0.3 * v, attack: 0.002 })
    // Frame thunk
    this._noiseBurst({
      dur: 0.15, filterType: 'lowpass',
      freqStart: 350, freqEnd: 80,
      gainPeak: 0.45 * v, attack: 0.004,
    })
  }

  /** Chain shot tearing through canvas. */
  ripSail(dist = 0) {
    if (!this.ctx) return
    if (!this._gate('ripSail', dist)) return
    const v = this._vol(dist)
    if (v <= 0) return
    this._noiseBurst({
      dur: 0.28, filterType: 'highpass',
      freqStart: 900, freqEnd: 2600,
      gainPeak: 0.5 * v, attack: 0.004,
    })
  }

  /** Picked up a power-up: rising chime. */
  powerup() {
    if (!this.ctx) return
    if (!this._gate('powerup')) return
    this._tone({ type: 'sine', freqStart: 520, freqEnd: 660,  dur: 0.14, gainPeak: 0.22 })
    this._tone({ type: 'sine', freqStart: 660, freqEnd: 880,  dur: 0.14, gainPeak: 0.22, delay: 0.11 })
    this._tone({ type: 'sine', freqStart: 880, freqEnd: 1320, dur: 0.22, gainPeak: 0.2,  delay: 0.22 })
  }

  /** Gold hitting the purse. */
  coins() {
    if (!this.ctx) return
    if (!this._gate('coins')) return
    for (let i = 0; i < 4; i++) {
      this._tone({
        type: 'square',
        freqStart: 2200 + Math.random() * 900, freqEnd: 1800 + Math.random() * 600,
        dur: 0.05, gainPeak: 0.05, delay: i * 0.06 + Math.random() * 0.02,
      })
    }
  }

  /** Hull bumping an island. */
  thud(dist = 0) {
    if (!this.ctx) return
    if (!this._gate('thud', dist)) return
    const v = this._vol(dist)
    if (v <= 0) return
    this._noiseBurst({
      dur: 0.2, filterType: 'lowpass',
      freqStart: 240, freqEnd: 60,
      gainPeak: 0.4 * v, attack: 0.005,
    })
  }

  // ── Ambient bed ────────────────────────────────────────────────────────────

  _startAmbient() {
    // Endless wash of filtered noise, gently swelling like surf
    const src = this.ctx.createBufferSource()
    src.buffer = this._noise
    src.loop   = true

    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 420

    const gain = this.ctx.createGain()
    gain.gain.value = 0.05

    // Slow LFO on the gain = swell of the sea
    const lfo = this.ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 0.09
    const lfoDepth = this.ctx.createGain()
    lfoDepth.gain.value = 0.025
    lfo.connect(lfoDepth).connect(gain.gain)

    src.connect(filter).connect(gain).connect(this._master)
    src.start()
    lfo.start()
  }

  /** Occasional distant seagull cries. */
  _scheduleGull() {
    const delay = 12000 + Math.random() * 25000
    this._gullTimer = setTimeout(() => {
      if (this.ctx && document.visibilityState === 'visible') {
        const base = 1100 + Math.random() * 500
        const cries = 2 + Math.floor(Math.random() * 3)
        for (let i = 0; i < cries; i++) {
          this._tone({
            type: 'sine',
            freqStart: base * 1.25, freqEnd: base * 0.8,
            dur: 0.22, gainPeak: 0.05, attack: 0.03,
            delay: i * 0.35 + Math.random() * 0.1,
          })
        }
      }
      this._scheduleGull()
    }, delay)
  }
}
