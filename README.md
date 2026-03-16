# ⚓ Sea of Friends

A Sea of Thieves-esque browser sandbox game where players sail the same ocean and interact entirely peer-to-peer — **no backend, no servers**.

## How it works

| Layer | Technology |
|---|---|
| **3D rendering** | [Three.js](https://threejs.org/) – GPU-shader ocean, procedural sky, fully rigged ships |
| **Peer discovery** | [Trystero](https://github.com/dmotz/trystero) `torrent` strategy – BitTorrent DHT & WebTorrent tracker network |
| **P2P transport** | WebRTC DataChannels – binary data, ~80 ms position updates |
| **NAT traversal** | WebRTC ICE / STUN (Google + Cloudflare public servers) |
| **IPv6** | Supported natively by WebRTC if the browser & network permit |

There is no custom signalling server, no database, and no REST API.  
Peer discovery relies entirely on the public BitTorrent DHT infrastructure.

## Running locally

```bash
npm install
npm run dev        # http://localhost:3000
```

## Building for production

```bash
npm run build      # output in dist/
npm run preview    # serve the production build
```

## Gameplay

| Key | Action |
|---|---|
| `W` / `↑` | Sail forward |
| `S` / `↓` | Reverse |
| `A` / `←` | Turn port |
| `D` / `→` | Turn starboard |
| Mouse drag | Rotate camera |
| Scroll | Zoom |
| Click canvas | Lock cursor for mouse-look |
| `T` | Open chat |
| `ESC` | Close chat / release cursor |

Every player automatically connects to everyone else in the same logical world (`world-1`) via the DHT.  
Ships are colour-coded per player; name labels float above the mast.
