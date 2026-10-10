// World-spec test cases (Z80 core), with hand-computed expectations. Conventions:
//   - every address is formed at 16 bits first, then mapped to a ring position: pos = (addr mod 65536) mod P;
//   - 0xFFFF sits at position 65535 mod P; the values are worked out by hand in the comments and written as
//     literals (q(P) below only cross-checks the literal against the same first-principles formula);
//   - memory expectations are ring positions, which equal host offsets for every non-padding position.

const q = (P, lit) => {
  if (65535 % P !== lit) throw new Error(`hand-computed 0xFFFF mod ${P} = ${lit} is wrong`);
  return lit;
};
/** Lane memory of n bytes: `place` maps a position to the bytes starting there. */
const mem = (n, place = {}, fill = 0) => {
  const m = new Uint8Array(n).fill(fill);
  for (const [pos, bytes] of Object.entries(place)) m.set(bytes, +pos);
  return m;
};
const ring = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, ...extra });
const pair = (L, P, extra = {}) => ({
  memory: { kind: "segments", segments: [{ bytes: L, name: "A" }, { bytes: L, name: "B" }], ring: P },
  ...extra,
});
const maps = { fetchMap: true, startMap: true };

/** Deterministic bytes (SplitMix32-style) for the random-program cases. */
function randomBytes(n, seed) {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    out[i] = (z ^ (z >>> 16)) & 0xff;
  }
  return out;
}
const lanesOf = (data, bytes) => Array.from({ length: data.length / bytes }, (_, i) => ({ mem: data.subarray(i * bytes, (i + 1) * bytes) }));

function compareJobs(a, b, what = "lane") {
  const errs = [];
  a.result.forEach((x, i) => {
    const y = b.result[i];
    if (!x.mem.every((v, k) => v === y.mem[k])) errs.push(`${what} ${i}: memory differs`);
    if (!x.raw.every((v, k) => v === y.raw[k])) errs.push(`${what} ${i}: record differs (${Array.from(x.raw).join(",")} vs ${Array.from(y.raw).join(",")})`);
  });
  return errs;
}

export const CASES = [
  // ---------------------------------------------------------------------------------------------------------
  // Ring addressing on odd and padded rings
  // ---------------------------------------------------------------------------------------------------------
  ...[33, 35, 37, 73, 75, 79].map((P) => ({
    name: `ring P=${P}: straight-line code runs off position P-1 onto position 0`,
    // JP P-1 (C3 lo 00); LD A,n at address P-1, whose operand is address P → position 0, the C3 byte.
    // After 2 steps: A = 0xC3, PC = P+1. Fetched {0,1,2,P-1}; instruction starts {0,P-1}.
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(P, { outputs: maps }) }, [
        { mem: mem(P, { 0: [0xc3, P - 1, 0x00], [P - 1]: [0x3e] }),
          expect: { steps: 2, halt: "running", state: { a: 0xc3, pc: P + 1 }, fetched: [0, 1, 2, P - 1], starts: [0, P - 1] } },
      ], { budget: 2 }),
  })),
  ...[[33, 30], [35, 15], [37, 8], [38, 23], [40, 15], [73, 54], [75, 60], [79, 44], [100, 35]].map(([P, lit]) => ({
    name: `seam P=${P}: PC runs from 0xFFFF (position ${lit}) to 0x0000 (position 0)`,
    // JP 0xFFFF; LD A,n at 0xFFFF → position 65535 mod P; its operand is address 0x0000 → position 0 (C3).
    // A = 0xC3, PC = 0x0001 (not 0x10000 mod P): the seam is crossed in 16 bits, then mapped.
    setup: ({ Z, addJob }) => {
      const p = q(P, lit);
      return addJob({ isa: Z.z80, world: ring(P, { outputs: maps }) }, [
        { mem: mem(P, { 0: [0xc3, 0xff, 0xff], [p]: [0x3e] }),
          expect: { steps: 2, state: { a: 0xc3, pc: 0x0001 }, fetched: [0, 1, 2, p], starts: [0, p] } },
      ], { budget: 2 });
    },
  })),
  ...[[33, 30], [38, 23], [40, 15]].map(([P, lit]) => ({
    name: `seam P=${P}: JR backwards across address 0 lands on 0xFFFF (position ${lit})`,
    // JR -3 at 0: PC after the operand is 2; 2 - 3 = 0xFFFF → position 65535 mod P. LD A,n there reads its
    // operand from address 0x0000 → position 0 = 0x18. A = 0x18, PC = 1.
    setup: ({ Z, addJob }) => {
      const p = q(P, lit);
      return addJob({ isa: Z.z80, world: ring(P, { outputs: maps }) }, [
        { mem: mem(P, { 0: [0x18, 0xfd], [p]: [0x3e] }),
          expect: { steps: 2, state: { a: 0x18, pc: 1 }, fetched: [0, 1, p], starts: [0, p] } },
      ], { budget: 2 });
    },
  })),
  ...[[40, 15], [33, 30]].map(([P, lit]) => ({
    name: `seam P=${P}: PUSH from SP=0x0001 writes 0x0000 (position 0) and 0xFFFF (position ${lit})`,
    // LD BC,0x1234; PUSH BC: SP 0x0001 → 0x0000, write B=0x12 at position 0; → 0xFFFF, write C=0x34 at
    // position 65535 mod P. Then HALT at 4.
    setup: ({ Z, addJob }) => {
      const p = q(P, lit);
      return addJob({ isa: Z.z80, world: ring(P, { init: { set: { sp: 0x0001 } }, outputs: { writeCounts: true } }) }, [
        { mem: mem(P, { 0: [0x01, 0x34, 0x12, 0xc5, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", state: { sp: 0xffff, pc: 4, b: 0x12, c: 0x34 }, mem: { 0: 0x12, [p]: 0x34 }, writes: [2] } },
      ]);
    },
  })),
  ...[[40, 15], [33, 30]].map(([P, lit]) => ({
    name: `seam P=${P}: POP from SP=0xFFFF reads position ${lit}, then position 0`,
    // POP DE (D1 at 0): low byte from 0xFFFF (position 65535 mod P) = 0xCD, high byte from 0x0000 = the D1
    // opcode itself. DE = 0xD1CD, SP = 0x0001. HALT at 1.
    setup: ({ Z, addJob }) => {
      const p = q(P, lit);
      return addJob({ isa: Z.z80, world: ring(P, { init: { set: { sp: 0xffff } } }) }, [
        { mem: mem(P, { 0: [0xd1, 0x76], [p]: [0xcd] }),
          expect: { steps: 2, halt: "halt-insn", state: { d: 0xd1, e: 0xcd, sp: 0x0001, pc: 1 } } },
      ]);
    },
  })),
  {
    name: "seam P=40: LD (0xFFFF),HL splits the word across the seam (positions 15 and 0)",
    // LD HL,0xABCD; LD (0xFFFF),HL: L → 0xFFFF (position 15), H → 0x0000 (position 0). HALT at 6.
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(40) }, [
        { mem: mem(40, { 0: [0x21, 0xcd, 0xab, 0x22, 0xff, 0xff, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", mem: { [q(40, 15)]: 0xcd, 0: 0xab } } },
      ]),
  },
  {
    name: "seam P=40: (IX+d) wraps in 16 bits before the ring (0xFFFE+3 → position 1, 0x0002-4 → position 14)",
    // Lane 0: IX = 0xFFFE; LD (IX+3),0x77 → 0x0001 → position 1 (an unmasked model would hit 65537 mod 40 = 17).
    // Lane 1: IX = 0x0002; LD (IX-4),0x77 → 0xFFFE → position 65534 mod 40 = 14.
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(40) }, [
        { mem: mem(40, { 0: [0xdd, 0x21, 0xfe, 0xff, 0xdd, 0x36, 0x03, 0x77, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", state: { ix: 0xfffe, pc: 8 }, mem: { 1: 0x77, 17: 0x00 } } },
        { mem: mem(40, { 0: [0xdd, 0x21, 0x02, 0x00, 0xdd, 0x36, 0xfc, 0x77, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", state: { ix: 0x0002 }, mem: { 14: 0x77 } } },
      ]),
  },
  {
    name: "seam P=40: LDIR copies across address 0; one iteration per step",
    // HL=0xFFFE DE=0x0010 BC=4; LDIR copies 0xFFFE,0xFFFF,0x0000,0x0001 = positions 14,15,0,1 = AA BB 21 FE
    // to positions 16..19. Steps: 3 loads + 4 LDIR iterations + HALT = 8. HL ends at 0x0002 (16-bit wrap).
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(40, { outputs: { writeCounts: true } }) }, [
        { mem: mem(40, { 0: [0x21, 0xfe, 0xff, 0x11, 0x10, 0x00, 0x01, 0x04, 0x00, 0xed, 0xb0, 0x76], 14: [0xaa, 0xbb] }),
          expect: { steps: 8, halt: "halt-insn", state: { pc: 11, h: 0x00, l: 0x02, d: 0x00, e: 0x14, b: 0, c: 0 },
            mem: { 16: 0xaa, 17: 0xbb, 18: 0x21, 19: 0xfe }, writes: [4] } },
      ]),
  },
  {
    name: "seam P=40: CALL/RET with the stack at the last byte (SP0 = 0xFFEF)",
    // SP0 = highestAlias(39, 40) = 0xFFFF - ((0xFFFF - 39) mod 40) = 0xFFFF - 16 = 0xFFEF.
    // CALL 0x0020 pushes 0x0003: 0x00 at 0xFFEE (position 38), 0x03 at 0xFFED (position 37); RET at 32
    // returns to 3, HALT. SP back to 0xFFEF.
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(40, { init: { stack: { topAliases: "lastByte" } } }) }, [
        { mem: mem(40, { 0: [0xcd, 0x20, 0x00, 0x76], 32: [0xc9], 38: [0xee] }),
          expect: { steps: 3, halt: "halt-insn", state: { sp: 0xffef, pc: 3 }, mem: { 38: 0x00, 37: 0x03 } } },
      ]),
  },
  ...[
    // [label, world, SP0] — SP0 = 0xFFFF - ((0xFFFF - t) mod P), t = the last byte of the last segment.
    ["mask 256", { memory: { kind: "mask", bytes: 256 } }, 0xffff],
    ["ring 32", ring(32), 0xffff],
    ["ring 38", ring(38), 0xffe7], // (65535-37) mod 38 = 24
    ["ring 40", ring(40), 0xffef], // (65535-39) mod 40 = 16
    ["ring 100", ring(100), 0xffdb], // (65535-99) mod 100 = 36
    ["pair 16/ring 33", pair(16, 33), 0xffdf], // t = 31: 65504 mod 33 = 32
    ["pair 16/ring 37", pair(16, 37), 0xfff1], // t = 31: 65504 mod 37 = 14
    ["pair 36/ring 73", pair(36, 73), 0xffc7], // t = 71: 65464 mod 73 = 56
    ["pair 36/ring 75", pair(36, 75), 0xffbf], // t = 71: 65464 mod 75 = 64
    ["pair 36/ring 79", pair(36, 79), 0xffcb], // t = 71: 65464 mod 79 = 52
  ].map(([label, world, sp]) => ({
    name: `stack convention, ${label}: SP0 = 0x${sp.toString(16)} aliases the last byte`,
    setup: ({ Z, addJob }) => {
      const w = { ...world, init: { stack: { topAliases: "lastByte" } } };
      const built = Z.buildMachine({ isa: Z.z80, world: w });
      const n = built.manifest.memory.hostBytesPerLane;
      return addJob(built, [{ mem: mem(n, { 0: [0x76] }), expect: { steps: 1, halt: "halt-insn", state: { sp, pc: 0 } } }]);
    },
  })),
  {
    name: "stack convention, explicit position: topAliases 5 on ring 40 gives SP0 = 0xFFF5",
    // 0xFFFF - ((0xFFFF - 5) mod 40) = 0xFFFF - 10 = 0xFFF5; 0xFFF5 mod 40 = 5.
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(40, { init: { stack: { topAliases: 5 } } }) }, [
        { mem: mem(40, { 0: [0x76] }), expect: { state: { sp: 0xfff5 } } },
      ]),
  },

  // ---------------------------------------------------------------------------------------------------------
  // Padded rings (segments): padding is zeroed every run and never stored; writes are counted per region
  // ---------------------------------------------------------------------------------------------------------
  {
    name: "padded pair L=16 P=37: padding is writable, zero at start, never stored; writes per segment",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: pair(16, 37, { init: { stack: { topAliases: "lastByte" } }, outputs: { writeCounts: true } }) }, [
        // LD A,0x5A; LD (0x22),A → position 34 (padding); LD A,(0x22) reads it back; HALT at 8.
        { label: "write padding", mem: mem(32, { 0: [0x3e, 0x5a, 0x32, 0x22, 0x00, 0x3a, 0x22, 0x00, 0x76] }),
          expect: { steps: 4, halt: "halt-insn", state: { a: 0x5a, pc: 8 }, writes: [0, 0, 1],
            memAll: mem(32, { 0: [0x3e, 0x5a, 0x32, 0x22, 0x00, 0x3a, 0x22, 0x00, 0x76] }) } },
        // LD A,(0x22): the padding reads 0 at the start of every run (the host layout has no padding bytes).
        { label: "read padding", mem: mem(32, { 0: [0x3a, 0x22, 0x00, 0x76] }, 0x99),
          expect: { steps: 2, state: { a: 0x00 }, writes: [0, 0, 0] } },
        // SP0 = 0xFFF1; PUSH BC writes 0x12 at 0xFFF0 (position 30) and 0x34 at 0xFFEF (position 29), in B.
        { label: "push", mem: mem(32, { 0: [0x01, 0x34, 0x12, 0xc5, 0x76] }),
          expect: { steps: 3, state: { sp: 0xffef }, mem: { 30: 0x12, 29: 0x34 }, writes: [0, 2, 0] } },
        // LD HL,0xBBAA; LD (0x000F),HL: L → position 15 (A), H → position 16 (B).
        { label: "straddle", mem: mem(32, { 0: [0x21, 0xaa, 0xbb, 0x22, 0x0f, 0x00, 0x76] }),
          expect: { steps: 3, mem: { 15: 0xaa, 16: 0xbb }, writes: [1, 1, 0] } },
      ]),
  },
  {
    name: "padded pair L=36 P=75: padding at 72..74; 0xFFFF maps to position 60, inside B",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: pair(36, 75, { outputs: { writeCounts: true } }) }, [
        // LD A,0x77; LD (0x0048),A → position 72 = padding; HALT. Output memory unchanged.
        { label: "padding", mem: mem(72, { 0: [0x3e, 0x77, 0x32, 0x48, 0x00, 0x76] }),
          expect: { steps: 3, writes: [0, 0, 1], memAll: mem(72, { 0: [0x3e, 0x77, 0x32, 0x48, 0x00, 0x76] }) } },
        // LD A,0x77; LD (0xFFFF),A → position 65535 mod 75 = 60, in B (36..71).
        { label: "seam", mem: mem(72, { 0: [0x3e, 0x77, 0x32, 0xff, 0xff, 0x76] }),
          expect: { steps: 3, writes: [0, 1, 0], mem: { [q(75, 60)]: 0x77 } } },
      ]),
  },

  // ---------------------------------------------------------------------------------------------------------
  // Budgets
  // ---------------------------------------------------------------------------------------------------------
  {
    name: "budget per lane (steps): INC A everywhere, budgets 0, 1, 5, 64, 200",
    // Each step is one INC A: A = budget mod 256, PC = budget, R = budget mod 128.
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(64, { budget: { value: "perLane" } }) },
        [0, 1, 5, 64, 200].map((b) => ({ budget: b, mem: mem(64, {}, 0x3c),
          expect: { steps: b, halt: "running", state: { a: b & 0xff, pc: b, r: b & 0x7f } } }))),
  },
  {
    name: "budget uniform: the world default (7) and a per-run override (9)",
    setup: ({ Z, addJob }) => [
      addJob({ isa: Z.z80, world: ring(64, { budget: { value: 7 } }) }, [{ mem: mem(64, {}, 0x3c), expect: { steps: 7, state: { a: 7 } } }]),
      addJob({ isa: Z.z80, world: ring(64, { budget: { value: 7 } }) }, [{ mem: mem(64, {}, 0x3c), expect: { steps: 9, state: { a: 9 } } }], { budget: 9 }),
    ],
  },
  {
    name: "budget: a lane that halts first reports the steps it ran",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(32) }, [
        { mem: mem(32, { 0: [0x3c, 0x3c, 0x76] }), expect: { steps: 3, halt: "halt-insn", state: { a: 2, pc: 2 } } },
      ], { budget: 100 }),
  },
  {
    name: "budget fetchBytes: 2-byte instructions, budgets 0,1,2,4,5,6 bytes → 0,1,1,2,3,3 steps",
    // LD B,1 (06 01) everywhere. A step starts while fewer than `budget` bytes have been fetched, so the
    // steps are ceil(budget / 2) and PC = 2 · steps.
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(64, { budget: { unit: "fetchBytes", value: "perLane" } }) },
        [[0, 0], [1, 1], [2, 1], [4, 2], [5, 3], [6, 3]].map(([b, s]) => ({
          budget: b, mem: mem(64, Object.fromEntries(Array.from({ length: 32 }, (_, i) => [2 * i, [0x06, 0x01]]))),
          expect: { steps: s, state: { pc: 2 * s } } }))),
  },

  // ---------------------------------------------------------------------------------------------------------
  // Halting and trap policies
  // ---------------------------------------------------------------------------------------------------------
  {
    name: "native HALT: halts, parks PC on the opcode, reason halt-insn",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(32) }, [
        { mem: mem(32, { 0: [0x3c, 0x3c, 0x76, 0x3c] }),
          expect: { steps: 3, halt: "halt-insn", state: { a: 2, pc: 2, halted: 1, r: 3 } } },
      ], { budget: 10 }),
  },
  {
    name: "trap policy halt-insn: ignore turns HALT into a 1-byte no-op",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(32, { halting: { traps: { "halt-insn": "ignore" } } }) }, [
        { mem: mem(32, { 0: [0x3c, 0x3c, 0x76, 0x3c] }), expect: { steps: 4, halt: "running", state: { a: 3, pc: 4, halted: 0 } } },
      ], { budget: 4 }),
  },
  {
    name: "lethal first unit 0x00: halts only on the first byte of an instruction",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(32, { halting: { lethal: { firstUnit: 0 } }, outputs: maps }) }, [
        // INC A; 00 → halted by the host, PC backed onto the 00, R counted both M1s.
        { label: "3C 00", mem: mem(32, { 0: [0x3c, 0x00, 0x3c, 0x76] }),
          expect: { steps: 2, halt: "host", state: { a: 1, pc: 1, halted: 2, r: 2 }, fetched: [0, 1], starts: [0, 1] } },
        // LD A,0 (operand zero), INC A, HALT.
        { label: "3E 00", mem: mem(32, { 0: [0x3e, 0x00, 0x3c, 0x76] }), expect: { steps: 3, halt: "halt-insn", state: { a: 1, pc: 3 } } },
        // DD 00: the zero is the opcode after a prefix, not a first unit.
        { label: "DD 00", mem: mem(32, { 0: [0xdd, 0x00, 0x3c, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", state: { a: 1, pc: 3 }, starts: [0, 2, 3], fetched: [0, 1, 2, 3] } },
        // ED 00: an undefined ED opcode (2-byte no-op).
        { label: "ED 00", mem: mem(32, { 0: [0xed, 0x00, 0x3c, 0x76] }), expect: { steps: 3, halt: "halt-insn", state: { a: 1 } } },
        // CB 00 = RLC B.
        { label: "CB 00", mem: mem(32, { 0: [0xcb, 0x00, 0x76] }), expect: { steps: 2, halt: "halt-insn", state: { pc: 2 } } },
        // A zero at the entry point halts in the first step.
        { label: "00", mem: mem(32), expect: { steps: 1, halt: "host", state: { pc: 0, r: 1 }, fetched: [0], starts: [0] } },
      ], { budget: 50 }),
  },
  {
    name: "lethal first unit 0xC9 (any unit value works): RET halts before it executes",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(32, { halting: { lethal: { firstUnit: 0xc9 } } }) }, [
        { mem: mem(32, { 0: [0x3c, 0xc9, 0x76] }), expect: { steps: 2, halt: "host", state: { a: 1, pc: 1 } } },
      ], { budget: 50 }),
  },
  {
    name: "lethal dial p=0.3: every zero first unit halts iff zil_hash(seed, lane, step, 0) < round(0.3·2^32)",
    // All-zero memory: step s fetches a 00 at position s. Lane l halts at the first s with a draw under T;
    // then steps = s+1 and PC = s (backed onto the byte). Expected values from the hash formula (CPU mirror).
    setup: ({ Z, addJob }) => {
      const seed = 12345;
      const T = Z.dialThreshold(0.3);
      const lanes = Array.from({ length: 2048 }, (_, l) => {
        let s = 0;
        while (s < 40 && !(Z.zilHash(seed, l, s, 0) < T)) s++;
        return { mem: mem(32), expect: s < 40 ? { steps: s + 1, halt: "host", state: { pc: s } } : { steps: 40, halt: "running", state: { pc: 40 } } };
      });
      return addJob({ isa: Z.z80, world: ring(32, { halting: { lethal: { firstUnit: 0, probability: 0.3 } } }) }, lanes, { seed, budget: 40 });
    },
    check: (job) => {
      const first = job.result.filter((r) => r.steps === 1 && r.halt === "host").length / job.result.length;
      const sd = Math.sqrt(0.3 * 0.7 / job.result.length);
      return Math.abs(first - 0.3) < 4 * sd ? [] : [`halt rate at the first step ${first.toFixed(4)} is not 0.3 ± ${(4 * sd).toFixed(4)}`];
    },
    note: (job) => `first-step halt rate ${(job.result.filter((r) => r.steps === 1).length / job.result.length).toFixed(3)}`,
  },
  {
    name: "trap dial on HALT p=0.5 (salt 7): a HALT that does not halt is a no-op",
    setup: ({ Z, addJob }) => {
      const seed = 99;
      const T = Z.dialThreshold(0.5);
      const lanes = Array.from({ length: 1024 }, (_, l) => {
        let s = 0;
        while (s < 30 && !(Z.zilHash(seed, l, s, 7) < T)) s++;
        return { mem: mem(32, {}, 0x76),
          expect: s < 30 ? { steps: s + 1, halt: "halt-insn", state: { pc: s, r: s + 1 } } : { steps: 30, halt: "running", state: { pc: 30 } } };
      });
      return addJob({ isa: Z.z80, world: ring(32, { halting: { traps: { "halt-insn": { halt: { probability: 0.5, salt: 7 } } } } }) },
        lanes, { seed, budget: 30 });
    },
  },
  {
    name: "ablation table (uniform, coarse pages): skipped opcodes; operands run as code",
    setup: ({ Z, addJob }) => {
      const words = (bits) => {
        const w = new Uint32Array(24);
        for (const [page, key] of bits) w[page * 8 + (key >> 5)] |= 1 << (key & 31);
        return w;
      };
      const world = ring(32, { ablation: { table: "uniform" } });
      return [
        // INC A ablated: 3C 3C are 1-byte no-ops (still steps), LD A,5, HALT.
        addJob({ isa: Z.z80, world }, [{ mem: mem(32, { 0: [0x3c, 0x3c, 0x3e, 0x05, 0x76] }), expect: { steps: 4, halt: "halt-insn", state: { a: 5, r: 4 } } }],
          { ablation: words([[0, 0x3c]]) }),
        // LD A,n ablated: 3E is a 1-byte no-op, its operand 3C runs as INC A.
        addJob({ isa: Z.z80, world }, [{ mem: mem(32, { 0: [0x3e, 0x3c, 0x76] }), expect: { steps: 3, state: { a: 1, pc: 2 } } }],
          { ablation: words([[0, 0x3e]]) }),
        // LDIR ablated: ED B0 is a 2-byte no-op (R counts both M1s); BC stays 0.
        addJob({ isa: Z.z80, world }, [{ mem: mem(32, { 0: [0xed, 0xb0, 0x76] }), expect: { steps: 2, halt: "halt-insn", state: { pc: 2, r: 3, b: 0, c: 0 } } }],
          { ablation: words([[2, 0xb0]]) }),
        // Coarse layout: DD forms follow the base page, so INC HL ablated also skips INC IX (DD 23, 2 bytes).
        addJob({ isa: Z.z80, world }, [{ mem: mem(32, { 0: [0xdd, 0x23, 0x76] }), expect: { steps: 2, state: { ix: 0, pc: 2 } } }],
          { ablation: words([[0, 0x23]]) }),
        // No ablation: LD A,0x3C.
        addJob({ isa: Z.z80, world }, [{ mem: mem(32, { 0: [0x3e, 0x3c, 0x76] }), expect: { steps: 2, state: { a: 0x3c } } }]),
      ];
    },
  },
  {
    name: "ablation table, fine pages: DD 23 (INC IX) alone ablated; INC HL still runs",
    setup: ({ Z, addJob }) => {
      const w = new Uint32Array(7 * 8);
      w[3 * 8 + (0x23 >> 5)] |= 1 << (0x23 & 31); // page 3 = dd
      return addJob({ isa: Z.z80, world: ring(32, { ablation: { table: "uniform", layout: "fine" } }) },
        [{ mem: mem(32, { 0: [0xdd, 0x23, 0x23, 0x76] }), expect: { steps: 3, state: { ix: 0, h: 0, l: 1 } } }], { ablation: w });
    },
  },
  {
    name: "ablation expression (0.2 fetchHook form): prefix == 0u && op == 0x3cu",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(32, { ablation: { expr: "prefix == 0u && op == 0x3cu" } }) },
        [{ mem: mem(32, { 0: [0x3c, 0x3c, 0x3e, 0x05, 0x76] }), expect: { steps: 4, state: { a: 5 } } }]),
  },

  {
    name: "io hooks: port numbers of IN/OUT, IN r,(C), OUT (C),r, OUT (C),0, INI (BC before B--), OUTI (after)",
    // io_in(port) returns (port >> 8) ^ (port & 0xFF); io_out(port, val) stores val at 0x20 + (port & 0xF).
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(64, { hooks: {
        ioIn: "return ((port >> 8u) ^ port) & 0xffu;", ioOut: "mem_write(0x20u + (port & 0xfu), val);" } }) }, [
        // LD A,0x12; IN A,(0x34): port 0x1234 → 0x12 ^ 0x34 = 0x26.
        { label: "IN A,(n)", mem: mem(64, { 0: [0x3e, 0x12, 0xdb, 0x34, 0x76] }), expect: { steps: 3, state: { a: 0x26 } } },
        // LD BC,0x5678; IN D,(C) (ED 50): port 0x5678 → 0x56 ^ 0x78 = 0x2E.
        { label: "IN D,(C)", mem: mem(64, { 0: [0x01, 0x78, 0x56, 0xed, 0x50, 0x76] }), expect: { steps: 3, state: { d: 0x2e } } },
        // LD A,0x9A; OUT (0x05),A: port 0x9A05 → stored at 0x25.
        { label: "OUT (n),A", mem: mem(64, { 0: [0x3e, 0x9a, 0xd3, 0x05, 0x76] }), expect: { steps: 3, mem: { 0x25: 0x9a } } },
        // LD BC,0x0003; LD E,0x77; OUT (C),E (ED 59): port 0x0003 → 0x23.
        { label: "OUT (C),E", mem: mem(64, { 0: [0x01, 0x03, 0x00, 0x1e, 0x77, 0xed, 0x59, 0x76] }), expect: { steps: 4, mem: { 0x23: 0x77 } } },
        // LD BC,0x0006; OUT (C),0 (ED 71): 0 → 0x26 (pre-filled with 0xFF).
        { label: "OUT (C),0", mem: mem(64, { 0: [0x01, 0x06, 0x00, 0xed, 0x71, 0x76], 0x26: [0xff] }), expect: { steps: 3, mem: { 0x26: 0x00 } } },
        // LD HL,0x30; LD BC,0x0207; INI: port 0x0207 (before B is decremented) → 0x05 at (HL); B = 1, HL = 0x31.
        { label: "INI", mem: mem(64, { 0: [0x21, 0x30, 0x00, 0x01, 0x07, 0x02, 0xed, 0xa2, 0x76] }),
          expect: { steps: 4, mem: { 0x30: 0x05 }, state: { b: 1, c: 7, h: 0, l: 0x31 } } },
        // LD HL,0x30; LD BC,0x0204; OUTI with (HL) = 0xAB: port 0x0104 (after B is decremented) → 0x24.
        { label: "OUTI", mem: mem(64, { 0: [0x21, 0x30, 0x00, 0x01, 0x04, 0x02, 0xed, 0xa3, 0x76], 0x30: [0xab] }),
          expect: { steps: 4, mem: { 0x24: 0xab }, state: { b: 1, l: 0x31 } } },
      ]),
  },

  {
    name: "on_instruction_start ZIL_SKIP consumes the first unit only (a skipped DD is not a prefix)",
    // Raw hook: skip first units 0x3C and 0xDD. 3C 3C LD A,5 HALT → A = 5 (R counts the skipped M1s).
    // DD 04 HALT: the DD alone is skipped, so 04 runs as INC B (ablation would have consumed DD 04 together).
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(32, { outputs: maps, hooks: {
        onInstructionStart: "if (unit == 0x3cu || unit == 0xddu) { return ZIL_SKIP; }" } }) }, [
        { mem: mem(32, { 0: [0x3c, 0x3c, 0x3e, 0x05, 0x76] }), expect: { steps: 4, halt: "halt-insn", state: { a: 5, r: 4, pc: 4 }, starts: [0, 1, 2, 4] } },
        { mem: mem(32, { 0: [0xdd, 0x04, 0x76] }), expect: { steps: 3, state: { b: 1, pc: 2 }, starts: [0, 1, 2] } },
      ]),
  },

  // ---------------------------------------------------------------------------------------------------------
  // Fetch and instruction-start maps
  // ---------------------------------------------------------------------------------------------------------
  {
    name: "maps: operands are fetched but are not instruction starts; prefixes and DDCB",
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: ring(32, { outputs: maps }) }, [
        { label: "LD A,n; INC A; HALT", mem: mem(32, { 0: [0x3e, 0x42, 0x3c, 0x76] }),
          expect: { steps: 3, fetched: [0, 1, 2, 3], starts: [0, 2, 3] } },
        { label: "LD IX,nn; HALT", mem: mem(32, { 0: [0xdd, 0x21, 0x34, 0x12, 0x76] }),
          expect: { steps: 2, state: { ix: 0x1234 }, fetched: [0, 1, 2, 3, 4], starts: [0, 4] } },
        // Wasted DD (followed by FD): step 1 fetches DD and FD and backs up; step 2 starts at the FD.
        // R = 1 (one M1 for the wasted prefix) + 2 (FD 21) + 1 (HALT) = 4 (compat '0.2': 5; cases_z80.mjs).
        { label: "wasted prefix", mem: mem(32, { 0: [0xdd, 0xfd, 0x21, 0x00, 0x00, 0x76] }),
          expect: { steps: 3, state: { r: 4, pc: 5 }, fetched: [0, 1, 2, 3, 4, 5], starts: [0, 1, 5] } },
        // SET 0,(IX+5): all four bytes are instruction stream; mem[5] 0 → 1.
        { label: "DDCB", mem: mem(32, { 0: [0xdd, 0xcb, 0x05, 0xc6, 0x76] }),
          expect: { steps: 2, mem: { 5: 0x01 }, fetched: [0, 1, 2, 3, 4], starts: [0, 4] } },
      ]),
  },
  {
    name: "maps span several words: ring 79 (position 78 → word 2) and ring 100 (position 64)",
    setup: ({ Z, addJob }) => [
      addJob({ isa: Z.z80, world: ring(79, { outputs: maps }) }, [
        { mem: mem(79, { 0: [0xc3, 78, 0x00], 78: [0x3e] }), expect: { state: { a: 0xc3 }, fetched: [0, 1, 2, 78], starts: [0, 78] } },
      ], { budget: 2 }),
      addJob({ isa: Z.z80, world: ring(100, { outputs: maps }) }, [
        { mem: mem(100, { 0: [0xc3, 64, 0x00], 64: [0x76] }), expect: { steps: 2, fetched: [0, 1, 2, 64], starts: [0, 64] } },
      ]),
    ],
  },

  // ---------------------------------------------------------------------------------------------------------
  // Initial-state conventions
  // ---------------------------------------------------------------------------------------------------------
  {
    name: "init.random: randomizable fields = zil_hash(seed, lane, field index, salt ^ INIT), SP by convention",
    setup: ({ Z, addJob }) => {
      const seed = 777;
      const salt = 5;
      const fields = Z.z80.state;
      const lanes = Array.from({ length: 64 }, (_, l) => {
        const state = { sp: 0xffff, pc: 0, halted: 1, r: 1 };
        fields.forEach((f, k) => { if (f.randomizable) state[f.name] = Z.initDraw(seed, l, k, salt, f.bits); });
        return { mem: mem(32, { 0: [0x76] }), expect: { steps: 1, state } };
      });
      return addJob({ isa: Z.z80, world: ring(32, { init: { stack: { topAliases: "lastByte" }, random: { salt } } }) }, lanes, { seed });
    },
  },
  {
    name: "init.random fields ['sp'] (Algocell's randsp convention, counter-based)",
    setup: ({ Z, addJob }) => {
      const k = Z.z80.state.findIndex((f) => f.name === "sp");
      const lanes = Array.from({ length: 32 }, (_, l) => ({ mem: mem(32, { 0: [0x76] }),
        expect: { state: { sp: Z.initDraw(4, l, k, 0, 16), a: 0, ix: 0 } } }));
      return addJob({ isa: Z.z80, world: ring(32, { init: { random: { fields: ["sp"] } } }) }, lanes, { seed: 4 });
    },
  },
  {
    name: "init.set and entry: constants, PC at a position, PC at lastByte",
    setup: ({ Z, addJob }) => [
      addJob({ isa: Z.z80, world: ring(32, { init: { set: { a: 0x12, sp: 0x4000, ix: 0xbeef } } }) },
        [{ mem: mem(32, { 0: [0x76] }), expect: { state: { a: 0x12, sp: 0x4000, ix: 0xbeef } } }]),
      addJob({ isa: Z.z80, world: ring(32, { entry: { position: 5 } }) },
        [{ mem: mem(32, { 5: [0x76] }, 0x3c), expect: { steps: 1, halt: "halt-insn", state: { pc: 5, a: 0 } } }]),
      addJob({ isa: Z.z80, world: pair(16, 40, { entry: { position: "lastByte" } }) },
        [{ mem: mem(32, { 31: [0x76] }), expect: { steps: 1, state: { pc: 31 } } }]),
    ],
  },
  {
    name: "init.state perLane: the whole state record per lane (R bit 7 preserved)",
    // NOP NOP HALT at 3: PC 3 → parked at 5; R 0x80 → 0x83; everything else as loaded.
    setup: ({ Z, addJob }) =>
      addJob({ isa: Z.z80, world: pair(16, 40, { init: { state: "perLane" } }) }, [
        { state: { a: 0x55, f: 0xff, ix: 0x1234, iy: 0xfedc, sp: 0x2000, pc: 3, r: 0x80, i: 0x3f, b_: 0x9a },
          mem: mem(32, { 3: [0x00, 0x00, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", state: { a: 0x55, f: 0xff, ix: 0x1234, iy: 0xfedc, sp: 0x2000, pc: 5, r: 0x83, i: 0x3f, b_: 0x9a, halted: 1 } } },
      ]),
  },

  {
    name: "on_reset runs last: after a per-lane state load it sees and keeps the loaded state (review bug 2)",
    // Raw hook A <- A + 1. perLane state A = 0x11 → 0x12; with init.set A = 0x11 the same → 0x12. HALT at 0.
    setup: ({ Z, addJob }) => [
      addJob({ isa: Z.z80, world: ring(32, { init: { state: "perLane" }, hooks: { onReset: "cpu_a = cpu_a + 1u;" } }) },
        [{ state: { a: 0x11 }, mem: mem(32, { 0: [0x76] }), expect: { steps: 1, state: { a: 0x12 } } }]),
      addJob({ isa: Z.z80, world: ring(32, { init: { set: { a: 0x11 } }, hooks: { onReset: "cpu_a = cpu_a + 1u;" } }) },
        [{ mem: mem(32, { 0: [0x76] }), expect: { steps: 1, state: { a: 0x12 } } }]),
    ],
  },
  {
    name: "user expressions on their own lines: trailing // comments in ablation.expr and hooks.decode; ioIn '' (review nit 8)",
    setup: ({ Z, addJob }) => [
      addJob({ isa: Z.z80, world: ring(32, { ablation: { expr: "prefix == 0u && op == 0x3cu // INC A" }, hooks: { decode: "false // nothing else" } }) },
        [{ mem: mem(32, { 0: [0x3c, 0x3c, 0x3e, 0x05, 0x76] }), expect: { steps: 4, state: { a: 5 } } }]),
      // an empty ioIn enables the io hooks with the default (ports read 0): LD A,0x12; IN A,(0x34) → 0
      addJob({ isa: Z.z80, world: ring(32, { hooks: { ioIn: "" } }) },
        [{ mem: mem(32, { 0: [0x3e, 0x12, 0xdb, 0x34, 0x76] }), expect: { steps: 3, state: { a: 0 } } }]),
    ],
  },

  // ---------------------------------------------------------------------------------------------------------
  // Metamorphic and invariance checks on random programs
  // ---------------------------------------------------------------------------------------------------------
  ...[32, 64, 128].map((P) => ({
    name: `metamorphic: ring ${P} = mask ${P}, bit for bit (4096 random programs, 128 steps)`,
    setup: ({ Z, addJob }) => {
      const lanes = lanesOf(randomBytes(4096 * P, P), P);
      const w = { init: { stack: { topAliases: "lastByte" } }, outputs: { writeCounts: true, ...maps } };
      return [
        addJob({ isa: Z.z80, world: { memory: { kind: "ring", bytes: P }, ...w } }, lanes, { budget: 128 }),
        addJob({ isa: Z.z80, world: { memory: { kind: "mask", bytes: P }, ...w } }, lanes, { budget: 128 }),
      ];
    },
    check: ([a, b]) => compareJobs(a, b),
  })),
  {
    name: "hook neutrality: every v2 hook enabled but neutral = no hooks (4096 random pairs, L=20 P=44)",
    setup: ({ Z, addJob }) => {
      const lanes = lanesOf(randomBytes(4096 * 40, 7), 40);
      const base = pair(20, 44, { init: { stack: { topAliases: "lastByte" } }, outputs: { writeCounts: true } });
      const hooked = { ...base, hooks: { onFetch: "", onInstructionStart: "", trap: "", ioIn: "return 0u;", ioOut: "", decode: "false", onReset: "" } };
      const m = Z.buildMachine({ isa: Z.z80, world: hooked });
      if (m.manifest.core.hooks.length !== 4) throw new Error(`expected all 4 hooks, got ${m.manifest.core.hooks}`);
      return [addJob({ isa: Z.z80, world: base }, lanes, { budget: 128 }), addJob(m, lanes, { budget: 128 })];
    },
    check: ([a, b]) => compareJobs(a, b),
  },
  {
    name: "library mode: a host shader running 4 lanes per invocation = the kernel (privates fully reset per lane)",
    // The host owns its buffers (Algocell-style names: pair_data, params.suppress) and runs lanes back to back in
    // one invocation, so private state survives from lane to lane: zil_begin must reset memory padding, maps,
    // write counters and the core state. Compared with the kernel on 4096 random pairs with a dial and ablation.
    setup: ({ Z, addJob }) => {
      const world = pair(16, 37, { init: { stack: { topAliases: "lastByte" }, random: { fields: ["ix", "iy"] } },
        halting: { lethal: { firstUnit: 0, probability: 0.05 } }, ablation: { table: "uniform" },
        outputs: { writeCounts: true, ...maps } });
      const lib = Z.buildMachine({ isa: Z.z80, world, mode: "library", bindingNames: { memory: "pair_data", out: "lane_out", ablation: "params.suppress" } });
      const host = `struct Params { lanes: u32, lane_base: u32, budget: u32, seed: u32, suppress: array<vec4<u32>, 6> };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> pair_data: array<u32>;
@group(0) @binding(2) var<storage, read_write> lane_out: array<u32>;
${lib.wgsl}
@compute @workgroup_size(16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    for (var k = 0u; k < 4u; k++) {
        let l = gid.x * 4u + k;
        if (l >= params.lanes) { break; }
        zil_load_memory(l * ZIL_MEM_WORDS);
        zil_begin(params.lane_base + l, params.seed);
        let steps = zil_run(params.budget);
        zil_store_memory(l * ZIL_MEM_WORDS);
        zil_store_record(l * ZIL_RECORD_WORDS, steps);
    }
}
`;
      const kernel = Z.buildMachine({ isa: Z.z80, world });
      const manifest = { ...lib.manifest, mode: "kernel", entryPoint: "main", workgroupSize: 16, lanesPerInvocation: 4,
        params: { bytes: 112, fields: [
          { name: "lanes", role: "laneCount", offset: 0, words: 1 }, { name: "lane_base", role: "laneBase", offset: 4, words: 1 },
          { name: "budget", role: "budget", offset: 8, words: 1 }, { name: "seed", role: "seed", offset: 12, words: 1 },
          { name: "suppress", role: "ablation", offset: 16, words: 24 }] },
        bindings: [
          { group: 0, binding: 0, name: "params", role: "params", type: "uniform" },
          { group: 0, binding: 1, name: "pair_data", role: "memory", type: "storage", wordsPerLane: lib.manifest.memory.storageWordsPerLane },
          { group: 0, binding: 2, name: "lane_out", role: "record", type: "storage", wordsPerLane: lib.manifest.record.wordsPerLane }] };
      const lanes = lanesOf(randomBytes(4096 * 32, 21), 32);
      const ablation = new Uint32Array(24);
      for (let i = 0; i < 24; i++) ablation[i] = randomBytes(4, 100 + i).reduce((a, b, j) => a | ((b & b >> 1 & b >> 2) << (8 * j)), 0) >>> 0;
      return [
        addJob(kernel, lanes, { seed: 31, budget: 128, ablation }),
        addJob({ wgsl: host, manifest }, lanes, { seed: 31, budget: 128, ablation }),
      ];
    },
    check: ([a, b]) => compareJobs(a, b),
  },
  {
    name: "0.2 kernel (buildComputeShader, legacy manifest) = mask world with per-lane state (2048 random programs)",
    setup: ({ Z, addJob }) => {
      const n = 2048;
      const progs = lanesOf(randomBytes(n * 64, 41), 64);
      const rnd = randomBytes(n * 24, 42);
      const w16 = (i, k) => rnd[i * 24 + 2 * k] | (rnd[i * 24 + 2 * k + 1] << 8);
      const legacyLanes = progs.map((l, i) => ({ mem: l.mem, state: Object.fromEntries(Z.REG_FIELDS.map((f, k) => [f, w16(i, k)])) }));
      const split = { af: ["a", "f"], bc: ["b", "c"], de: ["d", "e"], hl: ["h", "l"], afPrime: ["a_", "f_"], bcPrime: ["b_", "c_"], dePrime: ["d_", "e_"], hlPrime: ["h_", "l_"] };
      const worldLanes = legacyLanes.map((l) => {
        const st = {};
        for (const [k, v] of Object.entries(l.state)) {
          if (split[k]) { st[split[k][0]] = v >> 8; st[split[k][1]] = v & 0xff; } else st[k] = v;
        }
        return { mem: l.mem, state: st };
      });
      return [
        addJob(Z.legacyMachine(64), legacyLanes, { budget: 100 }),
        addJob({ isa: Z.z80, compat: "0.2", world: { memory: { kind: "mask", bytes: 64 }, init: { state: "perLane" } } }, worldLanes, { budget: 100 }),
      ];
    },
    check: ([a, b]) => {
      const errs = [];
      const join = { af: ["a", "f"], bc: ["b", "c"], de: ["d", "e"], hl: ["h", "l"], afPrime: ["a_", "f_"], bcPrime: ["b_", "c_"], dePrime: ["d_", "e_"], hlPrime: ["h_", "l_"] };
      a.result.forEach((x, i) => {
        const y = b.result[i];
        if (!x.mem.every((v, k) => v === y.mem[k])) errs.push(`program ${i}: memory differs`);
        ["af", "bc", "de", "hl", "ix", "iy", "sp", "pc", "afPrime", "bcPrime", "dePrime", "hlPrime"].forEach((f, k) => {
          const want = join[f] ? (y.state[join[f][0]] << 8) | y.state[join[f][1]] : y.state[f];
          if (x.regs16[k] !== want) errs.push(`program ${i}: ${f} ${x.regs16[k]} vs ${want}`);
        });
      });
      return errs;
    },
  },
  {
    name: "library zil_run may be called again on a lane: zil_run(3) + zil_run(4) = one zil_run(7), dial included (review nit 6)",
    setup: ({ Z, addJob }) => {
      const world = pair(16, 32, { init: { stack: { topAliases: "lastByte" } }, halting: { lethal: { firstUnit: 0, probability: 0.2 } }, outputs: { writeCounts: true, ...maps } });
      const lib = Z.buildMachine({ isa: Z.z80, world, mode: "library", bindingNames: { memory: "lane_mem", out: "lane_out" } });
      const host = `struct Params { lanes: u32, lane_base: u32, budget: u32, seed: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> lane_mem: array<u32>;
@group(0) @binding(2) var<storage, read_write> lane_out: array<u32>;
${lib.wgsl}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let l = gid.x;
    if (l >= params.lanes) { return; }
    zil_load_memory(l * ZIL_MEM_WORDS);
    zil_begin(params.lane_base + l, params.seed);
    let steps = zil_run(3u) + zil_run(params.budget - 3u);
    zil_store_memory(l * ZIL_MEM_WORDS);
    zil_store_record(l * ZIL_RECORD_WORDS, steps);
}
`;
      const manifest = { ...lib.manifest, mode: "kernel", entryPoint: "main",
        params: { bytes: 16, fields: [
          { name: "lanes", role: "laneCount", offset: 0, words: 1 }, { name: "lane_base", role: "laneBase", offset: 4, words: 1 },
          { name: "budget", role: "budget", offset: 8, words: 1 }, { name: "seed", role: "seed", offset: 12, words: 1 }] },
        bindings: [
          { group: 0, binding: 0, name: "params", role: "params", type: "uniform" },
          { group: 0, binding: 1, name: "lane_mem", role: "memory", type: "storage", wordsPerLane: lib.manifest.memory.storageWordsPerLane },
          { group: 0, binding: 2, name: "lane_out", role: "record", type: "storage", wordsPerLane: lib.manifest.record.wordsPerLane }] };
      const lanes = lanesOf(randomBytes(4096 * 32, 77), 32);
      return [addJob(Z.buildMachine({ isa: Z.z80, world }), lanes, { seed: 5, budget: 7 }), addJob({ wgsl: host, manifest }, lanes, { seed: 5, budget: 7 })];
    },
    check: ([a, b]) => compareJobs(a, b),
  },
  {
    name: "chunk invariance: 5000 lanes with a dial in 1, 5 and 16 dispatches, and a lane_base slice",
    setup: ({ Z, addJob }) => {
      const lanes = lanesOf(randomBytes(5000 * 32, 11), 32);
      const spec = { isa: Z.z80, world: ring(32, { halting: { lethal: { firstUnit: 0, probability: 0.1 } }, init: { random: {} }, outputs: maps }) };
      return [
        addJob(spec, lanes, { seed: 4242, budget: 64 }),
        addJob(spec, lanes, { seed: 4242, budget: 64, chunk: 1000 }),
        addJob(spec, lanes, { seed: 4242, budget: 64, chunk: 333 }),
        addJob(spec, lanes.slice(1000, 2000), { seed: 4242, budget: 64, laneBase: 1000 }),
      ];
    },
    check: ([a, b, c, d]) => [
      ...compareJobs(a, b, "chunk 1000, lane"),
      ...compareJobs(a, c, "chunk 333, lane"),
      ...compareJobs({ result: a.result.slice(1000, 2000) }, d, "lane_base slice, lane"),
    ],
  },
];

// Each case's setup receives an addJob bound to that case.
for (const c of CASES) {
  const setup = c.setup;
  c.setup = (ctx) => setup({ ...ctx, addJob: (spec, lanes, run) => ctx.addJob(c, spec, lanes, run) });
}
