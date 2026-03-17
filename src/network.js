/**
 * network.js
 *
 * Peer-to-peer networking using Trystero with the BitTorrent DHT (torrent)
 * strategy. This means:
 *  - Peer *discovery* uses the public BitTorrent DHT / WebTorrent trackers
 *    (no custom signalling server required).
 *  - Actual data transport uses WebRTC DataChannels which handle NAT
 *    hole-punching via ICE/STUN and support IPv6 natively.
 */
import { joinRoom } from 'trystero/torrent'

/** Public STUN servers used by WebRTC for NAT traversal and IPv6. */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

const APP_ID = 'sea-of-friends-v1'

/** Interval (ms) between latency pings sent to each peer. */
const PING_INTERVAL = 2000

export class NetworkManager {
  /**
   * @param {string} roomId – logical "world" name; all players in the same
   *   room connect to each other via the DHT.
   */
  constructor(roomId = 'world-1') {
    this.peers = new Map() // peerId → {id, name, color, latency}
    this._localInfo = null
    this._pingTimestamps = new Map() // peerId → performance.now() of last ping

    // Callbacks set by Game
    this.onPeerJoin = null
    this.onPeerLeave = null
    this.onPeerPosition = null
    this.onPeerInfo = null
    this.onChat = null
    this.onPeerLatency = null

    const room = joinRoom(
      { appId: APP_ID, rtcConfig: { iceServers: ICE_SERVERS } },
      roomId,
    )
    this._room = room

    // ── Data channels ──────────────────────────────────────────────────────
    // Short action names keep payload overhead minimal.
    const [sendPos, onPos]   = room.makeAction('p')  // position
    const [sendInfo, onInfo] = room.makeAction('i')  // player info
    const [sendChat, onChat] = room.makeAction('c')  // chat message
    const [sendPing, onPing] = room.makeAction('pg') // latency ping
    const [sendPong, onPong] = room.makeAction('po') // latency pong

    this._sendPos  = sendPos
    this._sendInfo = sendInfo
    this._sendChat = sendChat

    // ── Peer lifecycle ─────────────────────────────────────────────────────
    room.onPeerJoin(peerId => {
      this.peers.set(peerId, { id: peerId })
      // Immediately introduce ourselves to the new peer.
      if (this._localInfo) sendInfo(this._localInfo, [peerId])
      if (this.onPeerJoin) this.onPeerJoin(peerId)
    })

    room.onPeerLeave(peerId => {
      this._pingTimestamps.delete(peerId)
      this.peers.delete(peerId)
      if (this.onPeerLeave) this.onPeerLeave(peerId)
    })

    // ── Incoming data ──────────────────────────────────────────────────────
    onPos((data, peerId) => {
      const peer = this.peers.get(peerId)
      if (peer) {
        peer.lastPos = data.p
        peer.lastRot = data.r
      }
      if (this.onPeerPosition) this.onPeerPosition(peerId, data)
    })

    onInfo((data, peerId) => {
      const peer = this.peers.get(peerId)
      if (peer) Object.assign(peer, data)
      if (this.onPeerInfo) this.onPeerInfo(peerId, data)
    })

    onChat((data, peerId) => {
      if (this.onChat) this.onChat(peerId, data)
    })

<<<<<<< HEAD
    // ── Latency ping / pong ────────────────────────────────────────────────
    // When we receive a ping from a peer, reply immediately with a pong.
    onPing((_data, peerId) => {
      sendPong({}, [peerId])
    })

    // When we receive a pong, compute the round-trip time.
    onPong((_data, peerId) => {
      const sent = this._pingTimestamps.get(peerId)
      if (sent === undefined) return
      const rtt = Math.round(performance.now() - sent)
      const peer = this.peers.get(peerId)
      if (peer) peer.latency = rtt
      if (this.onPeerLatency) this.onPeerLatency(peerId, rtt)
    })

    // Periodically ping every connected peer.
    setInterval(() => {
      this.peers.forEach((_peer, peerId) => {
        this._pingTimestamps.set(peerId, performance.now())
        sendPing({}, [peerId])
      })
    }, PING_INTERVAL)
=======
    // ── Audio stream helpers ───────────────────────────────────────────────
    // Thin wrappers so the ProximityAudio module does not need a direct
    // reference to the internal Trystero room object.
    this.addStream    = (stream, targets) => room.addStream(stream, targets)
    this.removeStream = (stream, targets) => room.removeStream(stream, targets)
    this.onStream     = cb              => room.onPeerStream(cb)
>>>>>>> master
  }

  /** Announce our name & colour to all current and future peers. */
  setLocalInfo(name, color) {
    this._localInfo = { name, color }
    this._sendInfo(this._localInfo)
  }

  /**
   * Broadcast our ship position/rotation at the configured send rate.
   * @param {{x,y,z}} pos
   * @param {number} rotY
   * @param {number} speed  0–1 normalised
   */
  sendPosition(pos, rotY, speed) {
    this._sendPos({
      p: [
        Math.round(pos.x * 10) / 10,
        Math.round(pos.y * 100) / 100,
        Math.round(pos.z * 10) / 10,
      ],
      r: Math.round(rotY * 1000) / 1000,
      s: Math.round(speed * 100) / 100,
    })
  }

  /** Broadcast a chat message to every connected peer. */
  sendChatMessage(text) {
    this._sendChat({ t: text })
  }

  getPeer(peerId) {
    return this.peers.get(peerId)
  }

  /** Return the colour hex string that was set via setLocalInfo, or null. */
  getLocalColor() {
    return this._localInfo?.color ?? null
  }

  /** Total player count including the local player. */
  getPeerCount() {
    return this.peers.size + 1
  }
}
