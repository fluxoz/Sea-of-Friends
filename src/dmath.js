/**
 * dmath.js – Deterministic math for the lockstep simulation.
 *
 * ECMAScript guarantees bit-exact IEEE-754 doubles for + - * /,
 * Math.sqrt, Math.round/floor/abs/min/max and integer ops — but NOT for the
 * transcendentals (Math.sin/cos/atan2/…), which are "implementation-
 * approximated" and may differ by an ulp between engines. One ulp is enough:
 * rejection sampling and collision branches amplify it into a fully diverged
 * world. Everything the simulation touches is rebuilt here from the
 * guaranteed operations, so every peer computes bit-identical state.
 *
 * Rendering/audio code is free to keep using Math.* — only code that feeds
 * simulation state must come through this module.
 */

export const PI      = Math.PI
export const TWO_PI  = Math.PI * 2
export const HALF_PI = Math.PI / 2

// ── sin/cos ───────────────────────────────────────────────────────────────────
// Range-reduce to [-π/2, π/2], then an odd Taylor polynomial.
// Max error ≈ 6e-8 near the fold — far beyond gameplay needs, and identical
// on every engine because it uses only exact operations.
const S3 = -1 / 6, S5 = 1 / 120, S7 = -1 / 5040, S9 = 1 / 362880, S11 = -1 / 39916800

export function dsin(x) {
  x = x - Math.round(x / TWO_PI) * TWO_PI
  if (x > HALF_PI) x = PI - x
  else if (x < -HALF_PI) x = -PI - x
  const z = x * x
  return x * (1 + z * (S3 + z * (S5 + z * (S7 + z * (S9 + z * S11)))))
}

export function dcos(x) {
  return dsin(x + HALF_PI)
}

// ── atan2 / asin ──────────────────────────────────────────────────────────────
// Minimax polynomial for atan on [0, 1] (max err ≈ 1e-5 rad) + quadrant logic.
const A1 = 0.99997726, A3 = -0.33262347, A5 = 0.19354346,
      A7 = -0.11643287, A9 = 0.05265332, A11 = -0.01172120

function atan01(x) {
  const z = x * x
  return x * (A1 + z * (A3 + z * (A5 + z * (A7 + z * (A9 + z * A11)))))
}

export function datan2(y, x) {
  if (y === 0 && x === 0) return 0
  const ax = Math.abs(x), ay = Math.abs(y)
  let r = ax >= ay ? atan01(ay / ax) : HALF_PI - atan01(ax / ay)
  if (x < 0) r = PI - r
  return y < 0 ? -r : r
}

export function dasin(x) {
  if (x >= 1) return HALF_PI
  if (x <= -1) return -HALF_PI
  return datan2(x, Math.sqrt(1 - x * x))
}

/** Math.hypot is NOT spec-deterministic; this is (sqrt is IEEE-exact). */
export function dhypot(x, y) {
  return Math.sqrt(x * x + y * y)
}

/** Wrap an angle to [-π, π]. */
export function wrapAngle(a) {
  return a - Math.round(a / TWO_PI) * TWO_PI
}

// ── Seedable PRNG with snapshot-able state ────────────────────────────────────
// Same LCG the world generator uses; integer ops only, so exact everywhere.
export class DRng {
  constructor(seed = 1) { this.s = seed >>> 0 }
  next()       { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s / 4294967296 }
  range(a, b)  { return a + this.next() * (b - a) }
  int(n)       { return (this.next() * n) | 0 }
  save()       { return this.s }
  load(s)      { this.s = s >>> 0 }
}

// ── Hashing (FNV-1a based) ────────────────────────────────────────────────────

export function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Running hash over the simulation state (quantised floats). */
export class HashAcc {
  constructor() { this.h = 0x811c9dc5 >>> 0 }
  int(n) {
    n = n | 0
    this.h = (Math.imul(this.h ^ (n & 0xffff), 0x01000193)) >>> 0
    this.h = (Math.imul(this.h ^ ((n >> 16) & 0xffff), 0x01000193)) >>> 0
    return this
  }
  num(v) { return this.int(Math.round(v * 64)) }
  str(s) { return this.int(hash32(s)) }
  value() { return this.h >>> 0 }
}
