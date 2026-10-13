// Counter-based randomness shared by every world: a stateless hash of (seed, lane, step, salt). No state is
// carried between invocations, so results do not depend on chunking, dispatch order or resumption, and a CPU
// mirror (below) reproduces any draw. With salt 0 it is exactly the hash of Algocell's BFF kernel,
// hash32(p * 0x9E3779B1 ^ (s + 1) * 0x85EBCA77 ^ roll_seed) (experiments/micro/bff.py), so BFF's dial maps onto it.

/** XOR-ed into the salt of initial-state draws, so they never coincide with a dial's draws at the same salt. */
export const ZIL_SALT_INIT = 0x494e4954; // "INIT"

export const HASH_WGSL = `// Counter-based hash (Zilion world): no state, so draws are independent of chunking and order.
fn zil_mix32(x: u32) -> u32 {
    var h = x * 0x9E3779B9u;
    h = h ^ (h >> 16u);
    h = h * 0x85EBCA6Bu;
    h = h ^ (h >> 13u);
    h = h * 0xC2B2AE35u;
    h = h ^ (h >> 16u);
    return h;
}
fn zil_hash(seed: u32, lane: u32, step: u32, salt: u32) -> u32 {
    return zil_mix32((lane * 0x9E3779B1u) ^ ((step + 1u) * 0x85EBCA77u) ^ seed ^ zil_mix32(salt));
}
const ZIL_SALT_INIT: u32 = ${ZIL_SALT_INIT >>> 0}u;
`;

/** CPU mirror of `zil_mix32`. */
export function zilMix32(x: number): number {
  let h = Math.imul(x >>> 0, 0x9e3779b9) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** CPU mirror of `zil_hash(seed, lane, step, salt)`. */
export function zilHash(seed: number, lane: number, step: number, salt = 0): number {
  const x = (Math.imul(lane >>> 0, 0x9e3779b1) ^ Math.imul((step + 1) >>> 0, 0x85ebca77) ^ (seed >>> 0) ^ zilMix32(salt)) >>> 0;
  return zilMix32(x);
}

/**
 * Threshold of a dial with probability p: a draw d halts when d < T, T = round(p · 2^32), clamped to 2^32 − 1.
 * p ≥ 1 is "always" and p ≤ 0 "never"; both are handled without a draw by the generated code.
 */
export function dialThreshold(p: number): number {
  if (!(p >= 0 && p <= 1)) throw new Error(`probability must be in [0, 1] (got ${p})`);
  return Math.min(Math.round(p * 4294967296), 4294967295);
}

/**
 * CPU mirror of the world's dial draw `zil_draw(salt)` at a 64-bit step index (the dispatch's `stepBase` plus the
 * steps run since it began): zil_hash(seed ^ zil_mix32(hi), lane, lo, salt) with lo and hi the low and high words
 * of the step. zil_mix32(0) = 0, so below 2^32 steps it is exactly zilHash(seed, lane, step, salt).
 */
export function zilDraw(seed: number, lane: number, step: number | bigint, salt = 0): number {
  const s = BigInt(step);
  if (s < 0n || s >= 1n << 64n) throw new Error(`step ${step} is not a 64-bit step index`);
  const lo = Number(s & 0xffffffffn);
  const hi = Number(s >> 32n);
  return zilHash((seed ^ zilMix32(hi)) >>> 0, lane, lo, salt);
}

/** CPU mirror of the initial-state draw for state field `fieldIndex` (its index in the state record). */
export function initDraw(seed: number, lane: number, fieldIndex: number, salt = 0, bits = 32): number {
  const v = zilHash(seed, lane, fieldIndex, (salt ^ ZIL_SALT_INIT) >>> 0);
  return bits >= 32 ? v : v & ((1 << bits) - 1);
}
