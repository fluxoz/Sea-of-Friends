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
import { dsin, dcos, dhypot, datan2, TWO_PI } from './dmath.js'

const WORLD_SIZE  = 7000
const ISLAND_COUNT = 40

/** Player-following detailed ocean mesh: size and tessellation. */
const OCEAN_MESH_SIZE = 2600
const OCEAN_MESH_SEGS = 320

/** Half the world extent; ships are clamped to stay inside this boundary. */
export const WORLD_HALF = WORLD_SIZE / 2

// ── Shared wave parameters ────────────────────────────────────────────────────
// Gerstner-style waves: `amp` is vertical amplitude, `hAmp` the horizontal
// (choppiness) amplitude along the normalised direction.  The GLSL is
// *generated* from this table so the GPU surface and the CPU waveHeight()
// can never drift apart.  Mixed wavelengths (λ ≈ 570 → 30 units) give the
// water both long swells and short chop.
export const WAVE_PARAMS = [
  { freq: 0.022, speed: 0.85, amp: 1.30, dirX:  1.0, dirZ:  0.7, hAmp: 5.0 },
  { freq: 0.016, speed: 0.60, amp: 0.85, dirX: -0.6, dirZ:  1.0, hAmp: 5.0 },
  { freq: 0.011, speed: 1.20, amp: 0.60, dirX:  0.8, dirZ: -0.5, hAmp: 4.5 },
  { freq: 0.034, speed: 1.50, amp: 0.42, dirX: -0.5, dirZ: -0.9, hAmp: 3.0 },
  { freq: 0.075, speed: 2.10, amp: 0.44, dirX:  0.9, dirZ:  0.3, hAmp: 1.8 },
  { freq: 0.120, speed: 2.60, amp: 0.26, dirX: -0.3, dirZ:  0.9, hAmp: 1.1 },
  { freq: 0.210, speed: 3.40, amp: 0.14, dirX:  0.7, dirZ: -0.7, hAmp: 0.6 },
]

/** Deepest possible trough: every wave phase aligned downward. The horizon
 *  skirt must sit below this or it pierces the surface as a dark blotch —
 *  derived from the table so amplitude tuning can never strand it again. */
const MAX_TROUGH = WAVE_PARAMS.reduce((s, w) => s + w.amp, 0)
const SKIRT_Y = -(MAX_TROUGH + 2.5)

/** Sum of all Gerstner displacements at parameter point (x, z).
 *  Uses dmath so the value is bit-identical on every peer (cannonball splash
 *  detection and ship bobbing are simulation state under lockstep). */
function displaceCPU(x, z, t) {
  let dx = 0, dy = 0, dz = 0
  for (const w of WAVE_PARAMS) {
    const phase = (x * w.dirX + z * w.dirZ) * w.freq + t * w.speed
    const inv   = 1 / Math.sqrt(w.dirX * w.dirX + w.dirZ * w.dirZ)
    dy += dsin(phase) * w.amp
    const c = dcos(phase) * w.hAmp
    dx += w.dirX * inv * c
    dz += w.dirZ * inv * c
  }
  return { dx, dy, dz }
}

/**
 * Cheap single-pass wave height (no horizontal-displacement inversion).
 * ~4x cheaper than waveHeight; the field is horizontally shifted by up to
 * the chop amplitude, so use it only for DIFFERENTIAL quantities (slopes,
 * tilt targets) where the shift cancels — never for an absolute height that
 * must match the drawn surface.
 */
export function waveHeightFast(x, z, t) {
  return displaceCPU(x, z, t).dy
}

/**
 * Water-surface height at world (x, z).  Gerstner waves displace horizontally,
 * so we invert the mapping with a few fixed-point iterations (the horizontal
 * displacement is a contraction, so this converges fast).
 */
export function waveHeight(x, z, t) {
  let qx = x, qz = z
  for (let i = 0; i < 3; i++) {
    const d = displaceCPU(qx, qz, t)
    qx = x - d.dx
    qz = z - d.dz
  }
  return displaceCPU(qx, qz, t).dy
}

// ── Wind ──────────────────────────────────────────────────────────────────────
// Pure deterministic function of the supplied clock. Under lockstep the
// simulation passes its own tick-derived time (identical on every peer);
// the menu backdrop passes wall-clock seconds for a bit of life.
//   dir   – radians, the direction the wind blows TOWARD
//   speed – true wind speed in world units/s (20 … 34). Boat speed is this
//           times the ship's polar-curve multiplier (see ship.js).
export function getWind(t) {
  const raw = dsin(t / 97) * 1.7 + dsin(t / 41 + 2.1) * 1.1 + t / 530
  return {
    dir:   ((raw % TWO_PI) + TWO_PI) % TWO_PI,
    speed: 27 + 7 * dsin(t / 53 + 1.0),
  }
}

// ── GLSL (generated from WAVE_PARAMS) ─────────────────────────────────────────
const glslNum = n => Number.isInteger(n) ? n.toFixed(1) : String(n)

function waveGLSLBody() {
  return WAVE_PARAMS.map(w => {
    const inv = 1 / Math.hypot(w.dirX, w.dirZ)
    const nx = (w.dirX * inv).toFixed(5)
    const nz = (w.dirZ * inv).toFixed(5)
    return `
    ph = (p.x * ${glslNum(w.dirX)} + p.y * ${glslNum(w.dirZ)}) * ${glslNum(w.freq)} + t * ${glslNum(w.speed)};
    d.y  += ${glslNum(w.amp)} * sin(ph);
    d.xz += vec2(${nx}, ${nz}) * ${glslNum(w.hAmp)} * cos(ph);`
  }).join('')
}

const OCEAN_VERT = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uDynMap;
  uniform vec2  uDynCenter;
  uniform float uDynSize;
  varying float vH;
  varying vec3  vNormal;
  varying vec3  vWorldPos;

  vec3 displace(vec2 p, float t) {
    vec3 d = vec3(0.0);
    float ph;
    ${waveGLSLBody()}
    return d;
  }

  void main() {
    // The mesh follows the player; waves are a function of WORLD position so
    // the surface stays continuous as the mesh recentres.
    vec2 base = (modelMatrix * vec4(position, 1.0)).xz;

    vec3 d    = displace(base, uTime);
    vec3 wpos = vec3(base.x + d.x, d.y, base.y + d.z);

    // Finite-difference normal on the fully displaced surface
    float eps = 2.0;
    vec3 dx = displace(base + vec2(eps, 0.0), uTime);
    vec3 dz = displace(base + vec2(0.0, eps), uTime);
    vec3 px = vec3(base.x + eps + dx.x, dx.y, base.y + dx.z) - wpos;
    vec3 pz = vec3(base.x + dz.x, dz.y, base.y + eps + dz.z) - wpos;
    vNormal = normalize(cross(pz, px));

    // Dynamic wake heightfield: real displaced water where ships have been
    vec2 duv = (wpos.xz - uDynCenter) / uDynSize + 0.5;
    float dInb = step(0.0, duv.x) * step(duv.x, 1.0) * step(0.0, duv.y) * step(duv.y, 1.0);
    float dyn = texture2D(uDynMap, duv).r * dInb;
    wpos.y += dyn;

    vH        = d.y + dyn;
    vWorldPos = wpos;
    gl_Position = projectionMatrix * viewMatrix * vec4(wpos, 1.0);
  }
`

const OCEAN_FRAG = /* glsl */ `
  uniform vec3  uDeepColor;
  uniform vec3  uShallowColor;
  uniform vec3  uSkyColor;
  uniform vec3  uSunDir;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform float uTime;
  uniform sampler2D uFoamMap;
  uniform vec2  uFoamCenter;
  uniform float uFoamSize;
  uniform sampler2D uDynMap;
  uniform vec2  uDynCenter;
  uniform float uDynSize;
  varying float vH;
  varying vec3  vNormal;
  varying vec3  vWorldPos;

  // Cheap 2-D value noise for organic ripple + foam detail (no axis-aligned
  // sine patterns — those read as a giant grid on open water)
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i),                 hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    // Fine ripple detail perturbs the geometric normal (too small for the
    // mesh): two octaves of scrolling value noise, sampled as gradients
    vec3 N = normalize(vNormal);
    vec2 uv1 = vWorldPos.xz * 0.13 + uTime * vec2(0.38, 0.26);
    vec2 uv2 = vWorldPos.xz * 0.29 - uTime * vec2(0.22, 0.31);
    float e = 0.4;
    vec2 g1 = vec2(vnoise(uv1 + vec2(e, 0.0)) - vnoise(uv1 - vec2(e, 0.0)),
                   vnoise(uv1 + vec2(0.0, e)) - vnoise(uv1 - vec2(0.0, e)));
    vec2 g2 = vec2(vnoise(uv2 + vec2(e, 0.0)) - vnoise(uv2 - vec2(e, 0.0)),
                   vnoise(uv2 + vec2(0.0, e)) - vnoise(uv2 - vec2(0.0, e)));
    N.xz += g1 * 0.22 + g2 * 0.15;

    // Wake waves shade like real water: bend the normal by the dynamic
    // heightfield's gradient so crests catch the sun and troughs shadow
    vec2 duv = (vWorldPos.xz - uDynCenter) / uDynSize + 0.5;
    float dInb = step(0.0, duv.x) * step(duv.x, 1.0) * step(0.0, duv.y) * step(duv.y, 1.0);
    float dT = 1.5 / 512.0;
    float dhx = texture2D(uDynMap, duv + vec2(dT, 0.0)).r - texture2D(uDynMap, duv - vec2(dT, 0.0)).r;
    float dhz = texture2D(uDynMap, duv + vec2(0.0, dT)).r - texture2D(uDynMap, duv - vec2(0.0, dT)).r;
    N.xz -= vec2(dhx, dhz) * 2.3 * dInb;
    N = normalize(N);

    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 S = normalize(uSunDir);

    // Base colour – depth tint, scaled to the full ±4 wave range so troughs
    // shade smoothly instead of clamping to a flat dark patch
    float t = clamp((vH + 4.0) / 8.0, 0.0, 1.0);
    vec3 col = mix(uDeepColor, uShallowColor, t);

    // Diffuse
    float diff = clamp(dot(N, S), 0.0, 1.0) * 0.55 + 0.45;
    col *= diff;

    // Fake subsurface scattering: crests glow green-blue looking toward the sun
    float sub = pow(clamp(dot(V, -S), 0.0, 1.0), 2.0)
              * clamp(vH * 0.22 + 0.3, 0.0, 1.0);
    col += vec3(0.0, 0.17, 0.15) * sub;

    // Fresnel reflection of the sky at grazing angles
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    col = mix(col, uSkyColor, fres * 0.55);

    // Sun glint (true Blinn-Phong with the real view vector)
    vec3 H = normalize(S + V);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), 240.0);
    col += vec3(1.0, 0.97, 0.9) * spec * 0.9;

    // Foam on crests, broken up with noise so it isn't a solid band
    float foamN = vnoise(vWorldPos.xz * 0.06 + uTime * 0.12)
                + 0.5 * vnoise(vWorldPos.xz * 0.17 - uTime * 0.08);
    float foam = smoothstep(2.1, 3.6, vH + (foamN - 0.75) * 0.9);
    col = mix(col, vec3(0.92, 0.96, 1.0), foam * 0.6);

    // Wake foam: churned water stamped by ships and splashes into a
    // world-space trail texture that follows the camera
    vec2 fuv = (vWorldPos.xz - uFoamCenter) / uFoamSize + 0.5;
    float inb = smoothstep(0.0, 0.05, fuv.x) * smoothstep(1.0, 0.95, fuv.x)
              * smoothstep(0.0, 0.05, fuv.y) * smoothstep(1.0, 0.95, fuv.y);
    float wf = texture2D(uFoamMap, fuv).r * inb;
    float wfoam = clamp(wf * (0.7 + 0.55 * vnoise(vWorldPos.xz * 0.33 + uTime * 0.25)), 0.0, 1.0);
    col = mix(col, vec3(0.90, 0.95, 0.98), wfoam * 0.55);

    // Whitecaps where the wake waves break (steep dynamic gradient)
    float wcrest = clamp((abs(dhx) + abs(dhz)) * 1.8 - 0.22, 0.0, 1.0) * dInb;
    col = mix(col, vec3(0.93, 0.97, 1.0), wcrest * 0.35);

    // Manual fog matching the scene's FogExp2 (ShaderMaterial skips it)
    float dist = length(cameraPosition - vWorldPos);
    float fogF = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

    gl_FragColor = vec4(col, 0.94);
  }
`

// ─────────────────────────────────────────────────────────────────────────────

/** Integer-hash 2-D value noise in [0,1] — exact ops only, so bit-identical
 *  on every peer (terrain height feeds simulation collisions). */
function hash2i(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ seed) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function vnoise2(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const u = fx * fx * (3 - 2 * fx)
  const v = fz * fz * (3 - 2 * fz)
  const a = hash2i(ix, iz, seed),     b = hash2i(ix + 1, iz, seed)
  const c = hash2i(ix, iz + 1, seed), d = hash2i(ix + 1, iz + 1, seed)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** Two-octave fractal noise in [0,1]. */
function fbm2(x, z, seed) {
  return vnoise2(x, z, seed) * 0.65 + vnoise2(x * 2.3 + 37.7, z * 2.3 - 11.3, seed ^ 0x9e37) * 0.35
}

/** Deterministic PRNG (LCG) seeded with an integer. */
export function makeRNG(seed) {
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
    this._worldGroup = null   // all seeded content (islands, decor)
    /** @type {Array<{x:number, z:number, r:number, h:number}>} collision circles */
    this._islands = []
  }

  /** Island collision circles: {x, z, r (outer beach radius), h (peak height)}. */
  getIslands() { return this._islands }

  /** Build the seed-independent base: sky and ocean. Islands come later,
   *  once the room's world seed is known (see buildIslands). */
  build() {
    this._buildSky()
    this._buildOcean()
    this._buildWake()
  }

  /**
   * Generate the full island world from a seed.  Deterministic: every peer
   * that runs this with the same seed gets an identical world, which is how
   * "downloading the world from the creator" works — the creator's seed is
   * shared P2P and the world is regenerated locally.
   *
   * Safe to call again with a new seed (tears down the previous world).
   */
  buildIslands(seed) {
    this.clearIslands()
    this._worldGroup = new THREE.Group()
    this.scene.add(this._worldGroup)
    this._buildIslands(seed >>> 0)
  }

  /** Remove all seeded content and free procedurally-owned GPU resources. */
  clearIslands() {
    this._islands = []
    if (!this._worldGroup) return
    this.scene.remove(this._worldGroup)
    this._worldGroup.traverse(o => {
      // Cloned Kenney assets share geometry/materials with the preload cache
      // — only dispose resources created by the generator itself.
      if (o.isMesh && o.userData.owned) {
        o.geometry.dispose()
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose())
        else o.material.dispose()
      }
    })
    this._worldGroup = null
  }

  /** Advance ocean time. Call every frame with delta-seconds. */
  tick(dt) {
    this._time += dt
    if (this._oceanMat) {
      this._oceanMat.uniforms.uTime.value = this._time
    }
  }

  /** Pin the ocean clock (lockstep: render follows the interpolated sim time
   *  so splashes, bobbing, and the GPU surface all share one wave phase). */
  setTime(t) {
    this._time = t
    if (this._oceanMat) {
      this._oceanMat.uniforms.uTime.value = t
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
    // Everything celestial lives in one group that follows the camera, so
    // the dome is never exited even at the far edges of the 9 km world.
    this._skyGroup = new THREE.Group()
    this._skyGroup.add(new THREE.Mesh(skyGeo, skyMat))

    // Sun disc
    const sunDir = new THREE.Vector3(0.5, 0.38, -0.78).normalize()
    const sunPos = sunDir.clone().multiplyScalar(2000)
    const sun    = new THREE.Mesh(
      new THREE.CircleGeometry(90, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe880, transparent: true, opacity: 0.95 }),
    )
    sun.position.copy(sunPos)
    sun.lookAt(new THREE.Vector3())
    this._skyGroup.add(sun)

    // Glow halo
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(160, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe880, transparent: true, opacity: 0.22 }),
    )
    glow.position.copy(sunPos)
    glow.lookAt(new THREE.Vector3())
    this._skyGroup.add(glow)

    this.scene.add(this._skyGroup)

    // Store sun direction for ocean shader
    this._sunDir = sunDir
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ocean
  // ──────────────────────────────────────────────────────────────────────────

  _buildOcean() {
    // Dense mesh that follows the player (set via setFocus); waves are
    // computed from world position so recentring is invisible.
    const geo = new THREE.PlaneGeometry(
      OCEAN_MESH_SIZE, OCEAN_MESH_SIZE,
      OCEAN_MESH_SEGS, OCEAN_MESH_SEGS,
    )
    geo.rotateX(-Math.PI / 2)

    const mat = new THREE.ShaderMaterial({
      vertexShader:   OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      transparent:    true,
      uniforms: {
        uTime:        { value: 0 },
        uDeepColor:   { value: new THREE.Color(0x003a5f) },
        uShallowColor:{ value: new THREE.Color(0x0d7ca4) },
        uSkyColor:    { value: new THREE.Color(0x88ccff) },
        uSunDir:      { value: this._sunDir || new THREE.Vector3(0.5, 0.8, 0.3) },
        uFogColor:    { value: new THREE.Color(0x88ccff) },
        uFogDensity:  { value: 0.00065 },
        uFoamMap:     { value: null },
        uFoamCenter:  { value: new THREE.Vector2(0, 0) },
        uFoamSize:    { value: 560 },
        uDynMap:      { value: null },
        uDynCenter:   { value: new THREE.Vector2(0, 0) },
        uDynSize:     { value: 360 },
      },
    })

    this._oceanMat  = mat
    this._oceanMesh = new THREE.Mesh(geo, mat)
    this._oceanMesh.receiveShadow = true
    this._oceanMesh.frustumCulled = false   // vertices are displaced in-shader
    this.scene.add(this._oceanMesh)

    // Flat skirt below the detailed mesh so the horizon is water, not void.
    // Standard material → the scene fog fades the seam automatically.
    const skirt = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE * 4, WORLD_SIZE * 4),
      new THREE.MeshBasicMaterial({ color: 0x00344f }),
    )
    skirt.rotation.x = -Math.PI / 2
    skirt.position.y = SKIRT_Y
    this._skirtMesh = skirt
    this.scene.add(skirt)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Wake foam: a world-space trail texture ships and splashes stamp into.
  // Two RTs ping-pong: fade+shift pass, then additive stamps. Render-only —
  // the sim never reads it, so GPU float differences can't desync peers.
  // ──────────────────────────────────────────────────────────────────────────

  _buildWake() {
    const RES = 512
    this._wakeRes  = RES
    this._wakeSize = 560           // world units covered by the texture
    const mk = () => new THREE.WebGLRenderTarget(RES, RES, {
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    })
    this._wakeRTs   = [mk(), mk()]
    this._wakeIdx   = 0
    this._wakeCenter = new THREE.Vector2(0, 0)
    this._wakeQueue  = []
    this._wakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    // Fade + recentre-shift pass
    this._fadeScene = new THREE.Scene()
    // Foam accumulates in R; fade-and-shift keeps the trail glued to the
    // world as the window recentres
    this._fadeMat = new THREE.ShaderMaterial({
      uniforms: { uPrev: { value: null }, uShift: { value: new THREE.Vector2() }, uDecay: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D uPrev; uniform vec2 uShift; uniform vec2 uDecay;
        varying vec2 vUv;
        void main() {
          vec2 uv = vUv + uShift;
          vec2 v = (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
            ? vec2(0.0) : texture2D(uPrev, uv).rg;
          gl_FragColor = vec4(v * uDecay, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    })
    this._fadeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._fadeMat))

    // Soft-blob stamp pool (additive quads placed in NDC)
    const cv = document.createElement('canvas')
    cv.width = cv.height = 64
    const g = cv.getContext('2d')
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.55, 'rgba(255,255,255,0.5)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    const blobTex = new THREE.CanvasTexture(cv)

    this._stampScene = new THREE.Scene()
    this._stampPool = []
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: blobTex, transparent: true, blending: THREE.AdditiveBlending,
          depthTest: false, depthWrite: false,
          color: 0xff0000,   // foam writes the R channel only
        }),
      )
      m.visible = false
      this._stampScene.add(m)
      this._stampPool.push(m)
    }

    this._buildFluid()

    // Both RTs start black — bind one so the ocean shader never samples null
    if (this._oceanMat) this._oceanMat.uniforms.uFoamMap.value = this._wakeRTs[0].texture
  }

  /** Queue a foam stamp at world (x, z). Render-side only. */
  addWake(x, z, size, intensity, stretch = 1, angle = 0) {
    if (this._wakeQueue.length < 96) this._wakeQueue.push({ x, z, size, intensity, stretch, angle })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Fluid wake: a real wave-equation heightfield (∂²h/∂t² = c²∇²h) on the
  // GPU, in a window that follows the ship. Hulls press a moving depression
  // into the field; the physics radiates the bow V, diverging feathers, and
  // transverse stern waves on its own. Splashes ring outward the same way.
  // Render-only: the sim never reads any of it, so GPU float behaviour can
  // never desync peers.
  // ──────────────────────────────────────────────────────────────────────────

  _buildFluid() {
    const RES = 512
    this._flRes  = RES
    this._flSize = 360                    // world units covered
    this._flDT   = 1 / 60                 // fixed substep
    const dx = this._flSize / RES
    const c  = 9                          // wake wave speed (world u/s)
    this._flC2 = (c * this._flDT / dx) ** 2   // CFL ≈ 0.21 — comfortably stable

    const mk = () => new THREE.WebGLRenderTarget(RES, RES, {
      depthBuffer: false, stencilBuffer: false,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    })
    this._flRTs = [mk(), mk()]
    this._flIdx = 0
    this._flCenter = new THREE.Vector2(0, 0)
    this._flAccum = 0
    this._flQueue = []

    // Wave-equation step (Verlet: R = h, G = h_prev)
    this._flStepMat = new THREE.ShaderMaterial({
      uniforms: {
        uField: { value: null }, uShift: { value: new THREE.Vector2() },
        uC2: { value: this._flC2 }, uDamp: { value: 0.996 },
        uTexel: { value: 1 / RES },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D uField; uniform vec2 uShift;
        uniform float uC2, uDamp, uTexel;
        varying vec2 vUv;
        void main() {
          vec2 uv = vUv + uShift;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return;
          }
          vec2 f = texture2D(uField, uv).rg;
          float lap = texture2D(uField, uv - vec2(uTexel, 0.0)).r
                    + texture2D(uField, uv + vec2(uTexel, 0.0)).r
                    + texture2D(uField, uv - vec2(0.0, uTexel)).r
                    + texture2D(uField, uv + vec2(0.0, uTexel)).r
                    - 4.0 * f.r;
          float nh = f.r + (f.r - f.g) * uDamp + uC2 * lap;
          nh = clamp(nh, -0.8, 0.8);   // small-amplitude waves by construction
          // absorb near the window border so the edge never reflects
          float edge = smoothstep(0.0, 0.07, uv.x) * smoothstep(1.0, 0.93, uv.x)
                     * smoothstep(0.0, 0.07, uv.y) * smoothstep(1.0, 0.93, uv.y);
          nh *= mix(0.86, 1.0, edge);
          gl_FragColor = vec4(nh, f.r, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    })
    this._flStepScene = new THREE.Scene()
    this._flStepScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._flStepMat))

    // Disturbance stamps: soft ellipses added (can be negative) into R only
    this._flStampScene = new THREE.Scene()
    this._flStampPool = []
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.ShaderMaterial({
          uniforms: { uAmt: { value: 0 } },
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: `
            uniform float uAmt; varying vec2 vUv;
            void main() {
              float d = length(vUv * 2.0 - 1.0);
              float m = smoothstep(1.0, 0.25, d);
              gl_FragColor = vec4(uAmt * m, 0.0, 0.0, 0.0);
            }`,
          transparent: true,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
          depthTest: false, depthWrite: false,
        }),
      )
      m.visible = false
      this._flStampScene.add(m)
      this._flStampPool.push(m)
    }
    if (this._oceanMat) {
      this._oceanMat.uniforms.uDynMap.value = this._flRTs[0].texture
    }
  }

  /** Press the water down under a hull (sx along heading, sz across). */
  disturbFluid(x, z, sx, sz, angle, amt) {
    if (this._flQueue.length < 40) this._flQueue.push({ x, z, sx, sz, angle, amt })
  }

  /** A single round impulse (cannonball splash, ram shock). */
  splashFluid(x, z, r, amt) {
    this.disturbFluid(x, z, r, r, 0, amt)
  }

  updateFluid(renderer, fx, fz, dtR) {
    if (!this._flRTs) return
    const S = this._flSize
    const texel = S / this._flRes
    const cx = Math.round(fx / texel) * texel
    const cz = Math.round(fz / texel) * texel
    const shiftX = (cx - this._flCenter.x) / S
    const shiftZ = (cz - this._flCenter.y) / S
    this._flCenter.set(cx, cz)

    this._flAccum = Math.min(this._flAccum + Math.min(dtR, 0.1), 4 * this._flDT)
    let steps = 0
    while (this._flAccum >= this._flDT && steps < 3) { this._flAccum -= this._flDT; steps++ }
    if (!steps && (shiftX || shiftZ)) steps = 1   // keep the window glued on

    const oldTarget = renderer.getRenderTarget()
    const oldAutoClear = renderer.autoClear
    for (let i = 0; i < steps; i++) {
      const prev = this._flRTs[this._flIdx]
      const next = this._flRTs[1 - this._flIdx]
      this._flIdx = 1 - this._flIdx
      this._flStepMat.uniforms.uField.value = prev.texture
      this._flStepMat.uniforms.uShift.value.set(i === 0 ? shiftX : 0, i === 0 ? shiftZ : 0)
      renderer.setRenderTarget(next)
      renderer.autoClear = true
      renderer.render(this._flStepScene, this._wakeCam)

      if (i === 0 && this._flQueue.length) {
        let used = 0
        for (const q of this._flQueue) {
          if (used >= this._flStampPool.length) break
          const m = this._flStampPool[used++]
          m.visible = true
          m.position.set((q.x - cx) / (S / 2), (q.z - cz) / (S / 2), -0.5)
          m.scale.set(q.sx / (S / 2), q.sz / (S / 2), 1)
          m.rotation.z = Math.PI / 2 - q.angle
          m.material.uniforms.uAmt.value = q.amt
        }
        for (let j = used; j < this._flStampPool.length; j++) this._flStampPool[j].visible = false
        this._flQueue.length = 0
        renderer.autoClear = false
        renderer.render(this._flStampScene, this._wakeCam)
      }
    }
    renderer.setRenderTarget(oldTarget)
    renderer.autoClear = oldAutoClear

    if (this._oceanMat) {
      this._oceanMat.uniforms.uDynMap.value = this._flRTs[this._flIdx].texture
      this._oceanMat.uniforms.uDynCenter.value.set(cx, cz)
      this._oceanMat.uniforms.uDynSize.value = S
    }
  }

  /** Advance the wake texture: fade, recentre on (fx, fz), stamp the queue. */
  updateWake(renderer, fx, fz, dt) {
    if (!this._wakeRTs) return
    const S = this._wakeSize
    const texel = S / this._wakeRes
    const cx = Math.round(fx / texel) * texel
    const cz = Math.round(fz / texel) * texel

    const prev = this._wakeRTs[this._wakeIdx]
    const next = this._wakeRTs[1 - this._wakeIdx]
    this._wakeIdx = 1 - this._wakeIdx

    this._fadeMat.uniforms.uPrev.value = prev.texture
    this._fadeMat.uniforms.uShift.value.set(
      (cx - this._wakeCenter.x) / S, (cz - this._wakeCenter.y) / S)
    const dec = Math.pow(0.5, dt / 5.5)   // ~15 s trails
    this._fadeMat.uniforms.uDecay.value.set(dec, dec)
    this._wakeCenter.set(cx, cz)

    const oldTarget = renderer.getRenderTarget()
    const oldAutoClear = renderer.autoClear
    renderer.setRenderTarget(next)
    renderer.autoClear = true
    renderer.render(this._fadeScene, this._wakeCam)

    let used = 0
    for (const q of this._wakeQueue) {
      if (used >= this._stampPool.length) break
      const m = this._stampPool[used++]
      m.visible = true
      m.position.set((q.x - cx) / (S / 2), (q.z - cz) / (S / 2), -0.5)
      m.scale.set((q.size * q.stretch) / (S / 2), q.size / (S / 2), 1)
      // compass heading (fwd = sin r, cos r in XZ) → NDC angle from +x
      m.rotation.z = Math.PI / 2 - q.angle
      m.material.opacity = Math.min(1, q.intensity)
    }
    for (let i = used; i < this._stampPool.length; i++) this._stampPool[i].visible = false
    this._wakeQueue.length = 0
    if (used) {
      renderer.autoClear = false
      renderer.render(this._stampScene, this._wakeCam)
    }
    renderer.setRenderTarget(oldTarget)
    renderer.autoClear = oldAutoClear

    if (this._oceanMat) {
      this._oceanMat.uniforms.uFoamMap.value = next.texture
      this._oceanMat.uniforms.uFoamCenter.value.set(cx, cz)
      this._oceanMat.uniforms.uFoamSize.value = S
    }
  }

  /**
   * Recentre the ocean meshes on the player each frame.  The detailed mesh
   * snaps to its own grid so vertices never "swim" as it moves.
   */
  setFocus(x, z) {
    const grid = OCEAN_MESH_SIZE / OCEAN_MESH_SEGS
    if (this._oceanMesh) {
      this._oceanMesh.position.set(
        Math.round(x / grid) * grid, 0, Math.round(z / grid) * grid,
      )
    }
    if (this._skirtMesh) this._skirtMesh.position.set(x, SKIRT_Y, z)
    if (this._skyGroup)  this._skyGroup.position.set(x, 0, z)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Islands
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Seeded world generation.  Four island archetypes are scattered with
   * spacing constraints:
   *   isle    – classic palm island (common)
   *   volcano – big towering island, visible from far off
   *   atoll   – ring of sandbars around a lagoon
   *   reef    – low rock hazard, easy to miss until it's too late
   */
  _buildIslands(seed) {
    const rng = makeRNG(seed)
    const placed = []

    const archetype = () => {
      const roll = rng()
      if (roll < 0.14) return { kind: 'volcano', r: 70 + rng() * 60 }
      if (roll < 0.30) return { kind: 'atoll',   r: 45 + rng() * 40 }
      if (roll < 0.50) return { kind: 'reef',    r: 18 + rng() * 20 }
      return               { kind: 'isle',    r: 24 + rng() * 40 }
    }

    let attempts = 0
    while (placed.length < ISLAND_COUNT && attempts++ < ISLAND_COUNT * 8) {
      const a = archetype()
      const x = (rng() - 0.5) * WORLD_SIZE * 0.92
      const z = (rng() - 0.5) * WORLD_SIZE * 0.92
      // Keep the spawn area clear and islands off each other
      if (dhypot(x, z) < 350 + a.r) continue
      if (placed.some(p => dhypot(x - p.x, z - p.z) < p.r + a.r + 140)) continue
      placed.push({ x, z, r: a.r, kind: a.kind })

      switch (a.kind) {
        case 'volcano': this._buildVolcano(x, z, a.r, rng); break
        case 'atoll':   this._buildAtoll(x, z, a.r, rng);   break
        case 'reef':    this._buildReef(x, z, a.r, rng);    break
        default:        this._buildIsle(x, z, a.r, rng)
      }
    }

    this._buildAmbientDecor(rng)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Low-poly island terrain
  //
  // Each island is a single flat-shaded, vertex-coloured mesh generated from
  // a deterministic height function h(x, z): sand at the waterline, grassy
  // slopes, rocky ridges, craters on volcanoes, lagoons in atolls. The SAME
  // height function drives flora/building placement, fort foundations, and
  // cannonball terrain collisions — so what you see is what the sim hits.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build the terrain mesh + height function for one island.
   * @returns {{group: THREE.Group, heightAt: (wx,wz)=>number}}
   */
  _buildTerrain(x, z, radius, height, kind, rng) {
    const seed = (rng() * 0xffffffff) >>> 0
    const gapA = rng() * Math.PI * 2          // atoll lagoon entrance

    const heightAt = (wx, wz) => {
      const lx = wx - x, lz = wz - z
      const r = dhypot(lx, lz) / radius
      if (r > 1.45) return -6
      const n = fbm2(lx * (3.2 / radius), lz * (3.2 / radius), seed)   // 0..1

      let h
      if (kind === 'volcano') {
        // Steep-flanked cone with a broad sand skirt
        const core = Math.max(0, 1 - r / 0.92)
        h = height * Math.pow(core, 1.5)
        // Caldera
        if (r < 0.26) {
          const c = 1 - r / 0.26
          h -= height * 0.42 * c * c
        }
        h += (n - 0.5) * height * 0.24 * Math.max(0, 1 - r)
        h = Math.max(h, (1.15 - r) * 4)   // low skirt stays above water
      } else if (kind === 'atoll') {
        const ring = Math.max(0, 1 - Math.abs(r - 0.8) * 3.4)
        h = 5.5 * ring + (n - 0.5) * 2.6 * ring - 1.4
        // The lagoon entrance: cut the ring down below the waterline
        let da = datan2(lz, lx) - gapA
        while (da >  Math.PI) da -= Math.PI * 2
        while (da < -Math.PI) da += Math.PI * 2
        h -= Math.max(0, 1 - Math.abs(da) / 0.5) * 8
      } else {
        // isle: rolling hills under a soft cone
        const core = Math.max(0, 1 - r / 1.05)
        h = height * Math.pow(core, 1.35)
        h += (n - 0.5) * height * 0.5 * Math.max(0, 1 - r * 0.9)
        h = Math.max(h, (1.6 - r * 1.5) * 2)   // keep the middle above water
      }

      // Beach shelf: taper into the sea beyond the shoreline
      h -= Math.max(0, r - 1.02) * 26
      return h
    }

    // ── Faceted mesh: radial grid, jittered vertices, per-face colours ─────
    const RINGS = kind === 'volcano' ? 20 : 15
    const SECT  = kind === 'volcano' ? 34 : 26
    const maxR  = radius * 1.3

    const vert = (i, j) => {
      if (i === 0) return [x, heightAt(x, z), z]
      const a = (j / SECT) * Math.PI * 2
      const rr = (i / RINGS) * maxR
      // Jitter interior vertices for an organic triangulation
      const jr = i < RINGS ? (hash2i(i, j, seed) - 0.5) * (maxR / RINGS) * 0.7 : 0
      const ja = i < RINGS ? (hash2i(j, i, seed ^ 77) - 0.5) * (Math.PI * 2 / SECT) * 0.6 : 0
      const wx = x + Math.cos(a + ja) * (rr + jr)
      const wz = z + Math.sin(a + ja) * (rr + jr)
      return [wx, heightAt(wx, wz), wz]
    }

    const positions = []
    const colors = []
    const col = new THREE.Color()

    const faceColor = (v1, v2, v3, fi) => {
      const cy = (v1[1] + v2[1] + v3[1]) / 3
      // Slope from the face normal's vertical component
      const ux = v2[0] - v1[0], uy = v2[1] - v1[1], uz = v2[2] - v1[2]
      const wx2 = v3[0] - v1[0], wy = v3[1] - v1[1], wz2 = v3[2] - v1[2]
      const nx = uy * wz2 - uz * wy, ny = uz * wx2 - ux * wz2, nz = ux * wy - uy * wx2
      const slope = Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1)

      if (cy < 1.9) col.setHex(0xe2c684)                       // sand
      else if (kind === 'volcano') {
        if (cy > height * 0.45) col.setHex(0x4d4a46)           // dark volcanic rock
        else if (slope < 0.78) col.setHex(0x76736c)            // scree
        else col.setHex(cy > height * 0.16 ? 0x6f7a5e : 0x4f8a4c)
      } else if (slope < 0.68) col.setHex(0x8a877f)            // cliff rock
      else if (cy > height * 0.72) col.setHex(0x2f7a44)        // high dark green
      else col.setHex(0x55a24f)                                // grass
      // per-face tint jitter sells the low-poly look
      const t = (hash2i(fi, 991, seed) - 0.5) * 0.12
      col.offsetHSL(0, 0, t)
      colors.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b)
    }

    let fi = 0
    const pushFace = (a, b, c) => {
      positions.push(...a, ...b, ...c)
      faceColor(a, b, c, fi++)
    }

    // Centre fan (wound CCW from above so normals point up)
    for (let j = 0; j < SECT; j++) {
      pushFace(vert(0, 0), vert(1, (j + 1) % SECT), vert(1, j))
    }
    // Ring quads → two triangles
    for (let i = 1; i < RINGS; i++) {
      for (let j = 0; j < SECT; j++) {
        const a = vert(i, j),     b = vert(i + 1, j)
        const c = vert(i + 1, (j + 1) % SECT), d = vert(i, (j + 1) % SECT)
        pushFace(a, c, b)
        pushFace(a, d, c)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3))
    geo.computeVertexNormals()

    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 1, metalness: 0,
    }))
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.owned = true

    const group = new THREE.Group()
    group.add(mesh)
    return { group, heightAt }
  }

  /**
   * Place a building so ALL FOUR corners of its footprint rest on dry land:
   * each corner above the wave line, limited height spread (no cliff
   * overhangs), seated at the lowest corner so nothing floats.
   * @returns the placed object (already added to group) or null
   */
  _placeBuilding(group, x, z, radius, heightAt, rng, key, half, tries, accept = null) {
    for (let i = 0; i < tries; i++) {
      const a = rng() * Math.PI * 2
      const d = (0.15 + rng() * 0.7) * radius
      const cx = x + dcos(a) * d
      const cz = z + dsin(a) * d
      const yaw = rng() * Math.PI * 2
      const ca = dcos(yaw), sa = dsin(yaw)

      let minH = Infinity, maxH = -Infinity, ok = true
      for (const [ex, ez] of [[half, half], [half, -half], [-half, half], [-half, -half]]) {
        const wx = cx + ex * ca - ez * sa
        const wz = cz + ex * sa + ez * ca
        const h = heightAt(wx, wz)
        if (h < 3.0) { ok = false; break }     // corner in/near the water
        if (h < minH) minH = h
        if (h > maxH) maxH = h
      }
      if (!ok || maxH - minH > 3.5) continue    // too steep — would overhang
      const hC = heightAt(cx, cz)
      if (accept && !accept(hC, d / radius)) continue

      const obj = cloneAsset(key)
      obj.position.set(cx - x, minH - 0.15, cz - z)
      obj.rotation.y = yaw
      group.add(obj)
      return { x: cx, z: cz, h: minH, a }
    }
    return null
  }

  /** Sample spots on the terrain until the predicate accepts one. */
  _findSpot(x, z, radius, heightAt, rng, tries, accept) {
    for (let i = 0; i < tries; i++) {
      const a = rng() * Math.PI * 2
      const d = (0.15 + rng() * 0.75) * radius
      const wx = x + dcos(a) * d
      const wz = z + dsin(a) * d
      const h = heightAt(wx, wz)
      if (accept(h, d / radius)) return { x: wx, z: wz, h, a }
    }
    return null
  }

  /** Classic island: rolling low-poly terrain with flora and settlements. */
  _buildIsle(x, z, radius, rng) {
    const height = 12 + rng() * 26
    const { group, heightAt } = this._buildTerrain(x, z, radius, height, 'isle', rng)
    this._islands.push({
      x, z, r: radius * 1.12, rt: radius * 1.45, h: height, kind: 'isle', heightAt,
    })

    this._scatterFlora(group, x, z, radius, heightAt, 3 + Math.floor(rng() * 6), rng)
    this._scatterShoreRocks(group, x, z, radius, heightAt, 2 + Math.floor(rng() * 4), rng)
    this._scatterCargo(group, x, z, radius, heightAt, Math.floor(rng() * 3), rng)

    // Some larger isles are settled: a farmhouse (or a rare pirate camp),
    // a well, a windmill on the hill, and a beached boat
    if (radius > 34 && rng() < 0.4 && hasAsset('x-farmhouse')) {
      const pirateCamp = rng() < 0.25 && hasAsset('x-piratebase')
      const spot = this._placeBuilding(group, x, z, radius, heightAt, rng,
        pirateCamp ? 'x-piratebase' : 'x-farmhouse',
        pirateCamp ? 9 : 6, 18,
        (h, r) => h < height * 0.6 && r < 0.75)
      if (spot) {
        if (!pirateCamp && rng() < 0.6 && hasAsset('x-windmill')) {
          this._placeBuilding(group, x, z, radius, heightAt, rng,
            'x-windmill', 3.5, 12, (h, r) => h > height * 0.3 && r < 0.65)
        }
        if (rng() < 0.7 && hasAsset('x-well')) {
          this._placeBuilding(group, x, z, radius, heightAt, rng,
            'x-well', 1.4, 10, null)
        }
        if (hasAsset('x-smallship')) {
          const boat = cloneAsset('x-smallship')
          const ba = rng() * Math.PI * 2
          boat.position.set(dcos(ba) * radius * 1.06, 0.3, dsin(ba) * radius * 1.06)
          boat.rotation.y = rng() * Math.PI * 2
          boat.rotation.z = 0.12
          group.add(boat)
        }
      }
    }

    group.position.set(0, 0, 0)   // terrain vertices are in world space
    this._placeIslandGroup(group, x, z)
  }

  /** Towering volcano: dark faceted cone with a caldera. */
  _buildVolcano(x, z, radius, rng) {
    const height = 45 + rng() * 45
    const { group, heightAt } = this._buildTerrain(x, z, radius, height, 'volcano', rng)
    this._islands.push({
      x, z, r: radius * 1.12, rt: radius * 1.45, h: height, kind: 'volcano', heightAt,
    })
    this._scatterFlora(group, x, z, radius, heightAt, 2 + Math.floor(rng() * 4), rng)
    this._scatterShoreRocks(group, x, z, radius, heightAt, 3 + Math.floor(rng() * 4), rng)
    this._placeIslandGroup(group, x, z)
  }

  /** Ring of low sandbars around a lagoon, with a sailable entrance. */
  _buildAtoll(x, z, radius, rng) {
    const { group, heightAt } = this._buildTerrain(x, z, radius, 6, 'atoll', rng)
    this._islands.push({
      x, z, r: radius * 1.05, rt: radius * 1.4, h: 7, kind: 'atoll', heightAt,
    })
    // The odd palm on the sandbars
    for (let i = 0; i < 4; i++) {
      const spot = this._findSpot(x, z, radius, heightAt, rng, 8, h => h > 3.0)
      if (spot && hasAsset('palm-detailed-bend')) {
        const palm = cloneAsset(rng() < 0.5 ? 'palm-detailed-bend' : 'palm-detailed-straight')
        palm.scale.setScalar(2.2)
        palm.position.set(spot.x - x, spot.h - 0.2, spot.z - z)
        palm.rotation.y = rng() * Math.PI * 2
        group.add(palm)
      }
    }
    this._placeIslandGroup(group, x, z)
  }

  /** Terrain verts are world-space; prop children are island-local. */
  _placeIslandGroup(group, x, z) {
    for (const child of group.children) {
      if (!child.userData.owned) {       // props were positioned island-local
        child.position.x += x
        child.position.z += z
      }
    }
    this._worldGroup.add(group)
  }

  // ── Scatter helpers (terrain-aware) ────────────────────────────────────────

  _scatterFlora(group, x, z, radius, heightAt, count, rng) {
    const palmOptions = [
      { key: 'palm-detailed-bend',     scale: 2.5 },
      { key: 'palm-detailed-straight', scale: 2.5 },
      { key: 'tree-palm-tall',         scale: 8.0 },
      { key: 'tree-palm-bend',         scale: 8.5 },
      { key: 'tree-palm-short',        scale: 7.0 },
      { key: 'x-coconut1',             scale: 1.0 },
      { key: 'x-coconut2',             scale: 1.0 },
      { key: 'x-banana',               scale: 1.0 },
    ].filter(o => hasAsset(o.key))

    for (let t = 0; t < count; t++) {
      const spot = this._findSpot(x, z, radius, heightAt, rng, 8,
        h => h > 4.2 && h < radius)      // dry ground only — above any wave crest
      if (!spot) continue
      const opt = palmOptions.length
        ? palmOptions[Math.floor(rng() * palmOptions.length)]
        : null
      if (opt) {
        const palm = cloneAsset(opt.key)
        palm.scale.setScalar(opt.scale)
        palm.position.set(spot.x - x, spot.h - 0.25, spot.z - z)
        palm.rotation.y = rng() * Math.PI * 2
        group.add(palm)
      } else {
        const tree = this._buildPalmTree(rng)
        tree.position.set(spot.x - x, spot.h - 0.25, spot.z - z)
        group.add(tree)
      }
    }
  }

  _scatterShoreRocks(group, x, z, radius, heightAt, count, rng) {
    const rockOptions = [
      { key: 'rocks-a',      scale: 2.0 },
      { key: 'rocks-b',      scale: 2.0 },
      { key: 'rocks-c',      scale: 1.8 },
      { key: 'rock-large-a', scale: 8.0 },
      { key: 'rock-large-b', scale: 8.0 },
      { key: 'rock-tall-a',  scale: 7.0 },
      { key: 'rock-tall-b',  scale: 7.0 },
    ].filter(o => hasAsset(o.key))

    for (let r = 0; r < count; r++) {
      if (!rockOptions.length) break
      const a = rng() * Math.PI * 2
      const d = radius * (0.92 + rng() * 0.25)
      const wx = x + dcos(a) * d
      const wz = z + dsin(a) * d
      const opt = rockOptions[Math.floor(rng() * rockOptions.length)]
      const rock = cloneAsset(opt.key)
      rock.scale.setScalar(opt.scale)
      rock.position.set(wx - x, Math.max(-0.4, heightAt(wx, wz) - 0.6), wz - z)
      rock.rotation.y = rng() * Math.PI * 2
      group.add(rock)
    }
  }

  _scatterCargo(group, x, z, radius, heightAt, count, rng) {
    const propOptions = [
      { key: 'barrel',   scale: 2.0 },
      { key: 'chest',    scale: 2.0 },
      { key: 'cannon',   scale: 2.5 },
      { key: 'x-barrel', scale: 1.0 },
      { key: 'x-box',    scale: 1.0 },
    ].filter(o => hasAsset(o.key))

    for (let p = 0; p < count; p++) {
      if (!propOptions.length) break
      const spot = this._findSpot(x, z, radius, heightAt, rng, 6, h => h > 3.0)
      if (!spot) continue
      const opt = propOptions[Math.floor(rng() * propOptions.length)]
      const prop = cloneAsset(opt.key)
      prop.scale.setScalar(opt.scale)
      prop.position.set(spot.x - x, spot.h - 0.15, spot.z - z)
      prop.rotation.y = rng() * Math.PI * 2
      group.add(prop)
    }
  }

  _buildReef(x, z, radius, rng) {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    this._islands.push({ x, z, r: radius * 1.15, h: 6, kind: 'reef' })

    const rockOptions = ['rocks-a', 'rocks-b', 'rocks-c', 'rock-tall-a', 'rock-tall-b']
      .filter(k => hasAsset(k))
    const clusters = 4 + Math.floor(rng() * 5)
    for (let i = 0; i < clusters; i++) {
      if (!rockOptions.length) break
      const a = rng() * Math.PI * 2
      const d = rng() * radius
      const key  = rockOptions[Math.floor(rng() * rockOptions.length)]
      const rock = cloneAsset(key)
      rock.scale.setScalar(key.startsWith('rock-') ? 4 + rng() * 4 : 1.5 + rng() * 1.2)
      rock.position.set(dcos(a) * d, -0.5, dsin(a) * d)
      rock.rotation.y = rng() * Math.PI * 2
      group.add(rock)
    }

    this._worldGroup.add(group)
  }

  // ── Scatter helpers ────────────────────────────────────────────────────────

  _buildPalmTree(rng) {
    const group   = new THREE.Group()
    const trunkMat = new THREE.MeshPhongMaterial({ color: 0x7d5a2a })
    const leafMat  = new THREE.MeshPhongMaterial({ color: 0x1e8449, side: THREE.DoubleSide })

    // Leaning trunk
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.44, 7, 6), trunkMat)
    trunk.position.y = 3.5
    trunk.rotation.z = (rng() - 0.5) * 0.35
    trunk.castShadow = true
    trunk.userData.owned = true
    group.add(trunk)

    // Fan of leaves
    const leafCount = 6 + Math.floor(rng() * 3)
    for (let i = 0; i < leafCount; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(2.5, 1.8, 4), leafMat)
      const angle = (i / leafCount) * Math.PI * 2
      leaf.position.set(
        dcos(angle) * 2.2,
        7.4,
        dsin(angle) * 2.2,
      )
      leaf.rotation.y = angle
      leaf.rotation.z = Math.PI / 2.8
      leaf.castShadow = true
      leaf.userData.owned = true
      group.add(leaf)
    }

    return group
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ambient ocean decorations: buoys, wrecks, drifting boats
  // ──────────────────────────────────────────────────────────────────────────

  _buildAmbientDecor(rng) {
    const HALF = WORLD_SIZE * 0.45

    // ── Buoys ──────────────────────────────────────────────────────────────
    const buoyKey  = hasAsset('buoy-flag') ? 'buoy-flag' : hasAsset('buoy') ? 'buoy' : null
    const numBuoys = 34
    for (let i = 0; i < numBuoys; i++) {
      if (!buoyKey) break
      const bx = (rng() - 0.5) * HALF * 2
      const bz = (rng() - 0.5) * HALF * 2
      const b  = cloneAsset(buoyKey)
      b.scale.setScalar(3.0)
      b.position.set(bx, 0, bz)
      b.rotation.y = rng() * Math.PI * 2
      this._worldGroup.add(b)
    }

    // ── Wrecked ships ──────────────────────────────────────────────────────
    if (hasAsset('ship-wreck')) {
      for (let i = 0; i < 6; i++) {
        const wx = (rng() - 0.5) * HALF * 1.9
        const wz = (rng() - 0.5) * HALF * 1.9
        const w  = cloneAsset('ship-wreck')
        w.scale.setScalar(1.2)
        w.position.set(wx, -0.5, wz)
        w.rotation.y = rng() * Math.PI * 2
        // Slight heel to make it look shipwrecked
        w.rotation.z = (rng() - 0.5) * 0.4
        this._worldGroup.add(w)
      }
    }

    // ── Small ambient sailing boats (Kenney Watercraft Kit) ───────────────
    // (The ship-ghost model is used by the AI fleet in ai.js, not as decor.)
    const sailOptions = ['boat-sail-a', 'boat-sail-b'].filter(k => hasAsset(k))
    const numBoats    = 10
    for (let i = 0; i < numBoats; i++) {
      if (!sailOptions.length) break
      const key = sailOptions[Math.floor(rng() * sailOptions.length)]
      const bx  = (rng() - 0.5) * HALF * 1.9
      const bz  = (rng() - 0.5) * HALF * 1.9
      const b   = cloneAsset(key)
      b.scale.setScalar(5.0)
      b.position.set(bx, 0, bz)
      b.rotation.y = rng() * Math.PI * 2
      this._worldGroup.add(b)
    }
  }
}
