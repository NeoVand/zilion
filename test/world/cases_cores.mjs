// Contract tests on the two SKELETON cores (6502, BFF): the same world code runs a page-stack CPU and a
// ring-native tape machine. Expectations are hand-computed; the skeletons implement only the opcodes used here.

import { m6502 } from "../../dist/cores/m6502/index.js";
import { bff } from "../../dist/cores/bff/index.js";

const mem = (n, place = {}, fill = 0) => {
  const m = new Uint8Array(n).fill(fill);
  for (const [pos, bytes] of Object.entries(place)) m.set(bytes, +pos);
  return m;
};
const ring = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, ...extra });
const pair = (L, P, extra = {}) => ({ memory: { kind: "segments", segments: [{ bytes: L }, { bytes: L }], ring: P }, ...extra });
const maps = { fetchMap: true, startMap: true };
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

const CASES = [
  {
    name: "6502 skeleton: LDA #, STA abs, NOP, JAM (trap 'illegal' halts as-chip, PC on the JAM)",
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: ring(64, { outputs: { ...maps, writeCounts: true } }) }, [
        { mem: mem(64, { 0: [0xa9, 0x42, 0x8d, 0x20, 0x00, 0xea, 0x02] }),
          expect: { steps: 4, halt: "trap", state: { a: 0x42, pc: 6, p: 0x24, halted: 3 }, mem: { 32: 0x42 }, writes: [1],
            fetched: [0, 1, 2, 3, 4, 5, 6], starts: [0, 2, 5, 6] } },
        // an opcode the skeleton does not implement (ADC #) traps as 'unimplemented'
        { mem: mem(64, { 0: [0x69, 0x01] }), expect: { steps: 1, halt: "trap", state: { pc: 0 } } },
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
        addJob({ isa: m6502, world: ring(32, { halting: { traps: { illegal: "ignore" } } }) },
          [{ mem: mem(32, { 0: [0x02, 0xa9, 0x07, 0x02] }), expect: { steps: 3, halt: "running", state: { a: 7, pc: 4 } } }], { budget: 3 }),
        addJob({ isa: m6502, world: ring(32, { halting: { lethal: { firstUnit: 0xea } } }) },
          [{ mem: mem(32, { 0: [0xa9, 0x01, 0xea] }), expect: { steps: 2, halt: "host", state: { a: 1, pc: 2 } } }]),
        addJob({ isa: m6502, world: ring(32, { ablation: { table: "uniform" } }) },
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
          expect: { steps: 32, halt: "trap", state: { ip: 32, h0: 0, h1: 30 }, mem: { 31: 0x7b }, writes: [0, 1],
            fetched: Array.from({ length: 32 }, (_, i) => i) } },
        // < , : h0 = 31, tape[31] = tape[h1 = 0] = '<'; at 31 that '<' moves h0 to 30.
        { mem: mem(32, { 0: ascii("<,") }), expect: { steps: 32, state: { h0: 30 }, mem: { 31: 0x3c }, writes: [0, 1] } },
        // + + - : tape[0] 0x2B → 0x2C → 0x2D → 0x2C.
        { mem: mem(32, { 0: ascii("++-") }), expect: { steps: 32, mem: { 0: 0x2c }, writes: [3, 0] } },
        // a bracket is a stub in the skeleton: trap 'unimplemented', ip stays on it
        { mem: mem(32, { 0: ascii("[") }), expect: { steps: 1, halt: "trap", state: { ip: 0 } } },
      ]),
  },
  {
    name: "BFF skeleton: bounds policy 'ignore' wraps the ip (Algocell's ip_wrap); ablation by op id",
    setup: ({ addJob }) => [
      // > then 31 no-ops; ip wraps after 32 steps, steps 33..40 run positions 0..7: h0 = 2, ip = 8.
      addJob({ isa: bff, world: pair(16, 32, { halting: { traps: { bounds: "ignore" } } }) },
        [{ mem: mem(32, { 0: ascii(">") }), expect: { steps: 40, halt: "running", state: { h0: 2, ip: 8 } } }], { budget: 40 }),
      // op 5 ('+') ablated: nothing is written.
      addJob({ isa: bff, world: pair(16, 32, { ablation: { table: "uniform" }, outputs: { writeCounts: true } }) },
        [{ mem: mem(32, { 0: ascii("++") }), expect: { steps: 32, writes: [0, 0], mem: { 0: 0x2b } } }], { ablation: Uint32Array.from([1 << 5]) }),
    ],
  },
  {
    name: "one world, three ISAs: pair [16,16] on ring 33, fetch map, writes per segment — Z80, 6502, BFF",
    // Each program writes one byte at position 20 (segment B) and stops.
    // Z80: LD A,7; LD (0x14),A; HALT.  6502: LDA #7; STA $0014; JAM.
    // BFF: thirteen '{' move h1 from 0 to 33 - 13 = 20; '.' writes tape[0] = '{' there; the ip then runs to 33 = P
    // (the copied '{' at 20 moves h1 to 19 on the way) and leaves the tape.
    setup: ({ Z, addJob }) => {
      const world = pair(16, 33, { outputs: { fetchMap: true, writeCounts: true } });
      return [
        addJob({ isa: Z.z80, world }, [{ mem: mem(32, { 0: [0x3e, 0x07, 0x32, 0x14, 0x00, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", mem: { 20: 7 }, writes: [0, 1, 0], fetched: [0, 1, 2, 3, 4, 5] } }], { budget: 40 }),
        addJob({ isa: m6502, world }, [{ mem: mem(32, { 0: [0xa9, 0x07, 0x8d, 0x14, 0x00, 0x02] }),
          expect: { steps: 3, halt: "trap", mem: { 20: 7 }, writes: [0, 1, 0], fetched: [0, 1, 2, 3, 4, 5] } }], { budget: 40 }),
        addJob({ isa: bff, world }, [{ mem: mem(32, { 0: ascii("{".repeat(13) + ".") }),
          expect: { steps: 33, halt: "trap", state: { h1: 19 }, mem: { 20: 0x7b }, writes: [0, 1, 0], fetched: Array.from({ length: 33 }, (_, i) => i) } }], { budget: 40 }),
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
