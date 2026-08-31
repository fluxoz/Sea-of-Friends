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
    const url = new URL(request.url)
    const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    if (!isWs && !url.pathname.startsWith('/board/')) {
      return new Response('sea-of-friends signaling: connect via WebSocket', { status: 200 })
    }
    const id = env.SWARM.idFromName('global')
    return env.SWARM.get(id).fetch(request)
  },
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
    /** Session board: room → {players, age, v, seenAt}. Opt-in listings,
     *  heartbeat-refreshed; stale rows fall off after 90 s. */
    this.board = new Map()
  }

  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/board/')) return this._board(request, url)
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

  async _board(request, url) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    const now = Date.now()
    for (const [room, row] of this.board) {
      if (now - row.seenAt > 90000) this.board.delete(room)
    }

    if (url.pathname === '/board/announce' && request.method === 'POST') {
      let body
      try { body = await request.json() } catch { body = null }
      const room = typeof body?.room === 'string' ? body.room.slice(0, 32) : ''
      if (!room || this.board.size >= 200) {
        return new Response('{"ok":false}', { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      this.board.set(room, {
        players: Math.max(1, Math.min(64, body.players | 0)),
        age: Math.max(0, body.age | 0),
        v: String(body.v ?? '').slice(0, 20),
        seenAt: now,
      })
      return new Response('{"ok":true}', { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (url.pathname === '/board/list') {
      const v = url.searchParams.get('v') ?? ''
      const rows = [...this.board.entries()]
        .filter(([, r]) => !v || r.v === v)   // only seas you can actually join
        .map(([room, r]) => ({ room, players: r.players, age: r.age }))
        .sort((a, b) => b.players - a.players)
        .slice(0, 50)
      return new Response(JSON.stringify({ seas: rows }), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    }

    return new Response('not found', { status: 404, headers: CORS })
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
