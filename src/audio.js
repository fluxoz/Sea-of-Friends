/**
 * audio.js – Proximity-based voice chat.
 *
 * Uses the browser's getUserMedia API to capture the local microphone and
 * Trystero's stream API to exchange raw WebRTC audio tracks with every peer
 * in the room.  The Web Audio API GainNode is used to attenuate each peer's
 * volume according to the distance between ships, producing a natural
 * "you can only hear nearby sailors" effect.
 */

/** World-unit distance beyond which voices are completely inaudible. */
const MAX_HEAR_DISTANCE = 200

export class ProximityAudio {
  constructor() {
    this._context      = null
    this._localStream  = null
    this._micTrack     = null
    /** @type {Map<string, {source: MediaStreamAudioSourceNode, gainNode: GainNode}>} */
    this._peerNodes    = new Map()
    this._enabled      = false
    this._muted        = false
    this._addStreamFn  = null
    this._removeStreamFn = null
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  /**
   * Provide the Trystero room stream helpers.  Call this once the room is
   * available (before enable()).
   *
   * @param {Function} addStream    room.addStream
   * @param {Function} removeStream room.removeStream
   * @param {Function} onStream     room.onStream
   */
  setStreamHandlers(addStream, removeStream, onStream) {
    this._addStreamFn    = addStream
    this._removeStreamFn = removeStream

    onStream((stream, peerId) => {
      this._attachPeerStream(stream, peerId)
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Request microphone access and start sharing audio with all peers.
   * @returns {Promise<boolean>} true on success, false if permission denied.
   */
  async enable() {
    if (this._enabled) return true
    try {
      this._localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      this._micTrack = this._localStream.getAudioTracks()[0] ?? null
      if (this._micTrack) this._micTrack.enabled = !this._muted

      // AudioContext must be created after a user gesture; it should be fine
      // here because enable() is always triggered by a button click.
      this._context = new AudioContext()

      if (this._addStreamFn) this._addStreamFn(this._localStream)

      this._enabled = true
      return true
    } catch (err) {
      console.error('[ProximityAudio] getUserMedia failed:', err)
      return false
    }
  }

  /** Stop all local and remote audio and release resources. */
  disable() {
    if (!this._enabled) return

    if (this._localStream) {
      if (this._removeStreamFn) {
        try { this._removeStreamFn(this._localStream) } catch {}
      }
      this._localStream.getTracks().forEach(t => t.stop())
      this._localStream = null
      this._micTrack    = null
    }

    this._peerNodes.forEach(({ gainNode, source }) => {
      try { source.disconnect(); gainNode.disconnect() } catch {}
    })
    this._peerNodes.clear()

    if (this._context) {
      this._context.close().catch(() => {})
      this._context = null
    }

    this._enabled = false
  }

  // ── Per-peer stream management ─────────────────────────────────────────────

  _attachPeerStream(stream, peerId) {
    if (!this._context) return
    // Resume context if suspended (autoplay policy)
    if (this._context.state === 'suspended') this._context.resume().catch(() => {})

    const source   = this._context.createMediaStreamSource(stream)
    const gainNode = this._context.createGain()
    gainNode.gain.value = 1.0
    source.connect(gainNode)
    gainNode.connect(this._context.destination)

    this._peerNodes.set(peerId, { source, gainNode })
  }

  /** Clean up audio graph for a peer who has left the room. */
  removePeer(peerId) {
    const nodes = this._peerNodes.get(peerId)
    if (!nodes) return
    try { nodes.source.disconnect(); nodes.gainNode.disconnect() } catch {}
    this._peerNodes.delete(peerId)
  }

  // ── Volume update (called every frame) ────────────────────────────────────

  /**
   * Attenuate each peer's audio based on the 2-D distance between ships.
   *
   * @param {{x:number, z:number}} localPos   local ship position
   * @param {Map<string,{x:number,z:number}>} peerPositions  peerId → position
   */
  updateVolumes(localPos, peerPositions) {
    if (!this._enabled || !this._context) return

    this._peerNodes.forEach((nodes, peerId) => {
      const pos = peerPositions.get(peerId)
      if (!pos) return
      const dx   = localPos.x - pos.x
      const dz   = localPos.z - pos.z
      const dist = Math.sqrt(dx * dx + dz * dz)
      // Smooth quadratic fall-off to zero at MAX_HEAR_DISTANCE
      const t    = Math.max(0, 1 - dist / MAX_HEAR_DISTANCE)
      nodes.gainNode.gain.value = t * t
    })
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  /**
   * Mute or unmute the local microphone without stopping the stream so that
   * the WebRTC track remains alive (avoids renegotiation).
   */
  setMuted(muted) {
    this._muted = muted
    if (this._micTrack) this._micTrack.enabled = !muted
  }

  /**
   * Switch to a different audio input device while voice chat is active.
   * @param {string} deviceId  MediaDeviceInfo.deviceId
   */
  async setInputDevice(deviceId) {
    if (!this._enabled) return
    try {
      const audioConstraints = deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      })

      // Stop old tracks and replace
      if (this._removeStreamFn) {
        try { this._removeStreamFn(this._localStream) } catch {}
      }
      this._localStream.getTracks().forEach(t => t.stop())

      this._localStream = newStream
      this._micTrack    = newStream.getAudioTracks()[0] ?? null
      if (this._micTrack) this._micTrack.enabled = !this._muted

      if (this._addStreamFn) this._addStreamFn(newStream)
    } catch (err) {
      console.error('[ProximityAudio] setInputDevice failed:', err)
    }
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  isEnabled() { return this._enabled }
  isMuted()   { return this._muted   }
}
