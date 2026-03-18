/**
 * assets.js – Preloads all Kenney GLB models before the game starts.
 *
 * Assets come from three free CC0 Kenney packs bundled in public/assets/:
 *   • kenney-pirate    – ships, palms, rocks, props  (colormap texture atlas)
 *   • kenney-watercraft – sailing boats, buoys       (colormap texture atlas)
 *   • kenney-nature    – trees, rocks                (vertex colours, no external texture)
 *
 * License: Creative Commons CC0 – https://creativecommons.org/publicdomain/zero/1.0/
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const _loader = new GLTFLoader()
const _cache  = new Map()

/**
 * Full list of assets to preload.
 * Each entry: [cacheKey, publicPath]
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
]

/**
 * Preload every asset listed in ASSET_MANIFEST.
 * @param {(progress: number) => void} [onProgress]  called with 0..1 as each file loads
 */
export async function preloadAssets(onProgress) {
  const total  = ASSET_MANIFEST.length
  let   loaded = 0

  for (const [name, path] of ASSET_MANIFEST) {
    const gltf = await _loader.loadAsync(path)

    // Enable shadow-casting/receiving on all meshes
    gltf.scene.traverse(child => {
      if (child.isMesh) {
        child.castShadow    = true
        child.receiveShadow = true
      }
    })

    _cache.set(name, gltf)
    loaded++
    onProgress?.(loaded / total)
  }
}

/**
 * Deep-clone a loaded asset's scene and return the cloned THREE.Group.
 * Throws if the asset hasn't been preloaded yet.
 */
export function cloneAsset(name) {
  const gltf = _cache.get(name)
  if (!gltf) throw new Error(`Asset not loaded: "${name}"`)
  return gltf.scene.clone(true)
}

/** Returns true if the named asset is available in the cache. */
export function hasAsset(name) {
  return _cache.has(name)
}
