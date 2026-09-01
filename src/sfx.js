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
    this._scheduleCreak()
    this._loadCannonSamples()
    this._loadAmbience()
  }

  /** Real CC0 cannon recordings (rubberduck, OpenGameArt) — decoded async;
   *  the synthesised voice covers the gap and any load failure. */
  async _loadCannonSamples() {
    this._cannonBufs = []
    for (let i = 1; i <= 5; i++) {
      try {
        const r = await fetch(`/assets/sounds/cannon_${i}.ogg`)
        if (!r.ok) continue
        const buf = await this.ctx.decodeAudioData(await r.arrayBuffer())
        this._cannonBufs.push(buf)
      } catch { /* missing/undecodable — synthesis carries on */ }
    }
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
  _noiseBurst({ dur, filterType, freqStart, freqEnd, gainPeak, attack = 0.005, delay = 0 }) {
    const t0 = this.ctx.currentTime + delay
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

  /**
   * Cannon fire. A broadside is `guns` individual shots, staggered a few
   * dozen ms apart with per-shot variation (no two guns bark alike), each
   * a layered voice: sharp crack, chest-punch boom, sub thump, rumble tail.
   * Distant volleys arrive at the SPEED OF SOUND — you see the flash, then
   * the thunder rolls in and echoes across the water.
   */
  cannon(dist = 0, guns = 1) {
    if (!this.ctx) return
    if (!this._gate('cannon', dist)) return
    this.resume()
    const v = this._vol(dist)
    if (v <= 0) return
    const near = Math.max(0.2, 1 - dist / 300)
    const travel = dist / 340   // world units ≈ metres; flash first, bang later
    const n = Math.max(1, Math.min(6, guns | 0))
    for (let i = 0; i < n; i++) {
      const delay = travel + (i === 0 ? 0 : i * 0.055 + Math.random() * 0.035)
      this._cannonShot(v / Math.sqrt(n) * (n > 1 ? 1.25 : 1), near, delay)
    }
    // Rolling slap-back off the water for far shots — the shore answers twice
    if (dist > 120) {
      const echoV = v * 0.3
      this._cannonShot(echoV, near * 0.5, travel + 0.28 + Math.random() * 0.08)
      this._cannonShot(echoV * 0.45, near * 0.35, travel + 0.62 + Math.random() * 0.12)
    }
  }

  /** One gun. A real recording when loaded (random pick, pitch-varied,
   *  distance-lowpassed) with a synthesised sub thump and rumble tail
   *  underneath for weight; pure synthesis as the fallback voice. */
  _cannonShot(v, near, delay = 0) {
    const bufs = this._cannonBufs
    if (bufs && bufs.length) {
      const t0 = this.ctx.currentTime + delay
      const src = this.ctx.createBufferSource()
      src.buffer = bufs[(Math.random() * bufs.length) | 0]
      src.playbackRate.value = 0.88 + Math.random() * 0.26

      // Per-shot character: a randomised EQ tilt (some shots barky, some
      // boomy), a wandering lowpass, a touch of stereo spread so a
      // broadside walks across the field, and loudness that breathes
      const tilt = this.ctx.createBiquadFilter()
      tilt.type = 'peaking'
      tilt.frequency.value = 250 + Math.random() * 1400
      tilt.Q.value = 0.7
      tilt.gain.value = -4 + Math.random() * 8
      const filter = this.ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = (500 + 11000 * near * near) * (0.8 + Math.random() * 0.45)
      const pan = this.ctx.createStereoPanner
        ? this.ctx.createStereoPanner() : null
      if (pan) pan.pan.value = (Math.random() - 0.5) * 0.7 * near
      const gain = this.ctx.createGain()
      gain.gain.value = Math.min(1, (0.9 + Math.random() * 0.3) * v)
      let node = src
      node = (node.connect(tilt), tilt)
      node = (node.connect(filter), filter)
      if (pan) node = (node.connect(pan), pan)
      node.connect(gain).connect(this._master)
      src.start(t0)

      // Occasional double-report: a second, quieter sample right behind the
      // first — some guns just bark twice off the water
      if (Math.random() < 0.18) {
        const s2 = this.ctx.createBufferSource()
        s2.buffer = bufs[(Math.random() * bufs.length) | 0]
        s2.playbackRate.value = 0.95 + Math.random() * 0.2
        const g2 = this.ctx.createGain()
        g2.gain.value = gain.gain.value * 0.35
        s2.connect(filter)
        s2.start(t0 + 0.05 + Math.random() * 0.05)
      }

      // Close shots get a randomised single slap off the water
      if (near > 0.6 && Math.random() < 0.5) {
        const dl = this.ctx.createDelay(0.3)
        dl.delayTime.value = 0.07 + Math.random() * 0.09
        const dg = this.ctx.createGain()
        dg.gain.value = 0.1 + Math.random() * 0.08
        gain.connect(dl).connect(dg).connect(this._master)
      }

      // A touch of sub under the recording, breathing a little itself
      this._tone({
        type: 'sine', freqStart: 50 + Math.random() * 14, freqEnd: 28,
        dur: 0.25 + Math.random() * 0.15, gainPeak: (0.16 + Math.random() * 0.12) * v,
        attack: 0.004, delay,
      })
      return
    }
    const pitch = 0.92 + Math.random() * 0.16
    // Crack: the instantaneous report (dulls with distance)
    this._noiseBurst({
      dur: 0.09, filterType: 'highpass',
      freqStart: 900 * near * pitch, freqEnd: 2400 * near,
      gainPeak: 0.5 * v * near, attack: 0.001, delay,
    })
    // Boom: the body of the blast
    this._noiseBurst({
      dur: 0.42, filterType: 'lowpass',
      freqStart: (240 + 760 * near) * pitch, freqEnd: 55,
      gainPeak: 0.85 * v, attack: 0.004, delay,
    })
    // Sub thump you feel more than hear
    this._tone({
      type: 'sine', freqStart: 62 * pitch, freqEnd: 30,
      dur: 0.35, gainPeak: 0.6 * v, attack: 0.004, delay,
    })
    // Rumble tail rolling away
    this._noiseBurst({
      dur: 1.3, filterType: 'lowpass',
      freqStart: 140, freqEnd: 40,
      gainPeak: 0.16 * v, attack: 0.05, delay: delay + 0.08,
    })
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

  // ── Ambience: real recordings, driven by live ship/world state ────────────
  // Beds (ocean wash, wind, luffing sails) loop with an equal-power crossfade
  // so the seams never click; one-shots (hull creaks, gull cries) fire on
  // randomized schedules whose density follows what the ship is doing.

  _startAmbient() {
    // Synth fallback bed — replaced by the recorded ocean once it decodes
    const src = this.ctx.createBufferSource()
    src.buffer = this._noise
    src.loop   = true

    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 420

    const gain = this.ctx.createGain()
    gain.gain.value = 0.05

    const lfo = this.ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 0.09
    const lfoDepth = this.ctx.createGain()
    lfoDepth.gain.value = 0.025
    lfo.connect(lfoDepth).connect(gain.gain)

    src.connect(filter).connect(gain).connect(this._master)
    src.start()
    lfo.start()
    this._synthBedGain = gain
  }

  async _loadAmbience() {
    const dec = async name => {
      const r = await fetch(`/assets/sounds/${name}.ogg`)
      if (!r.ok) throw new Error(name)
      return this.ctx.decodeAudioData(await r.arrayBuffer())
    }
    const tryDec = name => dec(name).catch(() => null)

    // One-shot pools: whatever decodes, plays
    this._creakBufs = (await Promise.all(
      [1, 2, 3, 4, 5, 6, 7].map(i => tryDec(`creak_${i}`)))).filter(Boolean)
    this._gullBufs = (await Promise.all(
      [1, 2, 3, 4, 5].map(i => tryDec(`gull_${i}`)))).filter(Boolean)

    // Beds — swap the synth surf out only if the recorded ocean made it
    const [ocean, wind, sail] = await Promise.all(
      ['amb_ocean', 'amb_wind', 'amb_sail'].map(tryDec))
    if (!this.ctx) return
    const t = this.ctx.currentTime
    if (ocean) {
      this._oceanGain = this.ctx.createGain()
      this._oceanGain.gain.value = 0.0001
      this._oceanGain.gain.setTargetAtTime(0.38, t, 2)
      this._oceanGain.connect(this._master)
      this._loopBed(ocean, this._oceanGain)
      if (this._synthBedGain) this._synthBedGain.gain.setTargetAtTime(0.0001, t, 2)
    }
    if (wind) {
      this._windGain = this.ctx.createGain()
      this._windGain.gain.value = 0.0001
      this._windGain.connect(this._master)
      this._loopBed(wind, this._windGain)
    }
    if (sail) {
      this._sailGain = this.ctx.createGain()
      this._sailGain.gain.value = 0.0001
      this._sailGain.connect(this._master)
      this._loopBed(sail, this._sailGain)
    }
  }

  /** Loop a buffer forever, overlapping each pass with an equal-power
   *  crossfade so the loop seam is inaudible. */
  _loopBed(buffer, dest, xfade = 1.5) {
    const period = Math.max(1, buffer.duration - xfade)
    const spawn = when => {
      if (!this.ctx) return
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(0.0001, when)
      g.gain.linearRampToValueAtTime(1, when + xfade)
      g.gain.setValueAtTime(1, when + period)
      g.gain.linearRampToValueAtTime(0.0001, when + period + xfade)
      src.connect(g).connect(dest)
      src.start(when)
      src.stop(when + period + xfade + 0.1)
      const ms = (when + period - this.ctx.currentTime) * 1000 - 250
      setTimeout(() => spawn(when + period), Math.max(50, ms))
    }
    spawn(this.ctx.currentTime + 0.05)
  }

  /** One-shot from a decoded buffer with per-play randomization. */
  _playAmbOneShot(buf, { delay = 0, gain = 0.2, rate = 1, pan = 0, lowpass = 0 } = {}) {
    const t0 = this.ctx.currentTime + delay
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = this.ctx.createGain()
    g.gain.value = gain
    let node = src
    if (lowpass) {
      const lp = this.ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = lowpass
      node.connect(lp); node = lp
    }
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, pan))
      node.connect(p); node = p
    }
    node.connect(g).connect(this._master)
    src.start(t0)
  }

  /**
   * Live ambience state from the game (10 Hz): wind knots, normalized ship
   * speed, rudder, whether the sails are luffing, and whether land is close.
   */
  ambience(st) {
    this._ambState = st
    if (!this.ctx) return
    const t = this.ctx.currentTime
    if (this._windGain) {
      const w = Math.min(0.55, Math.pow(Math.max(0, st.windKn) / 40, 1.3) * 0.55)
      this._windGain.gain.setTargetAtTime(Math.max(0.0001, w), t, 1.5)
    }
    if (this._sailGain) {
      this._sailGain.gain.setTargetAtTime(st.luffing ? 0.28 : 0.0001, t, 0.5)
    }
    if (this._oceanGain) {
      this._oceanGain.gain.setTargetAtTime(0.34 + 0.14 * (st.speedFrac || 0), t, 1.5)
    }
  }

  /** Hull and rigging creaks — the harder the ship works, the more it talks. */
  _scheduleCreak() {
    const s = this._ambState || {}
    const activity = Math.min(1,
      (s.speedFrac || 0) * 0.8 + Math.abs(s.rudder || 0) * 0.7 + (s.windKn || 0) / 60)
    const delay = (14000 - activity * 9000) * (0.6 + Math.random() * 0.8)
    this._creakTimer = setTimeout(() => {
      if (this.ctx && document.visibilityState === 'visible' && this._creakBufs?.length) {
        const buf = this._creakBufs[(Math.random() * this._creakBufs.length) | 0]
        const a = Math.min(1,
          ((this._ambState?.speedFrac || 0) * 0.8 + Math.abs(this._ambState?.rudder || 0) * 0.7))
        this._playAmbOneShot(buf, {
          gain: (0.09 + a * 0.15) * (0.8 + Math.random() * 0.4),
          rate: 0.9 + Math.random() * 0.2,
          pan: (Math.random() * 2 - 1) * 0.4,
        })
      }
      this._scheduleCreak()
    }, delay)
  }

  /** Gull cries — close and chatty near land, rare and distant at sea. */
  _scheduleGull() {
    const near = !!this._ambState?.nearLand
    const delay = near ? 6000 + Math.random() * 12000 : 30000 + Math.random() * 40000
    this._gullTimer = setTimeout(() => {
      if (this.ctx && document.visibilityState === 'visible' && this._gullBufs?.length) {
        const isNear = !!this._ambState?.nearLand
        const n = isNear ? 1 + ((Math.random() * 2) | 0) : 1
        for (let i = 0; i < n; i++) {
          this._playAmbOneShot(this._gullBufs[(Math.random() * this._gullBufs.length) | 0], {
            delay: i * (0.4 + Math.random() * 0.6),
            gain: (isNear ? 0.15 : 0.06) * (0.8 + Math.random() * 0.4),
            rate: 0.94 + Math.random() * 0.12,
            pan: (Math.random() * 2 - 1) * 0.7,
            lowpass: isNear ? 0 : 3200,
          })
        }
      }
      this._scheduleGull()
    }, delay)
  }
}
