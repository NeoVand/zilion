// Contract tests on the two SKELETON cores (6502, BFF): the same world code runs a page-stack CPU and a
// ring-native tape machine. Expectations are hand-computed; the skeletons implement only the opcodes used here.

import { m6502 } from "../../dist/cores/m6502/index.js";
import { bff } from "../../dist/cores/bff/index.js";
import { fakeCore } from "./fake_core.mjs";

const mem = (n, place = {}, fill = 0) => {
  const m = new Uint8Array(n).fill(fill);
  for (const [pos, bytes] of Object.entries(place)) m.set(bytes, +pos);
  return m;
};
// Budgets and stacks are explicit (no silent defaults): the helpers state the budget; 6502 worlds state their stack,
// BFF worlds have none (giving one is an error).
const steps = (n) => ({ unit: "steps", value: n });
const FIRST = { firstPushAt: "lastByte" };
const ring = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, budget: steps(100), ...extra });
const pair = (L, P, extra = {}) => ({ memory: { kind: "segments", segments: [{ bytes: L }, { bytes: L }], ring: P }, budget: steps(100), ...extra });
const maps = { fetchMap: true, startMap: true };
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

const CASES = [
  {
    name: "6502 skeleton: LDA #, STA abs, NOP, JAM (trap 'illegal' halts as-chip, PC on the JAM)",
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: ring(64, { init: { stack: FIRST }, outputs: { ...maps, writeCounts: true } }) }, [
        { mem: mem(64, { 0: [0xa9, 0x42, 0x8d, 0x20, 0x00, 0xea, 0x02] }),
          expect: { steps: 4, halt: "trap", trap: "illegal", state: { a: 0x42, pc: 6, p: 0x24, halted: 3, trap: 1 }, mem: { 32: 0x42 }, writes: [1],
            fetched: [0, 1, 2, 3, 4, 5, 6], starts: [0, 2, 5, 6] } },
        // an opcode the skeleton does not implement (ADC #) traps as 'unimplemented'
        { mem: mem(64, { 0: [0x69, 0x01] }), expect: { steps: 1, halt: "trap", trap: "unimplemented", state: { pc: 0, trap: 8 } } },
      ]),
  },
  {
    name: "6502 skeleton: page-1 stack convention on ring 40 (S0 = 0xDF: 0x1DF mod 40 = 39); PHA lands on 39",
    // 0x100 + S ≡ 39 (mod 40) with S ≤ 0xFF: 479 = 0x1DF → S = 0xDF (519 would need S = 263).
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: ring(40, { init: { stack: { topAliases: "lastByte" } } }) }, [
        { mem: mem(40, { 0: [0x02] }), expect: { steps: 1, state: { s: 0xdf } } },
        { mem: mem(40, { 0: [0xa9, 0x42, 0x48, 0x02] }), expect: { steps: 3, state: { s: 0xde, pc: 3 }, mem: { 39: 0x42 } } },
      ]),
  },
  {
    name: "6502 skeleton: BRK pushes PC+2 and P|0x30 on page 1, vectors through 0xFFFE/0xFFFF = positions 30/31",
    // Ring 32, stack top at 20: S0 = 0xF4 (0x1F4 = 500 ≡ 20). BRK: PCH 0x00 → 20, PCL 0x02 → 19, P|0x30 = 0x34 → 18;
    // PC = mem[30] | mem[31] << 8 = 0x0010; JAM there. The vector bytes are reads, not instruction fetches.
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: ring(32, { init: { stack: { topAliases: 20 } }, outputs: maps }) }, [
        { mem: mem(32, { 0: [0x00, 0xea], 16: [0x02], 20: [0xee], 30: [0x10, 0x00] }),
          expect: { steps: 2, halt: "trap", state: { pc: 0x10, s: 0xf1, p: 0x24 }, mem: { 20: 0x00, 19: 0x02, 18: 0x34 },
            fetched: [0, 1, 16], starts: [0, 16] } },
      ]),
  },
  {
    name: "6502 skeleton: world policies — JAM ignored, lethal first unit 0xEA, ablation of LDA # (on_decode)",
    setup: ({ addJob }) => {
      const abl = new Uint32Array(8);
      abl[0xa9 >> 5] |= 1 << (0xa9 & 31);
      return [
        addJob({ isa: m6502, world: ring(32, { init: { stack: FIRST }, halting: { traps: { illegal: "ignore" } } }) },
          [{ mem: mem(32, { 0: [0x02, 0xa9, 0x07, 0x02] }), expect: { steps: 3, halt: "running", trap: 0, state: { a: 7, pc: 4, trap: 0 } } }], { budget: 3 }),
        // a trap field set by hand on a lane that never halts on a trap is not reported
        addJob({ isa: m6502, world: ring(32, { init: { stack: FIRST, set: { trap: 4 } } }) },
          [{ mem: mem(32, {}, 0xea), expect: { steps: 5, halt: "running", trap: 0, state: { trap: 4 } } }], { budget: 5 }),
        addJob({ isa: m6502, world: ring(32, { init: { stack: FIRST }, halting: { lethal: { firstUnit: 0xea } } }) },
          [{ mem: mem(32, { 0: [0xa9, 0x01, 0xea] }), expect: { steps: 2, halt: "host", trap: 0, state: { a: 1, pc: 2 } } }]),
        addJob({ isa: m6502, world: ring(32, { init: { stack: FIRST }, ablation: { table: "uniform" } }) },
          [{ mem: mem(32, { 0: [0xa9, 0xe8, 0x02] }), expect: { steps: 3, halt: "trap", state: { a: 0, x: 1 } } }], { ablation: abl }),
      ];
    },
  },
  {
    name: "BFF skeleton: heads wrap modulo the ring ('{' from 0 → 31); '.' copies into B; leaving the tape halts",
    // { . : h1 = 31, tape[31] = tape[h0 = 0] = '{'. Bytes 2..30 are no-ops; at 31 the copied '{' moves h1 to 30.
    // ip reaches 32 = P → trap 'bounds' (as-chip halt) after 32 steps.
    setup: ({ addJob }) =>
      addJob({ isa: bff, world: pair(16, 32, { outputs: { ...maps, writeCounts: true } }) }, [
        { mem: mem(32, { 0: ascii("{.") }),
          expect: { steps: 32, halt: "trap", trap: "bounds", state: { ip: 32, h0: 0, h1: 30, trap: 4 }, mem: { 31: 0x7b }, writes: [0, 1],
            fetched: Array.from({ length: 32 }, (_, i) => i) } },
        // < , : h0 = 31, tape[31] = tape[h1 = 0] = '<'; at 31 that '<' moves h0 to 30.
        { mem: mem(32, { 0: ascii("<,") }), expect: { steps: 32, state: { h0: 30 }, mem: { 31: 0x3c }, writes: [0, 1] } },
        // + + - : tape[0] 0x2B → 0x2C → 0x2D → 0x2C.
        { mem: mem(32, { 0: ascii("++-") }), expect: { steps: 32, mem: { 0: 0x2c }, writes: [3, 0] } },
        // a bracket is a stub in the skeleton: trap 'unimplemented', ip stays on it
        { mem: mem(32, { 0: ascii("[") }), expect: { steps: 1, halt: "trap", trap: "unimplemented", state: { ip: 0, trap: 8 } } },
      ]),
  },
  {
    name: "BFF skeleton: bounds policy 'ignore' wraps the ip (Algocell's ip_wrap); ablation by op id",
    setup: ({ addJob }) => [
      // > then 31 no-ops; ip wraps after 32 steps, steps 33..40 run positions 0..7: h0 = 2, ip = 8.
      addJob({ isa: bff, world: pair(16, 32, { halting: { traps: { bounds: "ignore" } } }) },
        [{ mem: mem(32, { 0: ascii(">") }), expect: { steps: 40, halt: "running", trap: 0, state: { h0: 2, ip: 8, trap: 0 } } }], { budget: 40 }),
      // op 5 ('+') ablated: nothing is written.
      addJob({ isa: bff, world: pair(16, 32, { ablation: { table: "uniform" }, outputs: { writeCounts: true } }) },
        [{ mem: mem(32, { 0: ascii("++") }), expect: { steps: 32, writes: [0, 0], mem: { 0: 0x2b } } }], { ablation: Uint32Array.from([1 << 5]) }),
    ],
  },
  {
    name: "one world, three ISAs: pair [16,16] on ring 33, fetch map, writes per segment — Z80, 6502, BFF; trap causes told apart",
    // Each program writes one byte at position 20 (segment B) and stops.
    // Z80: LD A,7; LD (0x14),A; HALT.  6502: LDA #7; STA $0014; JAM.
    // BFF: thirteen '{' move h1 from 0 to 33 - 13 = 20; '.' writes tape[0] = '{' there; the ip then runs to 33 = P
    // (the copied '{' at 20 moves h1 to 19 on the way) and leaves the tape.
    // The stack machines add the shared stack convention (first push at the last byte); BFF has no stack, so its
    // world omits it (decisions 1 and 3). The record tells the three endings apart: halt-insn, illegal, bounds.
    setup: ({ Z, addJob }) => {
      const world = pair(16, 33, { outputs: { fetchMap: true, writeCounts: true } });
      const stacked = { ...world, init: { stack: FIRST } };
      return [
        addJob({ isa: Z.z80, world: stacked }, [{ mem: mem(32, { 0: [0x3e, 0x07, 0x32, 0x14, 0x00, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", trap: "halt-insn", mem: { 20: 7 }, writes: [0, 1, 0], fetched: [0, 1, 2, 3, 4, 5] } }], { budget: 40 }),
        addJob({ isa: m6502, world: stacked }, [{ mem: mem(32, { 0: [0xa9, 0x07, 0x8d, 0x14, 0x00, 0x02] }),
          expect: { steps: 3, halt: "trap", trap: "illegal", mem: { 20: 7 }, writes: [0, 1, 0], fetched: [0, 1, 2, 3, 4, 5] } }], { budget: 40 }),
        addJob({ isa: bff, world }, [{ mem: mem(32, { 0: ascii("{".repeat(13) + ".") }),
          expect: { steps: 33, halt: "trap", trap: "bounds", state: { h1: 19 }, mem: { 20: 0x7b }, writes: [0, 1, 0], fetched: Array.from({ length: 33 }, (_, i) => i) } }], { budget: 40 }),
      ];
    },
  },
  ...[
    // [label, world, stack position, t, Z80 SP0, 6502 S0] — worked out by hand in test/unit.mjs (firstPushAt)
    ["ring 32", ring(32), "lastByte", 31, 0x0000, 0xff],
    ["ring 33 (odd)", ring(33), "lastByte", 32, 0xffe1, 0xee],
    ["pair [16,16] on ring 37 (padding 32..36)", pair(16, 37), "lastByte", 31, 0xfff2, 0xdb],
    // 65535 mod 33 = 30: the Z80's SP0 is 0x0000 and its first push wraps to 0xFFFF. 6502: 0x1EC = 492 = 14·33 + 30.
    ["ring 33, t = 30 (the Z80's push wraps from SP = 0 to 0xFFFF)", ring(33), 30, 30, 0x0000, 0xec],
  ].map(([label, world, at, t, sp0, s0]) => ({
    name: `init.stack.firstPushAt ${JSON.stringify(at)}, ${label}: the first byte pushed lands on position ${t} on the Z80 and the 6502`,
    setup: ({ Z, addJob }) => {
      const w = { ...world, init: { stack: { firstPushAt: at } } };
      const n = Z.buildMachine({ isa: Z.z80, world: w }).manifest.memory.hostBytesPerLane;
      return [
        // Z80: LD BC,0x1234; PUSH BC; HALT. PUSH writes B (0x12) first, at SP0 - 1, then C (0x34) below it.
        addJob({ isa: Z.z80, world: w }, [{ mem: mem(n, { 0: [0x01, 0x34, 0x12, 0xc5, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", state: { sp: (sp0 - 2) & 0xffff }, mem: { [t]: 0x12, [t - 1]: 0x34 } } }]),
        // 6502: LDA #$12; PHA; LDA #$34; PHA; JAM: 0x12 at 0x0100|S0, then 0x34 below it.
        addJob({ isa: m6502, world: w }, [{ mem: mem(n, { 0: [0xa9, 0x12, 0x48, 0xa9, 0x34, 0x48, 0x02] }),
          expect: { steps: 5, halt: "trap", trap: "illegal", state: { s: (s0 - 2) & 0xff }, mem: { [t]: 0x12, [t - 1]: 0x34 } } }]),
      ];
    },
  })),
  {
    name: "resumable runs, BFF skeleton: k = 1, 2, 7 dispatches = one dispatch of 200 steps, with the bounds dial (p = 0.3)",
    // Each pass over the 32-byte pair ends with the instruction pointer leaving the tape: trap 'bounds', which halts
    // with p = 0.3 and otherwise wraps (Algocell's ip_wrap). Random tapes stop early on a bracket (trap
    // 'unimplemented' in the skeleton); tapes of no-op bytes draw the dial at steps 31, 63, 95, …
    setup: ({ addJob }) => {
      const world = pair(16, 32, { budget: steps(200), halting: { traps: { bounds: { halt: { probability: 0.3, salt: 11 } } } },
        outputs: { writeCounts: true, fetchMap: true, startMap: true } });
      const tapes = Array.from({ length: 3072 }, (_, i) => {
        const m = new Uint8Array(32);
        let s = (i * 2654435761) >>> 0;
        for (let k = 0; k < 32; k++) {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          const c = "<>{}+-.,"[(s >>> 24) & 7];
          m[k] = i % 3 === 0 ? 0x20 : (s >>> 20) & 1 ? c.charCodeAt(0) : 0x20; // a third are all no-ops
        }
        return { mem: m };
      });
      return [
        addJob({ isa: bff, world }, tapes, { seed: 5, budget: 200 }),
        addJob({ isa: bff, world }, tapes, { seed: 5, stepChunks: [200] }),
        addJob({ isa: bff, world }, tapes, { seed: 5, stepChunks: [100, 100] }),
        addJob({ isa: bff, world }, tapes, { seed: 5, stepChunks: [3, 29, 31, 33, 50, 40, 14] }),
        addJob({ isa: bff, world }, tapes, { seed: 5, stepChunks: [100, 100], stepAdvance: false }),
      ];
    },
    check: ([a, b, c, d, bad]) => {
      const same = (x, y, what) => x.result.flatMap((r, i) => (r.raw.every((v, k) => v === y.result[i].raw[k]) && r.mem.every((v, k) => v === y.result[i].mem[k]) ? [] : [`${what}: lane ${i} differs`]));
      const errs = [...same(a, b, "k=1"), ...same(a, c, "k=2"), ...same(a, d, "k=7")];
      if (same(a, bad, "control").length === 0) errs.push("negative control: resuming at step base 0 gave the same records");
      return errs;
    },
    note: ([a]) => `${a.result.filter((r) => r.trap === "bounds").length} lanes halted by the bounds dial, ${a.result.filter((r) => r.halt === "running").length} still running`,
  },
  {
    name: "core params (test-only fake core): the u32, bool and enum values reach the core text as constants",
    // Bytes 1 0 2 3 on a ring of 4, 4 steps: acc = (acc << 1) + b·scale (add) or ^ (xor); skip_zero skips the 0.
    // defaults: 1, 2, 6, 15. skip_zero: 1, 1, 4, 11. scale 3, xor: 3, 6, 12^6 = 10, 20^9 = 29.
    setup: ({ addJob }) => {
      const world = { memory: { kind: "ring", bytes: 4 }, budget: steps(4) };
      const lane = (acc) => [{ mem: Uint8Array.from([1, 0, 2, 3]), expect: { steps: 4, halt: "running", trap: 0, state: { acc, pc: 0 } } }];
      return [
        addJob({ core: { isa: fakeCore }, world }, lane(15)),
        addJob({ core: { isa: fakeCore, params: { skip_zero: true } }, world }, lane(11)),
        addJob({ core: { isa: fakeCore, params: { scale: 3, mode: "xor" } }, world }, lane(29)),
      ];
    },
  },
];

// Each case's setup receives an addJob bound to that case.
for (const c of CASES) {
  const setup = c.setup;
  c.setup = (ctx) => setup({ ...ctx, addJob: (spec, lanes, run) => ctx.addJob(c, spec, lanes, run) });
}
export const CORE_CASES = CASES;
