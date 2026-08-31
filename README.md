
# ⚓ Sea of Friends

A Sea of Thieves-esque browser battle sandbox where players sail the same ocean, blast each other with broadsides, and fight off AI ghost ships — entirely peer-to-peer, **no backend, no servers**.

## How it works

| Layer | Technology |
|---|---|
| **3D rendering** | [Three.js](https://threejs.org/) – GPU-shader ocean, procedural sky, fully rigged ships |
| **Peer discovery** | [Trystero](https://github.com/dmotz/trystero) `torrent` strategy – BitTorrent DHT & WebTorrent tracker network |
| **P2P transport** | WebRTC DataChannels – reliable lane for bootstrap/cmds, unreliable lane for 20 Hz inputs |
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
├── main.js       Entry point — wires game, network, chat, and voice UI
├── game.js       Rendering, input capture, camera, HUD (interpolated at 60 fps)
├── sim.js        THE deterministic 20 Hz world simulation (lockstep core)
├── lockstep.js   Lockstep netcode: input streams, snapshots, hashes, roster
├── dmath.js      Deterministic math (sin/cos/atan2/RNG from IEEE-exact ops)
├── world.js      GPU-shader ocean, sky, seeded islands (with collision)
├── ship.js       Ship model; sim physics + interpolated render split
├── combat.js     Cannonballs, broadsides, particles, hit detection
├── ai.js         Ghost-ship fleet — simulated identically by every peer
├── forts.js      Garrisoned island forts guarding treasure
├── powerups.js   Power-ups & floating treasure chests
├── map.js        The captain's chart (M)
├── sfx.js        Procedural Web Audio sound effects (no audio files)
├── network.js    Trystero room: input packets + lockstep bootstrap only
├── audio.js      Proximity voice chat
└── assets.js     Kenney GLB asset preloader
```

## Gameplay

| Key | Action |
|---|---|
| `W` / `↑` | Raise sails (more canvas = more speed) |
| `S` / `↓` | Lower sails / row astern when furled |
| `A` / `←` | Crank the wheel to port (it stays where you set it) |
| `D` / `→` | Crank the wheel to starboard |
| `A`+`D` together | Centre the wheel — the helmsman then **holds your heading** |
| **`Q`** | **Fire port broadside** |
| **`E`** | **Fire starboard broadside** |
| **`Space`** | **Fire the camera-facing battery** (port / starboard / bow chasers) |
| **Hold Right-click** | **Aim the cannons** – mouse ↑↓ elevates the barrels, a dotted arc + splash ring shows where the volley lands |
| **Left-click** (while aiming) | Fire the aimed battery |
| **`M`** | **The captain's chart** – world map with islands, you, enemy captains, ghost ships, and power-ups |
| **⏏** (top right) | **Abandon ship** – click twice to quit back to the menu (your purse drops where you left it!) |
| Mouse drag | Rotate camera (traverses the aim while aiming) |
| Scroll | Zoom |
| Click canvas | Lock cursor for mouse-look |
| `Enter` | Open chat |
| `ESC` | Close chat / release cursor |

### ⚓ Ships

Pick your hull on the join screen — the choice is part of the lockstep join,
so every peer simulates the same ship:

| Class | Guns (side + bow) | Hull | Character |
|---|---|---|---|
| **Sloop** | 1 + 1 | 70 | Fastest and most nimble — hit and run |
| **Frigate** | 3 + 2 | 100 | The all-rounder |
| **Man-o'-War** | 5 + 4 | 150 | Slow, ponderous, devastating broadsides |

### ⛵ Sailing

- A shared **wind** blows across the whole sea — a pure function of the
  simulation clock, identical on every peer with zero network traffic.
  It wanders over a few minutes; the HUD arrow under the compass shows it
  relative to your bow (green = favourable, red = in your teeth).
- W/S **trim the sails** rather than throttling: set your canvas and the ship
  keeps way on while you man the guns.
- **Sea-of-Thieves helm**: A/D crank the wheel and it stays put; hold both to
  centre it, and a centred wheel means the helmsman **holds your heading**
  for you (imperfectly — it wanders a touch with wind and waves). Set a
  course, then walk your fire onto the target.
- Boat speed is a **multiple of the true wind speed** (shown next to the wind
  arrow): a beam reach (wind abeam, 90°) makes **1.35× wind** — faster than
  the wind itself — a dead run downwind matches the wind exactly, and
  close-hauled makes ~0.6×. Dead upwind is the **no-go zone** — the sails
  luff, the HUD warns "⚠ IN IRONS", and you must **tack** back and forth at
  ~45° to make way. Ghost ships obey the same wind and tack too.
- These are men-o'-war with real **momentum**: ~8 s from a standstill to
  full way, and dropping all canvas still leaves the ship coasting a long
  while. Hard rudder bleeds speed. Plan your broadside passes. The camera's
  field of view widens and the bow wave grows as the ship gathers way.
- Ships **heel** under crosswind pressure and lean into turns.
- **Ramming is a weapon.** Hulls collide for real (three-circle keels,
  mass-weighted push-apart): strike with your BOW and the victim takes the
  full impact — scaling with closing speed and the rammer's heft, holing
  the waterline on a solid hit — while the aggressor shrugs off a fraction.
  Bow-to-bow splits the pain; a side-swipe scrapes both. Ram kills credit
  the rammer, purse and all.
- Stopped ships can **pivot in place** — the crew hauls the bow around far
  faster than the rudder alone once way is lost.

### 🗺 Procedural seas

- Islands are real **low-poly terrain**: flat-shaded, vertex-coloured meshes
  from a seeded height function — sand shores that slip under the water,
  grassy slopes, rocky ridges, crater-topped volcanoes, and atolls with
  sailable lagoon entrances. The SAME height function drives flora and
  building placement (buildings verify all four footprint corners sit on
  dry land), fort foundations, and cannonball terrain collisions — shots
  can clear a low saddle and forts enjoy real defilade.

- Every room gets its own procedurally generated 7 km × 7 km world: ~40
  islands across four archetypes — classic palm isles, towering volcanoes,
  ring atolls with lagoon entrances, and low rock reefs that will gut a
  careless hull.
- **Whoever enters the room first charts the world.** The world is fully
  determined by a seed, so "downloading the world from the creator" is
  literally downloading that seed over the data channel and regenerating an
  identical world locally — instant, no matter how big the map.
- Every peer stores and re-announces the seed to newcomers, so the world
  **outlives its creator**. If two lone captains chart worlds simultaneously
  and then meet, the older chart wins deterministically on every client.

Every player automatically connects to everyone else in the same logical world (`world-1`) via the DHT.  
Ships are colour-coded per player; name labels float above the mast.

### ⚔ Combat

- Each broadside fires a 3-ball volley with a 3-second reload per side.
- **Aimed fire**: hold right-click to man the cannons Sea-of-Thieves style.
  **The camera picks the battery** — look across port or starboard for the
  broadside (which traverses a full ±57°, from near the bow to well aft —
  only a cone dead astern is blind), or dead ahead for the **bow chasers**.
  Mouse ↑↓ sets elevation, swinging the camera sets windage, the deck guns
  visibly swivel with your aim, and a dotted trajectory arc with a splash
  ring shows exactly where the volley lands. Ghost ships and forts range
  their shots with the same height-aware ballistics.
- Cannons recoil when they fire; every ship carries six visible deck guns.
- **Hit location matters**: a ball on the **waterline** opens a leak that
  floods the hull for ~20 s (they stack — break off or find repairs); a ball
  through the **rigging** shreds canvas and slows the ship; clean hull hits
  do the most direct damage. Status effects show under the hull bar.
- **Power-ups** bob on the waves under coloured beacons: 💚 hull repairs
  (+35 and plugs all leaks), 🔵 half reload for 30 s, 🛡 half damage for
  30 s, 🔴 chain shot (next 3 broadsides fly faster, farther, and hit ~50%
  harder), 🎯 **master gunner** (your next 2 volleys each add one PERFECTLY
  aimed shot — an exact intercept solved from your velocity and the
  target's course at the moment of firing). The sim keeps ~8 stocked;
  whoever sails over one first gets it — deterministic, no claim races.
- **Forts** 🏰 some islands are garrisoned: a stone tower with a mounted
  **ballista** that looses actual bolts — faster and flatter than round shot,
  and they **shred your rigging wherever they hit**. It fires on any ship
  loitering in range (with proper height-compensated ballistics — a bolt
  from a 13-metre tower flies very differently from a deck gun). Bombard it until it crumbles and its
  strongbox (🪙 120–270, seeded per fort) washes into the shallows for anyone
  to claim. The garrison rebuilds a few minutes later. Forts show as squares
  on the chart — hollow once cracked.
- **Gold** ⚓ when any ship sinks, its plunder drops into the water as a
  **floating treasure chest** at the wreck: 🪙 100 from a ghost ship, or a
  player's entire purse. **Nobody is owed it** — the killer, a vulture
  circling the fight, or even the victim racing back after respawn can
  snatch it first. Unclaimed chests sink for good after a few minutes.
  Sinking a player also pays the killer a small 🪙 25 bounty outright.
  Standings show on the crew scoreboard.
- Ships have 100 hull points; a full volley on target does ~36 damage.
- At 0 HP a ship sinks with a full animation, then respawns after 7 s with
  brief spawn protection (which you forfeit by firing).
- Kills and deaths are tallied on the crew scoreboard (top right); sinkings
  are announced in the kill feed (system chat).
- **Ghost ships** 👻 — three AI-controlled ghost ships roam the sea, hunt
  anyone within range, circle to bring their guns to bear, and fire back.
  Sinking one earns a kill; it respawns elsewhere a little later.
- Islands are solid: ram one and you'll stop with a thud. Cannonballs are
  blocked by them too, so use the terrain.
- All sound effects (cannons, splashes, hull hits, sinking, ambient surf and
  gulls) are synthesised in the browser with the Web Audio API — no audio
  files shipped.

### Lockstep determinism: how it stays fair without a server

The game runs **deterministic lockstep** — the architecture behind classic
RTS multiplayer, adapted to the open sea:

- **Only inputs cross the network.** Twenty times a second every peer
  broadcasts a tiny packet — rudder, sail trim, fire + aim. Nobody ever
  sends positions, damage, or gold. Inputs ride an **unreliable, unordered
  datachannel** (no head-of-line blocking from retransmits) with each packet
  carrying the last few inputs redundantly, so lost datagrams simply don't
  matter; roster commands and channel-less peers fall back to the reliable
  lane.
- **Every peer simulates everything.** Ships, ghost fleet, forts, power-ups,
  treasure, damage rolls — one shared state machine (`sim.js`) advanced with
  a fixed 20 Hz timestep. All simulation math goes through `dmath.js`, a
  deterministic layer built only from IEEE-exact operations (JS specifies
  bit-exact `+−×÷`/`sqrt` but NOT `Math.sin`/`cos`/`random`), so every
  peer's world is **bit-identical**. Rendering interpolates between ticks at
  full display rate.
- **Cheating is structural, not policed.** There is no health packet to
  forge and no authority to fool: a modified client simply computes a
  different world, and the periodic state-hash exchange flags the desync to
  the whole crew within two seconds. Inputs are validated by construction —
  the sim accepts only legal rudder/sail/fire values, and reload gating
  happens inside the shared sim.
- **Prediction + rollback (GGPO-style).** Two timelines run over the input
  streams. The **confirmed** timeline is classic lockstep — it advances only
  on complete real inputs and carries everything consequential (roster
  changes, state hashes, join snapshots). The **predicted** timeline is what
  you see: it runs ahead toward the wall clock using real inputs where
  they've arrived and synthesized ones (course held, guns silent — fires are
  never predicted) where they haven't. When a late input disagrees, the sim
  rolls back to the confirmed snapshot and re-simulates — a laggy crewmate
  costs a small invisible correction instead of freezing your ocean. Sounds
  and feed messages are deduplicated per tick so re-simulation never
  double-plays a broadside. Peers whose clocks run ahead bleed back
  automatically, so the prediction window converges to the real network
  latency. Own input lands in 100 ms (2 ticks), masked by ship momentum.
- **Joining and leaving.** A newcomer bootstraps from any running peer's
  CONFIRMED snapshot (deterministic state is equally valid from anyone) and
  fast-forwards on live inputs; roster changes ride inside the input stream
  of the lowest-id peer so they land on the same tick everywhere. When
  someone disconnects, the crew agrees on their final input tick, relays
  anything missing, and their ship (and purse!) goes down deterministically.
- **Partitions heal.** A network split leaves two live crews that ejected
  each other; when connectivity returns their state hashes disagree, and
  after a persistent streak exactly one side yields — the smaller crew (or
  on a tie, the one whose lowest peer id sorts higher) demotes and rejoins
  from the winner's snapshot, like any late joiner.
- **The sea persists.** Every ten seconds the confirmed world state is
  saved to localStorage per room code. When you sail into a room and nobody
  answers, your saved sea resumes where it left off — forts, treasure,
  tick, and your own purse included. The last captain ashore keeps the
  world.
- **Nobody can hold the sea hostage.** Prediction rides through hiccups up
  to 2 s. Past that the screen holds ("⚓ Waiting for the crew…"), and a peer
  silent for ~6 s more is ejected through the same departure protocol as a
  disconnect — the ejected peer detects its own departure, demotes, and
  rejoins automatically from a fresh snapshot when it recovers.
  Backgrounded tabs keep ticking via a timer and never trigger any of this.
- **Wifi blips are lossless.** A silently dropped peer's ship is **parked**
  — sails struck, holding station, still part of the world — for 45 s.
  Reconnect inside the grace and you're back at the helm of your own ship,
  purse intact; only after expiry (or a deliberate quit, which says goodbye
  on the way out) does the ship go down and the purse drift overboard.

### 🎞 Replays

A deterministic sim means **a snapshot plus the input stream is a
bit-perfect replay**. Every session records its confirmed timeline;
`/replay` downloads it, and "🎞 Watch a replay" on the menu plays one back —
follow-cam with `N` to cycle ships, `1-4` for speed, `Space` to pause.

### 🏴 Strangers, votekick, and the board

- **Public session board**: check "List this sea publicly" on the menu and
  your room appears in "Seas taking crew" on everyone's menu — name, crew
  size, world age — one click to board. Strictly **opt-in per room**;
  unlisted seas stay exactly as private as their room code. Listings are
  version-filtered (you only see seas your build can actually join) and
  heartbeat-refreshed by the crew's orderer to the signaling Worker.
- **Votekick**: ☠ on a crew row (or `/votekick <name>`) casts a ballot; a
  strict majority of the live crew ejects the target through the same
  deterministic departure machinery as a disconnect — no grace, and the
  orderer refuses their rejoin for five minutes. A peer whose state hashes
  keep diverging gets a votekick suggestion in the feed automatically.
- **Per-player mute**: 🔇 on a crew row (or `/mute <name>`) silences a
  captain's voice *and* chat for you alone.

### ⚙ CI

Every push runs a **determinism gate** on GitHub Actions: two real browser
peers over a local tracker with 150 ms artificial input lag, sailing and
firing for 30 seconds under constant prediction + rollback — then every
overlapping state hash must match and the desync tripwire must stay silent.
One careless `Math.random()` in sim code fails CI, not a crew at sea.

### 🌐 Hosting

The game is static files + P2P — hosting is just a CDN. Production lives on
Cloudflare Pages at **https://sea-of-friends.com** (deploy with
`npx wrangler pages deploy dist --project-name sea-of-friends`). Peer
discovery leads with our own always-up signaling relay — a ~100-line
Durable Object speaking the WebTorrent tracker protocol
(`workers/signal/`) — with the public BitTorrent trackers as fallback.
NAT traversal uses public STUN, plus **on-demand Cloudflare TURN** for the
symmetric-NAT pairs STUN can't crack: a Pages Function
(`functions/turn-creds.js`) mints short-lived relay credentials, and ICE
only touches them when direct paths fail. Everything sits in free tiers at
friends scale. LAN/offline crews can point at their own tracker with
`?relays=ws://host:port`.

### 🎤 Voice

- **3-D proximity voice**: every voice runs through an HRTF spatial panner at
  the speaker's ship — crewmates sound like they're where they are, fading
  naturally with distance.
- **Efficient on the wire**: mono Opus capture, voice-activity gating (the
  mic track transmits nothing between utterances), and **range-targeted
  delivery** — your audio is only sent to peers who can actually hear it,
  with hysteresis so sailing along the edge of earshot doesn't thrash
  renegotiation.
- **Crew channels**: open the voice panel (🎤) and join a named channel — or
  `/channel <name>` in chat. The name is a shared secret, like a room code:
  everyone announcing the same name hears each other **at full volume at any
  distance**, while everyone else stays proximity-only. `/channel off`
  to leave.

### 📦 Asset packs (`assets/`)

Raw community packs dropped into the git-ignored `assets/` folder are
converted into the game: FBX loads at runtime via three.js's FBXLoader with
downscaled base-colour textures; `.blend` files are exported to GLB with
headless Blender (via `nix shell nixpkgs#blender`); `.unitypackage` files are
just gzipped tars — models and textures pull straight out; RAR5 archives open
with `nix shell nixpkgs#unar`. Everything is normalised to a target size and
grounded at y=0 on load (see `src/assets.js`).

Currently in the world: treasure chest + coins (+ a spilling treasure pile on
hauls ≥ 200 gold), the fort ballistas, farmhouse / well / windmill / crates
and rare **pirate camps** on settled isles, a beached sailing boat on their
shores, and coconut & banana trees mixed into the island flora.
**Check each pack's licence before publishing this repo's `public/` folder.**

**Attributions** (found assets): menu scroll — "Paper Scroll 2" by
OpenClipart via Wikimedia Commons (CC0); quill cursor — "Feather" icon by
Lorc, game-icons.net (CC BY 3.0); fort loot chest/coins, ballista, farmhouse
and other props from their respective packs in `assets/` — verify each
before redistribution.

## How P2P Works

1. **Signaling** — `trystero/torrent` announces your presence on public
   BitTorrent WebSocket trackers. No custom server needed.
2. **NAT traversal** — WebRTC uses STUN to discover your public IP and
   performs ICE connectivity checks to hole-punch through NATs.
3. **Data channel** — Once connected, peers exchange only per-tick INPUT
   packets (rudder, sails, fire) over encrypted WebRTC data channels at
   20 Hz; every client runs the identical deterministic simulation, so no
   game state ever needs to cross the wire.

