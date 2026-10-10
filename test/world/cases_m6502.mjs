// World tests of the 6502 (NMOS) core on small rings, with hand-computed expectations. Conventions as in cases.mjs:
//   - every address is formed at 16 bits first (zero-page and stack addresses at 8 bits inside their page), then
//     mapped to a ring position: pos = (addr mod 65536) mod P;
//   - positions are worked out by hand in the comments and written as literals; at(P, addr, lit) only cross-checks
//     the literal against the first-principles formula;
//   - every world gives init.stack and budget explicitly; the stack is given as firstPushAt (the cross-ISA meaning:
//     the first byte pushed lands on that position), which on the 6502 is the same S as topAliases.
//
// What is covered: zero page, stack page and the 0xFFFE/0xFFFF vector aliasing into rings of 32, 33 and 64 bytes;
// the NMOS address quirks a soup can reach (zp,X wrap, (zp),Y and (zp,X) pointer wrap, JMP ($xxFF)); the order of
// bus accesses that a small ring makes visible (BRK reads its vector after its pushes, JSR fetches its high operand
// byte after its pushes); JAM; read-modify-write instructions counting two writes; budgets in steps and in fetched
// bytes; a self-copier under the init conventions a soup will use; ring = mask and hook neutrality on random code.

import { m6502 } from "../../dist/cores/m6502/index.js";

const at = (P, addr, lit) => {
  if ((addr & 0xffff) % P !== lit) throw new Error(`hand-computed position of 0x${addr.toString(16)} on ring ${P} = ${lit} is wrong`);
  return lit;
};
/** Lane memory of n bytes: `place` maps a position to the bytes starting there. */
const mem = (n, place = {}, fill = 0) => {
  const m = new Uint8Array(n).fill(fill);
  for (const [pos, bytes] of Object.entries(place)) m.set(bytes, +pos);
  return m;
};
const steps = (value) => ({ unit: "steps", value });
const ring = (P, extra = {}) => ({
  memory: { kind: "ring", bytes: P },
  init: { stack: { firstPushAt: "lastByte" }, ...(extra.init ?? {}) },
  budget: steps(64),
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "init")),
});
const pair = (L, P, extra = {}) => ({
  ...ring(P, extra),
  memory: { kind: "segments", segments: [{ bytes: L, name: "A" }, { bytes: L, name: "B" }], ring: P },
});
const maps = { fetchMap: true, startMap: true };
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/**
 * The draft pre-registration's stack rule: the S for which the first push lands on ring position t,
 * S = 0xFF − ((0x1FF − t) mod P). The world's init.stack.firstPushAt must realise the same S.
 */
const firstPushS = (P, t) => 0xff - ((0x1ff - t) % P);

/** Deterministic bytes (SplitMix32-style), as in cases.mjs. */
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
    if (!x.raw.every((v, k) => v === y.raw[k])) errs.push(`${what} ${i}: record differs`);
  });
  return errs;
}

// The stack-copy loop of ISA_RESEARCH §4.2: LDA zp,X; PHA; DEX; BVC loop. With X = 0 and the first push on the
// last byte of B it copies A[L-1], A[L-2], ..., A[0] onto B[L-1], ..., B[0]: four steps and six fetched bytes per
// byte copied. The zero-page operand is L - 1.
const copier = (L) => [0xb5, L - 1, 0x48, 0xca, 0x50, 0xfa];

const JAM = [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2];

const CASES = [
  // ---------------------------------------------------------------------------------------------------------
  // Zero page, stack page and vectors on rings of 32, 33 and 64 bytes
  // ---------------------------------------------------------------------------------------------------------
  ...[[32, 30, 23], [33, 26, 18], [64, 30, 55]].map(([P, p9e, pb7]) => ({
    name: `6502 zero page on ring ${P}: $9E → ${p9e}, $B7 → ${pb7}; STA $FF,X with X = $16 wraps to $15 (position 21)`,
    // LDX #$16; LDA #$5A; STA $FF,X (zero page: (0xFF + 0x16) & 0xFF = 0x15 → 21, never 0x115); STA $9E; LDY $B7; JAM.
    // On ring 33 the unwrapped 0x115 would be position 277 mod 33 = 13, which must stay 0.
    setup: ({ addJob }) => {
      const a9e = at(P, 0x9e, p9e);
      const ab7 = at(P, 0xb7, pb7);
      const expectMem = { 21: 0x5a, [a9e]: 0x5a, [ab7]: 0x77, ...(P === 33 ? { [at(P, 0x115, 13)]: 0 } : {}) };
      return addJob({ isa: m6502, world: ring(P, { outputs: { writeCounts: true } }) }, [
        { mem: mem(P, { 0: [0xa2, 0x16, 0xa9, 0x5a, 0x95, 0xff, 0x85, 0x9e, 0xa4, 0xb7, 0x02], [ab7]: [0x77] }),
          expect: { steps: 6, halt: "trap", trap: "illegal", state: { x: 0x16, a: 0x5a, y: 0x77, pc: 10, halted: 3, trap: 1 }, mem: expectMem, writes: [2] } },
      ]);
    },
  })),
  ...[[32, 0xff], [33, 0xee], [64, 0xff]].map(([P, s0]) => ({
    name: `6502 stack convention on ring ${P}: S0 = 0x${s0.toString(16)} puts the first push on the last byte (draft rule)`,
    // firstPushAt 'lastByte': the first push lands at P - 1. LDA #$42; PHA; JAM.
    setup: ({ addJob }) => {
      if (firstPushS(P, P - 1) !== s0) throw new Error(`draft rule gives S = ${firstPushS(P, P - 1)} for P = ${P}`);
      at(P, 0x100 | s0, P - 1);
      return addJob({ isa: m6502, world: ring(P) }, [
        { mem: mem(P, { 0: [0xa9, 0x42, 0x48, 0x02] }), expect: { steps: 3, halt: "trap", state: { s: s0 - 1, pc: 3 }, mem: { [P - 1]: 0x42 } } },
      ]);
    },
  })),
  ...[[32, 0, 31, 1], [33, 25, 16, 26], [64, 0, 63, 1]].map(([P, p100, p1ff, p101]) => ({
    name: `6502 stack page on ring ${P}: S wraps inside page 1 (0x100 → ${p100}, 0x1FF → ${p1ff})`,
    // Code at 8 (entry 8), so positions 0..7 are data.
    // Lane 0: LDX #0; TXS; LDA #$C3; PHA (0x0100); PHA (S wrapped to 0xFF: 0x01FF, not 0x00FF); JAM. On ring 33 the
    //         unwrapped 0x00FF would be position 255 mod 33 = 24, which must stay 0.
    // Lane 1: LDX #$FF; TXS; PLA (S → 0x00: reads 0x0100); PLA (reads 0x0101); JAM. A = the second marker.
    setup: ({ addJob }) => {
      at(P, 0x100, p100);
      at(P, 0x1ff, p1ff);
      at(P, 0x101, p101);
      const w = ring(P, { entry: { position: 8 }, outputs: { writeCounts: true } });
      return addJob({ isa: m6502, world: w }, [
        { mem: mem(P, { 8: [0xa2, 0x00, 0x9a, 0xa9, 0xc3, 0x48, 0x48, 0x02] }),
          expect: { steps: 6, halt: "trap", state: { s: 0xfe, pc: 15 }, writes: [2],
            mem: { [p100]: 0xc3, [p1ff]: 0xc3, ...(P === 33 ? { [at(P, 0xff, 24)]: 0 } : {}) } } },
        { mem: mem(P, { 8: [0xa2, 0xff, 0x9a, 0x68, 0x68, 0x02], [p100]: [0x9d], [p101]: [0x4e] }),
          expect: { steps: 5, halt: "trap", state: { s: 0x01, a: 0x4e, pc: 13 }, writes: [0] } },
      ]);
    },
  })),
  ...[[32, 30, 31, 0xf4], [33, 29, 30, 0xe2], [64, 62, 63, 0xd4]].map(([P, vlo, vhi, s0]) => ({
    name: `6502 BRK on ring ${P}: pushes PC+2 and P|0x30, vectors through 0xFFFE/0xFFFF = positions ${vlo}/${vhi}`,
    // Stack top at 20 (S0 = 0x${s0.toString(16)}): PCH 0x00 → 20, PCL 0x02 → 19, P | 0x30 = 0x30 → 18. I set (P = 0x24).
    // The vector 0x0010 sends PC to position 16 (JAM). The signature byte is fetched (an instruction-stream byte);
    // the vector bytes are data reads, not fetches.
    setup: ({ addJob }) => {
      at(P, 0xfffe, vlo);
      at(P, 0xffff, vhi);
      at(P, 0x100 | s0, 20);
      const w = ring(P, { init: { stack: { firstPushAt: 20 }, set: { p: 0x20 } }, outputs: { ...maps, writeCounts: true } });
      return addJob({ isa: m6502, world: w }, [
        { mem: mem(P, { 0: [0x00, 0xea], 16: [0x02], [vlo]: [0x10], [vhi]: [0x00] }),
          expect: { steps: 2, halt: "trap", state: { pc: 0x10, s: s0 - 3, p: 0x24 }, mem: { 20: 0x00, 19: 0x02, 18: 0x30 },
            writes: [3], fetched: [0, 1, 16], starts: [0, 16] } },
      ]);
    },
  })),
  {
    name: "6502 BRK with the stack at the last byte: the vector is read after the pushes (rings 32, 64: PC = 2; 33: 0x3005)",
    // Ring 32 (S0 = 0xFF): PCH 0x00 → 31, PCL 0x02 → 30, P 0x30 → 29. The vector positions are 30 and 31, so BRK
    // jumps to 0x0002 (JAM there), not to the decoy 0x0010 that was there before the pushes (NOP, JAM at 16, 17).
    // Ring 64: the same at 63, 62, 61 / vector 62, 63. Ring 33 (S0 = 0xEE): PCH → 32, PCL → 31, P 0x30 → 30;
    // vector low byte at 29 (0x05, untouched), high byte at 30 = the pushed P → PC = 0x3005 → position 17 (JAM);
    // the decoy (before the pushes: 0x0005 → NOP, JAM at 5, 6) would stop at PC 6.
    setup: ({ addJob }) => [
      ...[[32, 30, 31], [64, 62, 63]].map(([P, lo, hi]) =>
        addJob({ isa: m6502, world: ring(P, { init: { set: { p: 0x20 } } }) }, [
          { mem: mem(P, { 0: [0x00, 0xea, 0x02], 16: [0xea, 0x02], [at(P, 0xfffe, lo)]: [0x10], [at(P, 0xffff, hi)]: [0x00] }),
            expect: { steps: 2, halt: "trap", state: { pc: 2, s: 0xfc }, mem: { [P - 1]: 0x00, [P - 2]: 0x02, [P - 3]: 0x30 } } },
        ])),
      addJob({ isa: m6502, world: ring(33, { init: { set: { p: 0x20 } } }) }, [
        { mem: mem(33, { 0: [0x00, 0xea], 5: [0xea, 0x02], [at(33, 0x3005, 17)]: [0x02], [at(33, 0xfffe, 29)]: [0x05], [at(33, 0xffff, 30)]: [0x00] }),
          expect: { steps: 2, halt: "trap", state: { pc: 0x3005, s: 0xeb }, mem: { 32: 0x00, 31: 0x02, 30: 0x30 } } },
      ]),
    ],
  },
  {
    name: "6502 JSR on ring 33 fetches its high operand byte after its pushes (stack top on that byte: target 0x0010)",
    // JSR $1210 at 0 with S0 = 0xF1 (0x1F1 = 497 ≡ 2): lo = 0x10 is fetched; PCH 0x00 is pushed onto position 2 (the
    // high operand byte) and PCL 0x02 onto 1; the high byte is then fetched from position 2: 0x00. Target 0x0010 →
    // JAM at 16. Read before the pushes, the target would be 0x1210 → position 4 (NOP, JAM at 5).
    setup: ({ addJob }) => {
      at(33, 0x1f1, 2);
      at(33, 0x1210, 4);
      return addJob({ isa: m6502, world: ring(33, { init: { stack: { firstPushAt: 2 } }, outputs: maps }) }, [
        { mem: mem(33, { 0: [0x20, 0x10, 0x12], 4: [0xea, 0x02], 16: [0x02] }),
          expect: { steps: 2, halt: "trap", state: { pc: 0x10, s: 0xef }, mem: { 1: 0x02, 2: 0x00 }, fetched: [0, 1, 2, 16], starts: [0, 16] } },
      ]);
    },
  },
  {
    name: "6502 JMP ($01FF) on ring 33 takes its high byte from $0100 (NMOS page wrap), not $0200",
    // Low byte from 0x01FF → 16 (0x14); high byte from 0x0100 → 25 (0x00) → PC 0x0014 → JAM at 20. The 65C02 would
    // read 0x0200 → 17 (0x01): PC 0x0114 → position 12 (NOP, JAM at 13).
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: ring(33) }, [
        { mem: mem(33, { 0: [0x6c, 0xff, 0x01], [at(33, 0x1ff, 16)]: [0x14, 0x01], [at(33, 0x100, 25)]: [0x00],
          [at(33, 0x14, 20)]: [0x02], [at(33, 0x114, 12)]: [0xea, 0x02] }),
          expect: { steps: 2, halt: "trap", state: { pc: 0x14 } } },
      ]),
  },
  {
    name: "6502 indirect pointers on ring 33 wrap inside page 0: LDA ($FF),Y and LDA ($FE,X) read their high byte at $00",
    // Code at 8. Pointer low byte at 0xFF → 24 (0x03), high byte at 0x00 → 0 (0x00): address 0x0003 → marker 0x11.
    // Read from 0x0100 → 25 (0x01) instead, the address would be 0x0103 → 28 (marker 0x22).
    // Lane 0: LDA ($FF),Y (Y = 0); JAM.  Lane 1: LDX #1; LDA ($FE,X) (pointer at (0xFE + 1) & 0xFF = 0xFF); JAM.
    setup: ({ addJob }) => {
      const data = { 0: [0x00], 3: [0x11], [at(33, 0xff, 24)]: [0x03, 0x01], [at(33, 0x103, 28)]: [0x22] };
      return addJob({ isa: m6502, world: ring(33, { entry: { position: 8 } }) }, [
        { mem: mem(33, { ...data, 8: [0xb1, 0xff, 0x02] }), expect: { steps: 2, halt: "trap", state: { a: 0x11, pc: 10 } } },
        { mem: mem(33, { ...data, 8: [0xa2, 0x01, 0xa1, 0xfe, 0x02] }), expect: { steps: 3, halt: "trap", state: { a: 0x11, pc: 12 } } },
      ]);
    },
  },

  // ---------------------------------------------------------------------------------------------------------
  // JAM, read-modify-write, budgets
  // ---------------------------------------------------------------------------------------------------------
  {
    name: "6502 JAM: each of the 12 opcodes halts as-chip (trap 'illegal', PC parked on it); policy ignore = 1-byte no-op",
    setup: ({ addJob }) => [
      addJob({ isa: m6502, world: ring(32, { outputs: maps }) },
        JAM.map((op) => ({ label: `JAM ${op.toString(16)}`, mem: mem(32, { 0: [0xea, op, 0xa9, 0x07] }),
          expect: { steps: 2, halt: "trap", trap: "illegal", state: { pc: 1, a: 0, halted: 3, trap: 1 }, fetched: [0, 1], starts: [0, 1] } }))),
      addJob({ isa: m6502, world: ring(32, { halting: { traps: { illegal: "ignore" } }, budget: steps(3) }) },
        JAM.map((op) => ({ label: `JAM ${op.toString(16)}`, mem: mem(32, { 0: [op, 0xa9, 0x07, op] }),
          expect: { steps: 3, halt: "running", trap: 0, state: { a: 7, pc: 4, halted: 0, trap: 0 } } }))),
    ],
  },
  {
    name: "6502 read-modify-write counts two writes (old value, then new): INC zp, ASL abs, DCP zp on a pair [16,16]",
    // INC $14 (position 20: 0x7F → 0x80), ASL $0015 (21: 0x81 → 0x02, C = 1), DCP $16 (22: 0x01 → 0x00; CMP with
    // A = 0: Z = C = 1), JAM. Six writes, all in B.
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: pair(16, 32, { outputs: { writeCounts: true } }) }, [
        { mem: mem(32, { 0: [0xe6, 0x14, 0x0e, 0x15, 0x00, 0xc7, 0x16, 0x02], 20: [0x7f, 0x81, 0x01] }),
          expect: { steps: 4, halt: "trap", state: { pc: 7, p: 0x23 }, mem: { 20: 0x80, 21: 0x02, 22: 0x00 }, writes: [0, 6] } },
      ]),
  },
  {
    name: "6502 budgets: steps, and fetched bytes (the copy loop fetches 2, 1, 1, 2 bytes per step)",
    // fetchBytes: a step starts while fewer than `budget` bytes have been fetched. Cumulative bytes after steps 1..4:
    // 2, 3, 4, 6, then +6 per loop: budgets 0,1,2,3,4,5,6,7,60,61 → 0,1,1,2,3,4,4,5,40,41 steps.
    // steps: budget 10 → LDA PHA DEX BVC LDA PHA DEX BVC LDA PHA: PC 3, X = 0xFE, S = 0xFF − 3.
    setup: ({ addJob }) => {
      const prog = mem(32, { 0: copier(16) });
      return [
        addJob({ isa: m6502, world: pair(16, 32, { budget: { unit: "fetchBytes", value: "perLane" } }) },
          [[0, 0], [1, 1], [2, 1], [3, 2], [4, 3], [5, 4], [6, 4], [7, 5], [60, 40], [61, 41]].map(([b, s]) => ({
            label: `budget ${b}`, budget: b, mem: prog, expect: { steps: s, halt: "running" } }))),
        addJob({ isa: m6502, world: pair(16, 32, { budget: steps(10) }) },
          [{ mem: prog, expect: { steps: 10, halt: "running", state: { pc: 3, x: 0xfe, s: 0xfc } } }]),
      ];
    },
  },

  // ---------------------------------------------------------------------------------------------------------
  // A self-copier under the soup's init conventions
  // ---------------------------------------------------------------------------------------------------------
  ...[[16, 32, 0xff], [20, 40, 0xdf], [16, 37, 0xdb]].map(([L, P, s0]) => ({
    name: `6502 self-copier, pair [${L},${L}] on ring ${P}: 4L steps copy A onto B exactly (S0 = 0x${s0.toString(16)}, first push on B's last byte)`,
    // Init as in the draft pre-registration: A = X = Y = 0, P = 0x20, PC = 0, the first push on the last byte of B
    // (position 2L − 1; on ring 37 the bytes 32..36 are padding). After 4L steps B equals A, every write is in B,
    // and the loop never fetched a byte of B (a closed copier).
    setup: ({ addJob }) => {
      const t = 2 * L - 1;
      if (firstPushS(P, t) !== s0) throw new Error(`draft rule gives S = ${firstPushS(P, t)}`);
      at(P, 0x100 | s0, t);
      const body = Uint8Array.from({ length: L }, (_, i) => (i < 6 ? copier(L)[i] : (0x11 * i + 3) & 0xff));
      const lane = mem(2 * L, { 0: Array.from(body) }, 0xee);
      const want = Object.fromEntries(Array.from(body, (v, i) => [L + i, v]));
      const w = pair(L, P, { init: { set: { a: 0, x: 0, y: 0, p: 0x20 } }, entry: { position: 0 }, budget: steps(4 * L),
        outputs: { writeCounts: true, fetchMap: true } });
      return addJob({ isa: m6502, world: w }, [
        { mem: lane, expect: { steps: 4 * L, halt: "running", state: { pc: 0, s: s0 - L, x: (256 - L) & 0xff },
          mem: want, writes: P > 2 * L ? [0, L, 0] : [0, L], fetched: range(0, 6) } },
      ]);
    },
  })),
  {
    name: "6502 self-copier at the soup budget (128 steps, L = 16): B = A after 64 steps; then the copy runs back over A unchanged",
    // Steps 65..128 read B (now A's copy) from 0xFF down to 0xF0 (positions 31..16) and push onto 0x1EF..0x1E0
    // (positions 15..0): A is rewritten with its own bytes, its code included. 16 writes in A, 16 in B; A = the last
    // byte read, B[0] = 0xB5.
    setup: ({ addJob }) => {
      const body = Uint8Array.from({ length: 16 }, (_, i) => (i < 6 ? copier(16)[i] : (0x11 * i + 3) & 0xff));
      const w = pair(16, 32, { init: { set: { a: 0, x: 0, y: 0, p: 0x20 } }, entry: { position: 0 }, budget: steps(128),
        outputs: { writeCounts: true } });
      return addJob({ isa: m6502, world: w }, [
        { mem: mem(32, { 0: Array.from(body) }, 0xee),
          expect: { steps: 128, halt: "running", state: { pc: 0, s: 0xdf, x: 0xe0, a: 0xb5 }, memAll: [...body, ...body], writes: [16, 16] } },
      ]);
    },
  },

  // ---------------------------------------------------------------------------------------------------------
  // Random code: ring = mask, hook neutrality
  // ---------------------------------------------------------------------------------------------------------
  ...[32, 64].map((P) => ({
    name: `6502 metamorphic: ring ${P} = mask ${P}, bit for bit (4096 random programs, 128 steps)`,
    setup: ({ addJob }) => {
      const lanes = lanesOf(randomBytes(4096 * P, 6502 + P), P);
      const w = { init: { stack: { firstPushAt: "lastByte" } }, budget: steps(128), outputs: { writeCounts: true, ...maps } };
      return [
        addJob({ isa: m6502, world: { memory: { kind: "ring", bytes: P }, ...w } }, lanes),
        addJob({ isa: m6502, world: { memory: { kind: "mask", bytes: P }, ...w } }, lanes),
      ];
    },
    check: ([a, b]) => compareJobs(a, b),
  })),
  {
    name: "6502 hook neutrality: fetch, instruction-start, trap and decode hooks enabled but neutral = no hooks (4096 random pairs, L=20 P=44)",
    setup: ({ Z, addJob }) => {
      const lanes = lanesOf(randomBytes(4096 * 40, 65), 40);
      const base = pair(20, 44, { budget: steps(128), outputs: { writeCounts: true } });
      const hooked = { ...base, hooks: { onFetch: "", onInstructionStart: "", trap: "", decode: "false", onReset: "" } };
      const m = Z.buildMachine({ isa: m6502, world: hooked });
      if (m.manifest.core.hooks.length !== 3) throw new Error(`expected 3 hooks, got ${m.manifest.core.hooks}`);
      return [addJob({ isa: m6502, world: base }, lanes), addJob(m, lanes)];
    },
    check: ([a, b]) => compareJobs(a, b),
    note: ([a]) => `${a.result.filter((r) => r.halt === "trap").length} of 4096 lanes ended on a JAM`,
  },
];

// Each case's setup receives an addJob bound to that case.
for (const c of CASES) {
  const setup = c.setup;
  c.setup = (ctx) => setup({ ...ctx, addJob: (spec, lanes, run) => ctx.addJob(c, spec, lanes, run) });
}
export const M6502_CASES = CASES;
