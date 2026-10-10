// Address aliasing on a ring of P bytes. Shared by cores (stack-top rules) and worlds (L1); no GPU code.
//
// A core forms every address at its own width w (16 bits for the Z80 and 6502). The world maps it to a ring
// position with `pos = (addr mod 2^w) mod P`. When P does not divide 2^w, the wrap 2^w − 1 → 0 is a seam: the
// two addresses sit at positions (2^w − 1) mod P and 0, so any crossing of address 0 lands at (2^w + t) mod P,
// not at t mod P. `seamOffset` is that shift. Ring-native cores (w = 0, e.g. BFF) compute positions themselves.

function span(addrBits: number): number {
  if (addrBits === 0) return 0;
  if (!Number.isInteger(addrBits) || addrBits < 1 || addrBits > 32) {
    throw new Error(`addrBits must be 0 (ring-native) or 1..32 (got ${addrBits})`);
  }
  return 2 ** addrBits;
}

function checkP(P: number): void {
  if (!Number.isInteger(P) || P < 1) throw new Error(`ring size P must be a positive integer (got ${P})`);
}

/** Ring position of an ISA address: (addr mod 2^w) mod P. For ring-native cores (w = 0): addr mod P. */
export function ringPos(addr: number, P: number, addrBits = 16): number {
  checkP(P);
  const n = span(addrBits);
  const a = n === 0 ? addr : ((addr % n) + n) % n;
  return ((a % P) + P) % P;
}

/**
 * The largest w-bit address that aliases ring position `pos`: 2^w − 1 − ((2^w − 1 − pos) mod P).
 * Equals 2^w − 1 exactly when pos = P − 1 and P divides 2^w. Throws when no w-bit address reaches `pos`.
 */
export function highestAlias(pos: number, P: number, addrBits = 16): number {
  checkP(P);
  if (!Number.isInteger(pos) || pos < 0 || pos >= P) throw new Error(`position ${pos} is not on a ring of ${P}`);
  const n = span(addrBits);
  if (n === 0) return pos;
  if (pos > n - 1) throw new Error(`position ${pos} is unreachable with ${addrBits}-bit addresses`);
  return n - 1 - ((n - 1 - pos) % P);
}

/** The smallest address that aliases ring position `pos` (pos itself whenever it is reachable). */
export function lowestAlias(pos: number, P: number, addrBits = 16): number {
  checkP(P);
  if (!Number.isInteger(pos) || pos < 0 || pos >= P) throw new Error(`position ${pos} is not on a ring of ${P}`);
  const n = span(addrBits);
  if (n !== 0 && pos > n - 1) throw new Error(`position ${pos} is unreachable with ${addrBits}-bit addresses`);
  return pos;
}

/** 2^w mod P: how far a crossing of address 0 is shifted on the ring (0 when P divides 2^w: no seam). */
export function seamOffset(P: number, addrBits = 16): number {
  checkP(P);
  const n = span(addrBits);
  return n === 0 ? 0 : n % P;
}
