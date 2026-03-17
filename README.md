<<<<<<< HEAD
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
| `Enter` | Open chat |
| `ESC` | Close chat / release cursor |

Every player automatically connects to everyone else in the same logical world (`world-1`) via the DHT.  
Ships are colour-coded per player; name labels float above the mast.
=======
# Sea of Friends

A Sea of Thieves–inspired sandbox game that connects players directly via
**peer-to-peer WebRTC** — no backend required.

Peers discover each other through **BitTorrent DHT trackers**, and WebRTC's
built-in **ICE/STUN** handles NAT hole-punching so players behind routers can
still connect.

## Tech Stack

| Layer | Library |
|-------|---------|
| 3D rendering | [three.js](https://threejs.org) |
| P2P networking | [trystero](https://github.com/dmotz/trystero) (BitTorrent strategy) |
| Build tool | [Vite](https://vite.dev) |

## Getting Started

```bash
npm install
npm run dev
```

Open the URL shown by Vite (usually `http://localhost:5173`).

1. Enter a **room code** — any short string you choose.
2. Share the same room code with a friend.
3. Both players join the same ocean and can see each other's ships.

### Controls

| Key | Action |
|-----|--------|
| W / S | Forward / reverse |
| A / D | Turn left / right |
| Space | Speed boost |
| Mouse | Look around (click to capture pointer) |

## Architecture

```
src/
├── main.js              Entry point — wires game, network, and UI
├── game/
│   ├── engine.js        Three.js renderer, scene, camera
│   ├── ocean.js         Animated shader-based ocean
│   ├── sky.js           Procedural sky dome + lighting
│   ├── ship.js          Ship model, physics, wave bobbing
│   ├── world.js         Manages local + remote ships
│   └── input.js         Keyboard & pointer-lock input
├── network/
│   └── peer.js          Trystero room, state sync at 15 Hz
└── ui/
    └── hud.js           Lobby overlay + in-game HUD
```

## How P2P Works

1. **Signaling** — `trystero/torrent` announces your presence on public
   BitTorrent WebSocket trackers. No custom server needed.
2. **NAT traversal** — WebRTC uses STUN to discover your public IP and
   performs ICE connectivity checks to hole-punch through NATs.
3. **Data channel** — Once connected, game state (position, heading, speed)
   is sent directly between peers over an encrypted WebRTC data channel at
   ~15 updates per second.
>>>>>>> master
