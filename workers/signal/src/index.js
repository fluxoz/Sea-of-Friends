/**
 * sea-of-friends-signal — deterministic peer discovery on a Durable Object.
 *
 * Speaks the WebTorrent tracker WebSocket protocol (the subset Trystero's
 * torrent strategy uses), so the game client treats it as just another
 * relay URL — no client-side protocol code. Public BitTorrent trackers
 * remain in the relay list as fallback; this one is simply always up.
 *
 *   client → { action:'announce', info_hash, peer_id, offers:[{offer, offer_id}] }
 *   DO     → stats to the announcer, each offer forwarded to another swarm peer
 *   client → { action:'announce', info_hash, peer_id, to_peer_id, offer_id, answer }
 *   DO     → answer relayed to the offerer; WebRTC takes it from there.
 *
 * One DO instance holds every swarm — at friends scale that is a handful of
 * sockets, comfortably inside the free tier.
 */

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('sea-of-friends signaling: connect via WebSocket', { status: 200 })
    }
    const id = env.SWARM.idFromName('global')
    return env.SWARM.get(id).fetch(request)
  },
}

const ANNOUNCE_INTERVAL = 120   // seconds between client re-announces

export class Swarm {
  constructor(state) {
    this.state = state
    /** @type {Map<string, WebSocket>} peer_id → socket */
    this.peers = new Map()
    /** @type {Map<string, Set<string>>} info_hash → peer_ids */
    this.swarms = new Map()
    /** @type {Map<WebSocket, {peerId: string|null, hashes: Set<string>}>} */
    this.socks = new Map()
  }

  fetch(_request) {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()
    this.socks.set(server, { peerId: null, hashes: new Set() })
    server.addEventListener('message', ev => this._onMessage(server, ev))
    const drop = () => this._dropSocket(server)
    server.addEventListener('close', drop)
    server.addEventListener('error', drop)
    return new Response(null, { status: 101, webSocket: client })
  }

  _onMessage(ws, ev) {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (!msg || msg.action !== 'announce' || typeof msg.info_hash !== 'string'
        || typeof msg.peer_id !== 'string') return
    if (msg.info_hash.length > 64 || msg.peer_id.length > 64) return

    const meta = this.socks.get(ws)
    if (!meta) return

    // Register the peer in the swarm
    meta.peerId = msg.peer_id
    this.peers.set(msg.peer_id, ws)
    let swarm = this.swarms.get(msg.info_hash)
    if (!swarm) { swarm = new Set(); this.swarms.set(msg.info_hash, swarm) }
    swarm.add(msg.peer_id)
    meta.hashes.add(msg.info_hash)

    // An answer to someone's offer — relay it home
    if (msg.answer && typeof msg.to_peer_id === 'string') {
      this._send(this.peers.get(msg.to_peer_id), {
        action: 'announce',
        info_hash: msg.info_hash,
        peer_id: msg.peer_id,
        offer_id: msg.offer_id,
        answer: msg.answer,
      })
      return
    }

    // Fresh announce: stats back, offers fanned out to the rest of the swarm
    this._send(ws, {
      action: 'announce',
      interval: ANNOUNCE_INTERVAL,
      info_hash: msg.info_hash,
      complete: swarm.size,
      incomplete: 0,
    })
    if (Array.isArray(msg.offers) && msg.offers.length) {
      const others = [...swarm].filter(id => id !== msg.peer_id)
      let i = 0
      for (const { offer, offer_id } of msg.offers.slice(0, 20)) {
        if (i >= others.length) break
        this._send(this.peers.get(others[i++]), {
          action: 'announce',
          info_hash: msg.info_hash,
          peer_id: msg.peer_id,
          offer,
          offer_id,
        })
      }
    }
  }

  _send(ws, obj) {
    if (!ws) return
    try { ws.send(JSON.stringify(obj)) } catch { this._dropSocket(ws) }
  }

  _dropSocket(ws) {
    const meta = this.socks.get(ws)
    if (!meta) return
    this.socks.delete(ws)
    if (meta.peerId && this.peers.get(meta.peerId) === ws) this.peers.delete(meta.peerId)
    for (const h of meta.hashes) {
      const swarm = this.swarms.get(h)
      if (!swarm) continue
      swarm.delete(meta.peerId)
      if (swarm.size === 0) this.swarms.delete(h)
    }
    try { ws.close() } catch { /* already gone */ }
  }
}
