/**
 * assets.js – Preloads all 3-D models before the game starts.
 *
 * Two pipelines:
 *   • GLB via GLTFLoader — the bundled Kenney CC0 packs.
 *   • FBX via FBXLoader — the "extra" props (community packs dropped into
 *     the repo's assets/ folder, converted here at runtime). FBX entries can
 *     name base-colour textures per material and are normalised to a target
 *     size with their base sitting at y=0, so placement code stays simple.
 *
 * Loading is all-or-nothing: a failed asset fails the preload. That matters
 * under lockstep — world generation consults hasAsset(), so every peer must
 * hold the exact same asset set or their worlds would diverge.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'

const _gltfLoader = new GLTFLoader()
const _fbxLoader  = new FBXLoader()
const _texLoader  = new THREE.TextureLoader()
const _cache      = new Map()   // key → THREE.Group ready to clone

/**
 * Full list of assets to preload.
 * GLB entries: [key, path]
 * FBX entries: [key, path, { fbx: true, norm: maxDimension, tex: {materialNameSubstr: texPath} }]
 *   tex '' key = fallback texture for every material.
 */
export const ASSET_MANIFEST = [
  // ── Kenney Pirate Kit ships ───────────────────────────────────────────────
  ['ship-pirate-large',       '/assets/kenney-pirate/ship-pirate-large.glb'],
  ['ship-pirate-medium',      '/assets/kenney-pirate/ship-pirate-medium.glb'],
  ['ship-pirate-small',       '/assets/kenney-pirate/ship-pirate-small.glb'],
  ['ship-wreck',              '/assets/kenney-pirate/ship-wreck.glb'],
  ['ship-ghost',              '/assets/kenney-pirate/ship-ghost.glb'],

  // ── Kenney Pirate Kit island props ────────────────────────────────────────
  ['palm-detailed-bend',      '/assets/kenney-pirate/palm-detailed-bend.glb'],
  ['palm-detailed-straight',  '/assets/kenney-pirate/palm-detailed-straight.glb'],
  ['rocks-a',                 '/assets/kenney-pirate/rocks-a.glb'],
  ['rocks-b',                 '/assets/kenney-pirate/rocks-b.glb'],
  ['rocks-c',                 '/assets/kenney-pirate/rocks-c.glb'],
  ['rocks-sand-a',            '/assets/kenney-pirate/rocks-sand-a.glb'],
  ['barrel',                  '/assets/kenney-pirate/barrel.glb'],
  ['chest',                   '/assets/kenney-pirate/chest.glb'],
  ['cannon',                  '/assets/kenney-pirate/cannon.glb'],
  ['tower-large',             '/assets/kenney-pirate/tower-complete-large.glb'],
  ['tower-small',             '/assets/kenney-pirate/tower-complete-small.glb'],
  ['dock',                    '/assets/kenney-pirate/structure-platform-dock.glb'],
  ['dock-small',              '/assets/kenney-pirate/structure-platform-dock-small.glb'],
  ['flag-high',               '/assets/kenney-pirate/flag-pirate-high.glb'],
  ['grass-patch',             '/assets/kenney-pirate/grass-patch.glb'],
  ['patch-grass',             '/assets/kenney-pirate/patch-grass-foliage.glb'],
  ['patch-sand',              '/assets/kenney-pirate/patch-sand-foliage.glb'],
  ['boat-row',                '/assets/kenney-pirate/boat-row-large.glb'],

  // ── Kenney Fantasy Town Kit (harbor market) ───────────────────────────────
  ['stall-a',                 '/assets/kenney-town/stall.glb'],
  ['stall-b',                 '/assets/kenney-town/stall-red.glb'],
  ['stall-c',                 '/assets/kenney-town/stall-green.glb'],

  // ── Kenney Watercraft Kit ─────────────────────────────────────────────────
  ['buoy',                    '/assets/kenney-watercraft/buoy.glb'],
  ['buoy-flag',               '/assets/kenney-watercraft/buoy-flag.glb'],
  ['boat-sail-a',             '/assets/kenney-watercraft/boat-sail-a.glb'],
  ['boat-sail-b',             '/assets/kenney-watercraft/boat-sail-b.glb'],

  // ── Kenney Nature Kit (self-contained vertex colours) ─────────────────────
  ['tree-palm-tall',          '/assets/kenney-nature/tree_palmDetailedTall.glb'],
  ['tree-palm-short',         '/assets/kenney-nature/tree_palmDetailedShort.glb'],
  ['tree-palm-bend',          '/assets/kenney-nature/tree_palmBend.glb'],
  ['tree-palm-plain',         '/assets/kenney-nature/tree_palmTall.glb'],
  ['tree-oak',                '/assets/kenney-nature/tree_oak.glb'],
  ['tree-detailed',           '/assets/kenney-nature/tree_detailed.glb'],
  ['rock-large-a',            '/assets/kenney-nature/rock_largeA.glb'],
  ['rock-large-b',            '/assets/kenney-nature/rock_largeB.glb'],
  ['rock-large-c',            '/assets/kenney-nature/rock_largeC.glb'],
  ['rock-tall-a',             '/assets/kenney-nature/rock_tallA.glb'],
  ['rock-tall-b',             '/assets/kenney-nature/rock_tallB.glb'],

  // ── Extra props (community packs from assets/, see ASSETS-NOTE in README) ─
  ['x-chest',     '/assets/extra/chest2.fbx',
    { fbx: true, norm: 3.4,  tex: { '': '/assets/extra/chest2.png' } }],
  ['x-barrel',    '/assets/extra/barrel2.fbx',
    { fbx: true, norm: 2.4,  tex: { '': '/assets/extra/barrelbox.png' } }],
  ['x-box',       '/assets/extra/box2.fbx',
    { fbx: true, norm: 2.2,  tex: { '': '/assets/extra/barrelbox.png' } }],
  ['x-coin',      '/assets/extra/coin.fbx',
    { fbx: true, norm: 1.0,  tex: { '': '/assets/extra/coin.png' } }],
  ['x-ballista',  '/assets/extra/ballista.fbx',
    { fbx: true, norm: 4.2,  tex: { '': '/assets/extra/ballista.png' } }],
  ['x-farmhouse', '/assets/extra/farmhouse.fbx',
    { fbx: true, norm: 16, tex: {
      house: '/assets/extra/farmhouse-house.png',
      roof: '/assets/extra/farmhouse-roof.png',
      wood: '/assets/extra/farmhouse-wood.png',
      boxes: '/assets/extra/farmhouse-boxes.png',
      '': '/assets/extra/farmhouse-l1.png',
    } }],
  ['x-well',      '/assets/extra/well.fbx',
    { fbx: true, norm: 4.5 }],
  ['x-coconut1',  '/assets/extra/coconut1.fbx',
    { fbx: true, norm: 11, tex: { '': '/assets/extra/coconut.png' } }],
  ['x-coconut2',  '/assets/extra/coconut2.fbx',
    { fbx: true, norm: 10, tex: { '': '/assets/extra/coconut.png' } }],
  ['x-banana',    '/assets/extra/banana.fbx',
    { fbx: true, norm: 7.5, tex: { '': '/assets/extra/banana.png' } }],
  ['x-smallship', '/assets/extra/smallship.fbx',
    { fbx: true, norm: 9, tex: { '': '/assets/extra/smallship-pal.png' } }],
  // Blender-converted GLBs (see ASSETS-NOTE); normalised like the FBX props
  ['x-piratebase', '/assets/extra/pirate-base.glb', { norm: 26 }],
  ['x-treasure',   '/assets/extra/treasure.glb',    { norm: 3.2 }],
  ['x-windmill',   '/assets/extra/windmill.glb',    { norm: 20 }],
]

function loadTexture(path) {
  return new Promise((resolve, reject) => {
    _texLoader.load(path, tex => {
      tex.colorSpace = THREE.SRGBColorSpace
      resolve(tex)
    }, undefined, reject)
  })
}

/** Scale to a target max dimension, centre horizontally, base at y=0. */
function normalizeAndGround(obj, norm) {
  const box  = new THREE.Box3().setFromObject(obj)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  obj.scale.setScalar((norm ?? 3) / maxDim)
  const box2   = new THREE.Box3().setFromObject(obj)
  const center = box2.getCenter(new THREE.Vector3())
  const wrap = new THREE.Group()
  obj.position.set(-center.x, -box2.min.y, -center.z)
  wrap.add(obj)
  return wrap
}

/** Load one FBX entry: texture it, normalise its size, ground it at y=0. */
async function loadFbx(path, opts) {
  const obj = await _fbxLoader.loadAsync(path)

  // Per-material base-colour textures, matched by material name substring
  const texMap = opts.tex ?? null
  const loaded = {}
  if (texMap) {
    for (const [key, texPath] of Object.entries(texMap)) {
      loaded[key] = await loadTexture(texPath)
    }
  }

  obj.traverse(child => {
    if (!child.isMesh) return
    child.castShadow = true
    const pick = mat => {
      if (!texMap) return mat   // keep whatever the FBX carries (e.g. colours)
      const name = (mat?.name ?? '').toLowerCase()
      let tex = loaded['']
      for (const key of Object.keys(loaded)) {
        if (key && name.includes(key)) { tex = loaded[key]; break }
      }
      return new THREE.MeshStandardMaterial({
        map: tex ?? null,
        color: tex ? 0xffffff : (mat?.color ?? 0x999999),
        roughness: 0.85,
        metalness: 0,
      })
    }
    child.material = Array.isArray(child.material)
      ? child.material.map(pick)
      : pick(child.material)
  })

  return normalizeAndGround(obj, opts.norm)
}

/**
 * Preload every asset listed in ASSET_MANIFEST.
 * @param {(progress: number) => void} [onProgress]
 */
export async function preloadAssets(onProgress) {
  const total  = ASSET_MANIFEST.length
  let   loaded = 0

  for (const [name, path, opts] of ASSET_MANIFEST) {
    if (opts?.fbx) {
      _cache.set(name, await loadFbx(path, opts))
    } else {
      const gltf = await _gltfLoader.loadAsync(path)
      gltf.scene.traverse(child => {
        if (child.isMesh) {
          child.castShadow    = true
          child.receiveShadow = true
        }
      })
      _cache.set(name, opts?.norm
        ? normalizeAndGround(gltf.scene, opts.norm)
        : gltf.scene)
    }
    loaded++
    onProgress?.(loaded / total)
  }
}

/**
 * Deep-clone a loaded asset and return the cloned THREE.Group.
 * Throws if the asset hasn't been preloaded yet.
 */
export function cloneAsset(name) {
  const root = _cache.get(name)
  if (!root) {
    // The mobile landing renders the world WITHOUT the preload (10+ MB of
    // props nobody can play with on a phone) — missing assets become empty
    // stand-ins. Desktop always preloads all-or-nothing, so a miss there
    // is a programming error worth a loud console line, not a crash.
    if (!_warned.has(name)) {
      _warned.add(name)
      console.warn(`[assets] "${name}" not loaded — using an empty stand-in`)
    }
    return new THREE.Group()
  }
  return root.clone(true)
}
const _warned = new Set()

/** Returns true if the named asset is available in the cache. */
export function hasAsset(name) {
  return _cache.has(name)
}
