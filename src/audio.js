/**
 * audio.js – Proximity voice chat with 3-D spatial audio and crew channels.
 *
 * Quality: each peer's voice runs through an HRTF PannerNode positioned at
 * their ship, with the listener at the camera — voices come from the right
 * direction and fade with distance naturally.
 *
 * Efficiency (WebRTC already gives us Opus; we make it cheap to carry):
 *   • mono capture (one Opus channel, not two)
 *   • voice-activity gating: the mic track is disabled between utterances,
 *     so silence costs almost nothing on the wire
 *   • range-targeted delivery: your stream is only sent to peers who can
 *     actually hear you (in proximity range, or in your crew channel),
 *     with hysteresis + debounce so renegotiation doesn't flap
 *
 * Crew channels: a channel is a shared-secret name (like a room code).
 * Everyone announcing the same name hears each other at full volume at any
 * distance; everyone else stays proximity-only.
 */

/** World-unit distance beyond which voices are completely inaudible. */
const MAX_HEAR_DISTANCE = 230
/** Stream-delivery hysteresis: start sending inside IN, stop beyond OUT. */
const RANGE_IN   = 205
const RANGE_OUT  = 245
/** How long a peer must stay out of range before we stop sending (ms). */
const OUT_DEBOUNCE_MS = 4000
/** Voice-activity gate: RMS threshold + hangover. */
const VAD_THRESHOLD = 0.03
const VAD_HOLD_MS   = 500

export class ProximityAudio {
  constructor() {
    this._context      = null
    this._localStream  = null
    this._micTrack     = null
    /** @type {Map<string, {source, direct, pgain, panner, el}>} */
    this._peerNodes    = new Map()
    this._pendingStreams = new Map()
    this._enabled      = false
    this._muted        = false
    this._pttMode      = false
    this._pttHeld      = false
    this._vadMode      = true    // auto-gate silence in always-on mode
    this._vadOpen      = false
    this._vadLastVoice = 0
    this._analyser     = null
    this._analyserSrc  = null
    this._analyserBuf  = null
    this._nearbyPeerIds = []
    this._addStreamFn  = null
    this._removeStreamFn = null
    /** @type {Map<string, {sent:boolean, outSince:number}>} delivery targets */
    this._targets = new Map()
    this._vadTimer = null
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  _applyMicEnabled() {
    if (!this._micTrack) return
    const open = this._pttMode
      ? this._pttHeld
      : (!this._vadMode || this._vadOpen)
    this._micTrack.enabled = !this._muted && open
  }

  _connectAnalyser(stream) {
    if (!this._context) return
    if (this._analyserSrc) {
      try { this._analyserSrc.disconnect() } catch {}
    }
    this._analyser    = this._context.createAnalyser()
    this._analyser.fftSize = 256
    this._analyserBuf = new Uint8Array(this._analyser.frequencyBinCount)
    this._analyserSrc = this._context.createMediaStreamSource(stream)
    this._analyserSrc.connect(this._analyser)
  }

  _disconnectAnalyser() {
    if (this._analyserSrc) {
      try { this._analyserSrc.disconnect() } catch {}
      this._analyserSrc = null
    }
    this._analyser    = null
    this._analyserBuf = null
  }

  _disconnectPeer(peerId) {
    const nodes = this._peerNodes.get(peerId)
    if (!nodes) return
    try {
      nodes.source.disconnect()
      nodes.direct.disconnect()
      nodes.pgain.disconnect()
      nodes.panner.disconnect()
      nodes.el.pause()
      nodes.el.srcObject = null
    } catch {}
    this._peerNodes.delete(peerId)
  }

  setStreamHandlers(addStream, removeStream, onStream) {
    this._addStreamFn    = addStream
    this._removeStreamFn = removeStream
    onStream((stream, peerId) => this._attachPeerStream(stream, peerId))
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async enable() {
    if (this._enabled) return true
    try {
      this._localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
          channelCount: 1,        // mono → half the Opus payload of stereo
        },
        video: false,
      })
      this._micTrack = this._localStream.getAudioTracks()[0] ?? null

      this._context = new AudioContext()

      this._pendingStreams.forEach((stream, peerId) => {
        this._attachPeerStream(stream, peerId)
      })
      this._pendingStreams.clear()

      this._connectAnalyser(this._localStream)
      this._applyMicEnabled()

      // Voice-activity gate: open the mic on speech, close it after a short
      // hangover. A disabled track sends near-silent frames — the practical
      // equivalent of Opus DTX, with no SDP surgery.
      this._vadTimer = setInterval(() => {
        if (!this._enabled || this._pttMode) return
        const level = this.getInputLevel()
        const now = performance.now()
        if (level > VAD_THRESHOLD) this._vadLastVoice = now
        const open = now - this._vadLastVoice < VAD_HOLD_MS
        if (open !== this._vadOpen) {
          this._vadOpen = open
          this._applyMicEnabled()
        }
      }, 80)

      // NOTE: no global addStream here — delivery is range/channel-targeted
      // per peer inside update().
      this._enabled = true
      return true
    } catch (err) {
      console.error('[ProximityAudio] getUserMedia failed:', err)
      return false
    }
  }

  disable() {
    if (!this._enabled) return
    clearInterval(this._vadTimer)
    for (const [peerId, t] of this._targets) {
      if (t.sent && this._removeStreamFn) {
        try { this._removeStreamFn(this._localStream, peerId) } catch {}
      }
    }
    this._targets.clear()
    if (this._localStream) {
      this._localStream.getTracks().forEach(t => t.stop())
      this._localStream = null
      this._micTrack    = null
    }
    this._peerNodes.forEach((_n, peerId) => this._disconnectPeer(peerId))
    this._peerNodes.clear()
    this._pendingStreams.clear()
    this._disconnectAnalyser()
    if (this._context) {
      this._context.close().catch(() => {})
      this._context = null
    }
    this._enabled = false
  }

  // ── Per-peer stream management ─────────────────────────────────────────────

  _attachPeerStream(stream, peerId) {
    // Range-gated delivery renegotiates streams; a trackless stream event
    // means the peer stopped sending to us — tear down instead of attaching.
    if (!stream || stream.getAudioTracks().length === 0) {
      this._pendingStreams.delete(peerId)
      this._disconnectPeer(peerId)
      return
    }
    if (!this._context) {
      this._pendingStreams.set(peerId, stream)
      return
    }
    if (this._context.state === 'suspended') this._context.resume().catch(() => {})
    this._disconnectPeer(peerId)

    // Chrome quirk: a remote MediaStream must be attached to a media element
    // before WebAudio reliably receives samples.
    const el = new Audio()
    el.srcObject = stream
    el.muted = true
    el.play().catch(() => {})

    const source = this._context.createMediaStreamSource(stream)

    // Two paths, crossfaded by channel membership:
    //   crew channel → direct gain (full volume, no spatialisation)
    //   proximity    → HRTF panner positioned at their ship
    const direct = this._context.createGain()
    direct.gain.value = 0
    source.connect(direct)
    direct.connect(this._context.destination)

    const pgain = this._context.createGain()
    pgain.gain.value = 1
    const panner = this._context.createPanner()
    panner.panningModel  = 'HRTF'
    panner.distanceModel = 'linear'
    panner.refDistance   = 20
    panner.maxDistance   = MAX_HEAR_DISTANCE
    panner.rolloffFactor = 1
    source.connect(pgain)
    pgain.connect(panner)
    panner.connect(this._context.destination)

    this._peerNodes.set(peerId, { source, direct, pgain, panner, el })
  }

  removePeer(peerId) {
    this._pendingStreams.delete(peerId)
    this._targets.delete(peerId)
    this._disconnectPeer(peerId)
  }

  // ── Frame update: spatialisation, channels, delivery targeting ─────────────

  /**
   * @param {object} args
   * @param {{x,y,z}} args.listener            camera position
   * @param {{x,z}}   args.forward             camera forward (horizontal)
   * @param {string|null} args.myChannel       our crew channel ('' / null = none)
   * @param {Map<string, {x,y,z, vc}>} args.peers  pid → ship pos + their channel
   * @param {string[]} args.connectedIds       every connected peer (delivery)
   */
  update({ listener, forward, myChannel, peers, connectedIds }) {
    if (!this._enabled || !this._context) return
    const ctx = this._context
    const t = ctx.currentTime

    // Listener at the camera, facing where the player looks
    const L = ctx.listener
    if (L.positionX) {
      L.positionX.setTargetAtTime(listener.x, t, 0.05)
      L.positionY.setTargetAtTime(listener.y, t, 0.05)
      L.positionZ.setTargetAtTime(listener.z, t, 0.05)
      L.forwardX.setTargetAtTime(forward.x, t, 0.05)
      L.forwardY.setTargetAtTime(0, t, 0.05)
      L.forwardZ.setTargetAtTime(forward.z, t, 0.05)
      L.upX.setTargetAtTime(0, t, 0.05); L.upY.setTargetAtTime(1, t, 0.05); L.upZ.setTargetAtTime(0, t, 0.05)
    } else {
      L.setPosition(listener.x, listener.y, listener.z)
      L.setOrientation(forward.x, 0, forward.z, 0, 1, 0)
    }

    const chan = myChannel || null
    const nearby = []

    this._peerNodes.forEach((nodes, peerId) => {
      const info = peers.get(peerId)
      const sameChannel = !!(chan && info && info.vc === chan)
      nodes.direct.gain.setTargetAtTime(sameChannel ? 1 : 0, t, 0.1)
      nodes.pgain.gain.setTargetAtTime(sameChannel ? 0 : 1, t, 0.1)
      if (info) {
        if (nodes.panner.positionX) {
          nodes.panner.positionX.setTargetAtTime(info.x, t, 0.05)
          nodes.panner.positionY.setTargetAtTime(info.y ?? 0, t, 0.05)
          nodes.panner.positionZ.setTargetAtTime(info.z, t, 0.05)
        } else {
          nodes.panner.setPosition(info.x, info.y ?? 0, info.z)
        }
        const dist = Math.hypot(listener.x - info.x, listener.z - info.z)
        if (sameChannel || dist < MAX_HEAR_DISTANCE) nearby.push(peerId)
      } else if (sameChannel) {
        nearby.push(peerId)
      }
    })
    this._nearbyPeerIds = nearby

    // ── Delivery targeting: only ship our stream to those who can hear it ──
    if (this._localStream && this._addStreamFn) {
      const now = performance.now()
      for (const pid of connectedIds) {
        const info = peers.get(pid)
        const sameChannel = !!(chan && info && info.vc === chan)
        const dist = info ? Math.hypot(listener.x - info.x, listener.z - info.z) : 0
        // Unknown position (still joining) → deliver, to be safe
        const audible = sameChannel || !info || dist < RANGE_IN
        const wayOut  = info && !sameChannel && dist > RANGE_OUT

        let tgt = this._targets.get(pid)
        if (!tgt) { tgt = { sent: false, outSince: 0 }; this._targets.set(pid, tgt) }

        if (audible) {
          tgt.outSince = 0
          if (!tgt.sent) {
            tgt.sent = true
            try { this._addStreamFn(this._localStream, pid) } catch {}
          }
        } else if (wayOut && tgt.sent) {
          if (!tgt.outSince) tgt.outSince = now
          else if (now - tgt.outSince > OUT_DEBOUNCE_MS) {
            tgt.sent = false
            tgt.outSince = 0
            try { this._removeStreamFn(this._localStream, pid) } catch {}
          }
        }
      }
      for (const pid of [...this._targets.keys()]) {
        if (!connectedIds.includes(pid)) this._targets.delete(pid)
      }
    }
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  setMuted(muted) {
    this._muted = muted
    this._applyMicEnabled()
  }

  setPttMode(enabled) {
    this._pttMode = enabled
    if (!enabled) this._pttHeld = false
    this._applyMicEnabled()
  }

  pressPTT()   { if (this._pttMode) { this._pttHeld = true;  this._applyMicEnabled() } }
  releasePTT() { if (this._pttMode) { this._pttHeld = false; this._applyMicEnabled() } }

  async setInputDevice(deviceId) {
    if (!this._enabled) return
    try {
      const audioConstraints = {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      }
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints, video: false,
      })
      // Swap the track for every current delivery target
      for (const [pid, tgt] of this._targets) {
        if (tgt.sent && this._removeStreamFn) {
          try { this._removeStreamFn(this._localStream, pid) } catch {}
          tgt.sent = false
        }
      }
      this._localStream.getTracks().forEach(t => t.stop())
      this._localStream = newStream
      this._micTrack    = newStream.getAudioTracks()[0] ?? null
      this._applyMicEnabled()
      this._connectAnalyser(newStream)
      // Delivery targeting re-adds the new stream on the next update()
    } catch (err) {
      console.error('[ProximityAudio] setInputDevice failed:', err)
    }
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  isEnabled()      { return this._enabled }
  isMuted()        { return this._muted   }
  isPttMode()      { return this._pttMode }
  isPttHeld()      { return this._pttHeld }
  /** True while the mic track is actually transmitting (VAD/PTT open). */
  isTransmitting() { return !!this._micTrack?.enabled }

  getInputLevel() {
    if (!this._analyser || !this._analyserBuf) return 0
    this._analyser.getByteTimeDomainData(this._analyserBuf)
    let sumSq = 0
    const len  = this._analyserBuf.length
    for (let i = 0; i < len; i++) {
      const v = (this._analyserBuf[i] - 128) / 128
      sumSq += v * v
    }
    return Math.sqrt(sumSq / len)
  }

  getNearbyPeerIds() { return this._nearbyPeerIds }
}
