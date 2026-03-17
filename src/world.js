/**
 * world.js – Ocean (GPU shader), sky dome, islands, and Kenney 3D prop decorations.
 *
 * The ocean is rendered entirely on the GPU via a ShaderMaterial so there is
 * no per-frame CPU vertex-buffer update.  A matching JS wave function is
 * exported so the game can read the wave height at any (x, z) for ship bobbing.
 *
 * Island and ambient props use free CC0 assets from three Kenney packs:
 *   • Pirate Kit       – https://kenney.nl/assets/pirate-kit
 *   • Watercraft Kit   – https://kenney.nl/assets/watercraft-kit
 *   • Nature Kit       – https://kenney.nl/assets/nature-kit
 */
import * as THREE from 'three'
import { cloneAsset, hasAsset } from './assets.js'

const WORLD_SIZE  = 5000
const ISLAND_COUNT = 14

/** Half the world extent; ships are clamped to stay inside this boundary. */
export const WORLD_HALF = WORLD_SIZE / 2

// ── Shared wave parameters ────────────────────────────────────────────────────
// These must be kept in sync between the GLSL vertex shader and waveHeight().
export const WAVE_PARAMS = [
  { freq: 0.022, speed: 0.85, amp: 0.80, dirX: 1.0, dirZ: 0.7 },
  { freq: 0.016, speed: 0.60, amp: 0.55, dirX: -0.6, dirZ: 1.0 },
  { freq: 0.011, speed: 1.20, amp: 0.35, dirX: 0.8, dirZ: -0.5 },
  { freq: 0.034, speed: 1.50, amp: 0.20, dirX: -0.5, dirZ: -0.9 },
]

/** JS equivalent of the GLSL wave sum (used for CPU-side ship bobbing). */
export function waveHeight(x, z, t) {
  let h = 0
  for (const w of WAVE_PARAMS) {
    h += Math.sin((x * w.dirX + z * w.dirZ) * w.freq + t * w.speed) * w.amp
  }
  return h
}

// ── GLSL ──────────────────────────────────────────────────────────────────────
const OCEAN_VERT = /* glsl */ `
  uniform float uTime;
  varying float vH;
  varying vec3  vNormal;
  varying vec3  vWorldPos;

  float singleWave(vec3 pos, float freq, float speed, float amp,
                   float dirX, float dirZ) {
    return sin((pos.x * dirX + pos.z * dirZ) * freq + uTime * speed) * amp;
  }

  void main() {
    vec3 p = position;

    float h = 0.0;
    h += singleWave(p, 0.022, 0.85, 0.80,  1.0,  0.7);
    h += singleWave(p, 0.016, 0.60, 0.55, -0.6,  1.0);
    h += singleWave(p, 0.011, 1.20, 0.35,  0.8, -0.5);
    h += singleWave(p, 0.034, 1.50, 0.20, -0.5, -0.9);
    p.y = h;
    vH = h;
    vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;

    // Finite-difference normal
    float eps = 3.0;
    float hx = singleWave(p + vec3(eps,0,0), 0.022,0.85,0.80, 1.0, 0.7)
             + singleWave(p + vec3(eps,0,0), 0.016,0.60,0.55,-0.6, 1.0)
             + singleWave(p + vec3(eps,0,0), 0.011,1.20,0.35, 0.8,-0.5)
             + singleWave(p + vec3(eps,0,0), 0.034,1.50,0.20,-0.5,-0.9);
    float hz = singleWave(p + vec3(0,0,eps), 0.022,0.85,0.80, 1.0, 0.7)
             + singleWave(p + vec3(0,0,eps), 0.016,0.60,0.55,-0.6, 1.0)
             + singleWave(p + vec3(0,0,eps), 0.011,1.20,0.35, 0.8,-0.5)
             + singleWave(p + vec3(0,0,eps), 0.034,1.50,0.20,-0.5,-0.9);
    vNormal = normalize(vec3(h - hx, eps, h - hz));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

const OCEAN_FRAG = /* glsl */ `
  uniform vec3  uDeepColor;
  uniform vec3  uShallowColor;
  uniform vec3  uSunDir;
  uniform float uTime;
  varying float vH;
  varying vec3  vNormal;
  varying vec3  vWorldPos;

  void main() {
    // Base colour – depth tint
    float t = clamp((vH + 2.0) / 3.5, 0.0, 1.0);
    vec3 col = mix(uDeepColor, uShallowColor, t);

    // Diffuse lighting
    vec3 n   = normalize(vNormal);
    vec3 sun = normalize(uSunDir);
    float diff = clamp(dot(n, sun), 0.0, 1.0) * 0.6 + 0.4;
    col *= diff;

    // Specular (Blinn-Phong)
    vec3 viewDir = normalize(vec3(0.2, 1.0, 0.5));
    vec3 half_   = normalize(sun + viewDir);
    float spec   = pow(clamp(dot(n, half_), 0.0, 1.0), 80.0);
    col += vec3(1.0) * spec * 0.55;

    // Foam at wave crests
    float foam = smoothstep(0.6, 1.3, vH);
    col = mix(col, vec3(0.88, 0.93, 1.0), foam * 0.55);

    gl_FragColor = vec4(col, 0.93);
  }
`

// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic PRNG (LCG) seeded with an integer. */
function makeRNG(seed) {
  let s = seed >>> 0
  return () => {
    s = Math.imul(s, 1664525) + 1013904223
    return (s >>> 0) / 0xffffffff
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class World {
  constructor(scene) {
    this.scene    = scene
    this._time    = 0
    this._oceanMat = null
  }

  build() {
    this._buildSky()
    this._buildOcean()
    this._buildIslands()
  }

  /** Advance ocean time. Call every frame with delta-seconds. */
  tick(dt) {
    this._time += dt
    if (this._oceanMat) {
      this._oceanMat.uniforms.uTime.value = this._time
    }
  }

  getTime() { return this._time }

  // ──────────────────────────────────────────────────────────────────────────
  // Sky
  // ──────────────────────────────────────────────────────────────────────────

  _buildSky() {
    // Gradient sky dome
    const skyGeo = new THREE.SphereGeometry(2400, 16, 8)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop:    { value: new THREE.Color(0x0055dd) },
        uBottom: { value: new THREE.Color(0x88ccff) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        varying vec3 vDir;
        void main() {
          float t = clamp(pow(max(normalize(vDir).y, 0.0), 0.5), 0.0, 1.0);
          gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
        }
      `,
    })
    this.scene.add(new THREE.Mesh(skyGeo, skyMat))

    // Sun disc
    const sunDir = new THREE.Vector3(0.5, 0.38, -0.78).normalize()
    const sunPos = sunDir.clone().multiplyScalar(2000)
    const sun    = new THREE.Mesh(
      new THREE.CircleGeometry(90, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe880, transparent: true, opacity: 0.95 }),
    )
    sun.position.copy(sunPos)
    sun.lookAt(new THREE.Vector3())
    this.scene.add(sun)

    // Glow halo
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(160, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe880, transparent: true, opacity: 0.22 }),
    )
    glow.position.copy(sunPos)
    glow.lookAt(new THREE.Vector3())
    this.scene.add(glow)

    // Store sun direction for ocean shader
    this._sunDir = sunDir
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ocean
  // ──────────────────────────────────────────────────────────────────────────

  _buildOcean() {
    const geo = new THREE.PlaneGeometry(
      WORLD_SIZE * 2, WORLD_SIZE * 2,
      160, 160,
    )
    geo.rotateX(-Math.PI / 2)

    const mat = new THREE.ShaderMaterial({
      vertexShader:   OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      transparent:    true,
      uniforms: {
        uTime:        { value: 0 },
        uDeepColor:   { value: new THREE.Color(0x00426b) },
        uShallowColor:{ value: new THREE.Color(0x0077aa) },
        uSunDir:      { value: this._sunDir || new THREE.Vector3(0.5, 0.8, 0.3) },
      },
    })

    this._oceanMat = mat
    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    this.scene.add(mesh)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Islands
  // ──────────────────────────────────────────────────────────────────────────

  _buildIslands() {
    const rng = makeRNG(1337)
    for (let i = 0; i < ISLAND_COUNT; i++) {
      const x = (rng() - 0.5) * WORLD_SIZE * 1.6
      const z = (rng() - 0.5) * WORLD_SIZE * 1.6
      if (Math.hypot(x, z) < 250) continue   // keep spawn area clear
      this._buildIsland(x, z, rng)
    }
    this._buildAmbientDecor(makeRNG(9001))
  }

  _buildIsland(x, z, rng) {
    const group  = new THREE.Group()
    group.position.set(x, 0, z)

    const radius = 22 + rng() * 55
    const height = 12 + rng() * 28

    // Sandy beach ring
    const beachGeo = new THREE.CylinderGeometry(radius * 1.25, radius * 1.4, 3.5, 20)
    const sandMat  = new THREE.MeshPhongMaterial({ color: 0xe8c96e })
    const beach    = new THREE.Mesh(beachGeo, sandMat)
    beach.position.y = -1.8
    beach.receiveShadow = true
    group.add(beach)

    // Rock hill
    const hillGeo = new THREE.ConeGeometry(radius * 0.85, height, 14)
    const rockMat = new THREE.MeshPhongMaterial({ color: 0x7f8c8d })
    const hill    = new THREE.Mesh(hillGeo, rockMat)
    hill.position.y = height / 2
    hill.castShadow = true
    group.add(hill)

    // Green canopy on top
    const topGeo = new THREE.ConeGeometry(radius * 0.45, height * 0.45, 10)
    const topMat = new THREE.MeshPhongMaterial({ color: 0x27ae60 })
    const top    = new THREE.Mesh(topGeo, topMat)
    top.position.y = height * 0.88
    top.castShadow = true
    group.add(top)

    // ── Palm trees (Kenney Pirate Kit + Nature Kit) ───────────────────────────
    const numTrees  = 1 + Math.floor(rng() * 5)
    // Alternate between pirate-kit palms and nature-kit palms for variety
    const palmOptions = [
      { key: 'palm-detailed-bend',     scale: 2.5 },
      { key: 'palm-detailed-straight', scale: 2.5 },
      { key: 'tree-palm-tall',         scale: 8.0 },
      { key: 'tree-palm-bend',         scale: 8.5 },
      { key: 'tree-palm-short',        scale: 7.0 },
    ].filter(o => hasAsset(o.key))

    for (let t = 0; t < numTrees; t++) {
      const angle  = rng() * Math.PI * 2
      const r      = rng() * radius * 0.55
      const opt    = palmOptions.length
        ? palmOptions[Math.floor(rng() * palmOptions.length)]
        : null

      if (opt) {
        const palm = cloneAsset(opt.key)
        palm.scale.setScalar(opt.scale)
        palm.position.set(
          Math.cos(angle) * r,
          height * 0.35,
          Math.sin(angle) * r,
        )
        palm.rotation.y = rng() * Math.PI * 2
        group.add(palm)
      } else {
        // Fallback: procedural palm
        group.add(this._buildPalmTree(rng))
      }
    }

    // ── Rock clusters around the beach perimeter ──────────────────────────────
    const rockOptions = [
      { key: 'rocks-a',     scale: 2.0 },
      { key: 'rocks-b',     scale: 2.0 },
      { key: 'rocks-c',     scale: 1.8 },
      { key: 'rocks-sand-a',scale: 1.0 },
      { key: 'rock-large-a',scale: 8.0 },
      { key: 'rock-large-b',scale: 8.0 },
      { key: 'rock-tall-a', scale: 7.0 },
      { key: 'rock-tall-b', scale: 7.0 },
    ].filter(o => hasAsset(o.key))

    const numRocks = 2 + Math.floor(rng() * 4)
    for (let r = 0; r < numRocks; r++) {
      if (!rockOptions.length) break
      const angle  = rng() * Math.PI * 2
      const dist   = radius * (0.9 + rng() * 0.5)
      const opt    = rockOptions[Math.floor(rng() * rockOptions.length)]
      const rock   = cloneAsset(opt.key)
      rock.scale.setScalar(opt.scale)
      rock.position.set(Math.cos(angle) * dist, 0, Math.sin(angle) * dist)
      rock.rotation.y = rng() * Math.PI * 2
      group.add(rock)
    }

    // ── Island props: barrel, chest, cannon ───────────────────────────────────
    const propOptions = [
      { key: 'barrel', scale: 2.0 },
      { key: 'chest',  scale: 2.0 },
      { key: 'cannon', scale: 2.5 },
    ].filter(o => hasAsset(o.key))

    const numProps = Math.floor(rng() * 3)
    for (let p = 0; p < numProps; p++) {
      if (!propOptions.length) break
      const angle = rng() * Math.PI * 2
      const dist  = rng() * radius * 0.4
      const opt   = propOptions[Math.floor(rng() * propOptions.length)]
      const prop  = cloneAsset(opt.key)
      prop.scale.setScalar(opt.scale)
      prop.position.set(Math.cos(angle) * dist, height * 0.35, Math.sin(angle) * dist)
      prop.rotation.y = rng() * Math.PI * 2
      group.add(prop)
    }

    this.scene.add(group)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Procedural palm tree (fallback when GLTF assets are absent)
  // ──────────────────────────────────────────────────────────────────────────

  _buildPalmTree(rng) {
    const group   = new THREE.Group()
    const trunkMat = new THREE.MeshPhongMaterial({ color: 0x7d5a2a })
    const leafMat  = new THREE.MeshPhongMaterial({ color: 0x1e8449, side: THREE.DoubleSide })

    // Leaning trunk
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.44, 7, 6), trunkMat)
    trunk.position.y = 3.5
    trunk.rotation.z = (rng() - 0.5) * 0.35
    trunk.castShadow = true
    group.add(trunk)

    // Fan of leaves
    const leafCount = 6 + Math.floor(rng() * 3)
    for (let i = 0; i < leafCount; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(2.5, 1.8, 4), leafMat)
      const angle = (i / leafCount) * Math.PI * 2
      leaf.position.set(
        Math.cos(angle) * 2.2,
        7.4,
        Math.sin(angle) * 2.2,
      )
      leaf.rotation.y = angle
      leaf.rotation.z = Math.PI / 2.8
      leaf.castShadow = true
      group.add(leaf)
    }

    return group
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ambient ocean decorations: buoys + small sailing boats
  // ──────────────────────────────────────────────────────────────────────────

  _buildAmbientDecor(rng) {
    const HALF = WORLD_SIZE * 0.7

    // ── Buoys ──────────────────────────────────────────────────────────────
    const buoyKey  = hasAsset('buoy-flag') ? 'buoy-flag' : hasAsset('buoy') ? 'buoy' : null
    const numBuoys = 22
    for (let i = 0; i < numBuoys; i++) {
      if (!buoyKey) break
      const bx = (rng() - 0.5) * HALF * 2
      const bz = (rng() - 0.5) * HALF * 2
      const b  = cloneAsset(buoyKey)
      b.scale.setScalar(3.0)
      b.position.set(bx, 0, bz)
      b.rotation.y = rng() * Math.PI * 2
      this.scene.add(b)
    }

    // ── Wrecked ship ────────────────────────────────────────────────────────
    if (hasAsset('ship-wreck')) {
      for (let i = 0; i < 3; i++) {
        const wx = (rng() - 0.5) * HALF * 1.8
        const wz = (rng() - 0.5) * HALF * 1.8
        const w  = cloneAsset('ship-wreck')
        w.scale.setScalar(1.2)
        w.position.set(wx, -0.5, wz)
        w.rotation.y = rng() * Math.PI * 2
        // Slight heel to make it look shipwrecked
        w.rotation.z = (rng() - 0.5) * 0.4
        this.scene.add(w)
      }
    }

    // ── Ghost ship (eerie lone vessel) ─────────────────────────────────────
    if (hasAsset('ship-ghost')) {
      const gx = (rng() - 0.5) * HALF * 1.6
      const gz = (rng() - 0.5) * HALF * 1.6
      const g  = cloneAsset('ship-ghost')
      g.scale.setScalar(1.2)
      g.position.set(gx, 0, gz)
      g.rotation.y = rng() * Math.PI * 2
      this.scene.add(g)
    }

    // ── Small ambient sailing boats (Kenney Watercraft Kit) ───────────────
    const sailOptions = ['boat-sail-a', 'boat-sail-b'].filter(k => hasAsset(k))
    const numBoats    = 6
    for (let i = 0; i < numBoats; i++) {
      if (!sailOptions.length) break
      const key = sailOptions[Math.floor(rng() * sailOptions.length)]
      const bx  = (rng() - 0.5) * HALF * 1.8
      const bz  = (rng() - 0.5) * HALF * 1.8
      const b   = cloneAsset(key)
      b.scale.setScalar(5.0)
      b.position.set(bx, 0, bz)
      b.rotation.y = rng() * Math.PI * 2
      this.scene.add(b)
    }
  }
}
