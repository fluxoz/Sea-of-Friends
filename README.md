
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

## Nix

A [`flake.nix`](./flake.nix) is provided for reproducible development, building and deployment.

### Prerequisites

- [Nix](https://nixos.org/download/) with flakes enabled
- (optional) [direnv](https://direnv.net/) + [nix-direnv](https://github.com/nix-community/nix-direnv) for automatic shell activation

### Development shell

```bash
# enter the dev shell (provides node + npm)
nix develop

# or let direnv activate it automatically (one-time setup)
direnv allow
```

Inside the shell the usual npm workflow applies:

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
npm run preview
```

### Building

```bash
nix build        # builds dist/ → result/
```

> **First run:** `buildNpmPackage` requires a dependency hash.  
> Run `nix build` once — it will fail and print the correct hash.  
> Replace `pkgs.lib.fakeHash` in `flake.nix` with that value, then run `nix build` again.

### Running (production preview)

```bash
nix run          # builds + serves via vite preview
```

### Development server via Nix

```bash
nix run .#dev    # starts the Vite dev server
```

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

## How P2P Works

1. **Signaling** — `trystero/torrent` announces your presence on public
   BitTorrent WebSocket trackers. No custom server needed.
2. **NAT traversal** — WebRTC uses STUN to discover your public IP and
   performs ICE connectivity checks to hole-punch through NATs.
3. **Data channel** — Once connected, game state (position, heading, speed)
   is sent directly between peers over an encrypted WebRTC data channel at
   ~15 updates per second.

