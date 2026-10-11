// Contract tests on the 6502 and the BFF core: the same world code runs a page-stack CPU and a ring-native tape
// machine. Expectations are hand-computed. The 6502's own world tests (zero page, stack page, vectors, JAM, budgets,
// a self-copier) are in cases_m6502.mjs; BFF is also checked bit for bit against Algocell's bff.py by
// test/world/bff_equiv.py.

import { m6502 } from "../../dist/cores/m6502/index.js";
import { bff, BFF_ASCII, BFF_ASCII_LITERAL } from "../../dist/cores/bff/index.js";
import { fakeCore } from "./fake_core.mjs";

const mem = (n, place = {}, fill = 0) => {
  const m = new Uint8Array(n).fill(fill);
  for (const [pos, bytes] of Object.entries(place)) m.set(bytes, +pos);
  return m;
};
// Budgets and stacks are explicit (no silent defaults): the helpers state the budget; 6502 worlds state their stack.
// BFF has none: a world may still give one (so one spec serves every ISA), and BFF lists it as not applicable.
const steps = (n) => ({ unit: "steps", value: n });
const FIRST = { firstPushAt: "lastByte" };
const ring = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, budget: steps(100), ...extra });
const pair = (L, P, extra = {}) => ({ memory: { kind: "segments", segments: [{ bytes: L }, { bytes: L }], ring: P }, budget: steps(100), ...extra });
const maps = { fetchMap: true, startMap: true };
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const upTo = (n) => range(0, n);

const CASES = [
  {
    name: "6502: LDA #, STA abs, NOP, JAM (trap 'illegal' halts as-chip, PC on the JAM)",
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: ring(64, { init: { stack: FIRST }, outputs: { ...maps, writeCounts: true } }) }, [
        { mem: mem(64, { 0: [0xa9, 0x42, 0x8d, 0x20, 0x00, 0xea, 0x02] }),
          expect: { steps: 4, halt: "trap", trap: "illegal", state: { a: 0x42, pc: 6, p: 0x20, halted: 3, trap: 1 }, mem: { 32: 0x42 }, writes: [1],
            fetched: [0, 1, 2, 3, 4, 5, 6], starts: [0, 2, 5, 6] } },
        // ADC #1 (P reset 0x20: C = 0), then JAM: the full core has no 'unimplemented' trap
        { mem: mem(64, { 0: [0x69, 0x01, 0x02] }), expect: { steps: 2, halt: "trap", trap: "illegal", state: { a: 1, pc: 2, trap: 1 } } },
      ]),
  },
  {
    name: "6502: page-1 stack convention on ring 40 (S0 = 0xDF: 0x1DF mod 40 = 39); PHA lands on 39",
    // 0x100 + S ≡ 39 (mod 40) with S ≤ 0xFF: 479 = 0x1DF → S = 0xDF (519 would need S = 263).
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: ring(40, { init: { stack: { topAliases: "lastByte" } } }) }, [
        { mem: mem(40, { 0: [0x02] }), expect: { steps: 1, state: { s: 0xdf } } },
        { mem: mem(40, { 0: [0xa9, 0x42, 0x48, 0x02] }), expect: { steps: 3, state: { s: 0xde, pc: 3 }, mem: { 39: 0x42 } } },
      ]),
  },
  {
    name: "6502: BRK pushes PC+2 and P|0x30 on page 1, vectors through 0xFFFE/0xFFFF = positions 30/31",
    // Ring 32, stack top at 20: S0 = 0xF4 (0x1F4 = 500 ≡ 20). BRK: PCH 0x00 → 20, PCL 0x02 → 19, P|0x30 = 0x30 → 18;
    // PC = mem[30] | mem[31] << 8 = 0x0010; JAM there. The vector bytes are reads, not instruction fetches.
    setup: ({ addJob }) =>
      addJob({ isa: m6502, world: ring(32, { init: { stack: { topAliases: 20 } }, outputs: maps }) }, [
        { mem: mem(32, { 0: [0x00, 0xea], 16: [0x02], 20: [0xee], 30: [0x10, 0x00] }),
          expect: { steps: 2, halt: "trap", state: { pc: 0x10, s: 0xf1, p: 0x24 }, mem: { 20: 0x00, 19: 0x02, 18: 0x30 },
            fetched: [0, 1, 16], starts: [0, 16] } },
      ]),
  },
  {
    name: "6502: world policies — JAM ignored, lethal first unit 0xEA, ablation of LDA # (on_decode)",
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
    name: "BFF: heads wrap modulo the ring ('{' from 0 → 31); '.' copies into B; leaving the tape is trap 'bounds' (ip = P)",
    // { . : h1 = 31, tape[31] = tape[h0 = 0] = '{'. Bytes 2..30 are no-ops; at 31 the copied '{' moves h1 to 30.
    // ip reaches 32 = P → trap 'bounds' (as-chip halt) after 32 steps.
    setup: ({ addJob }) =>
      addJob({ isa: bff, world: pair(16, 32, { outputs: { ...maps, writeCounts: true } }) }, [
        { mem: mem(32, { 0: ascii("{.") }),
          expect: { steps: 32, halt: "trap", trap: "bounds", state: { ip: 32, h0: 0, h1: 30, trap: 4 }, mem: { 31: 0x7b }, writes: [0, 1],
            fetched: upTo(32), starts: upTo(32) } },
        // < , : h0 = 31, tape[31] = tape[h1 = 0] = '<'; at 31 that '<' moves h0 to 30.
        { mem: mem(32, { 0: ascii("<,") }), expect: { steps: 32, state: { h0: 30 }, mem: { 31: 0x3c }, writes: [0, 1] } },
        // + + - : tape[0] 0x2B → 0x2C → 0x2D → 0x2C.
        { mem: mem(32, { 0: ascii("++-") }), expect: { steps: 32, mem: { 0: 0x2c }, writes: [3, 0] } },
        // '[' with a non-zero byte under head 0 (tape[0] is the '[' itself) does nothing
        { mem: mem(32, { 0: ascii("[") }), expect: { steps: 32, halt: "trap", trap: "bounds", state: { ip: 32, trap: 4 } } },
      ]),
  },
  {
    name: "BFF brackets: a counted loop, forward and nested jumps (scans not fetched), a jump back to position 0, unmatched brackets halt",
    setup: ({ addJob }) =>
      addJob({ isa: bff, world: pair(16, 32, { budget: steps(200), outputs: { ...maps, writeCounts: true } }) }, [
        // + [ - ] : tape[0] = 0x2C; ']' jumps back to '[' (ip 1, then 2) while tape[0] != 0: 44 × (-, ]) = 88 steps;
        // then positions 4..31: 2 + 88 + 28 = 118 steps, 45 writes into A.
        { label: "+[-]", mem: mem(32, { 0: ascii("+[-]") }),
          expect: { steps: 118, halt: "trap", trap: "bounds", state: { ip: 32, h0: 0 }, mem: { 0: 0 }, writes: [45, 0], fetched: upTo(32), starts: upTo(32) } },
        // < [ + ] + : h0 = 31 (a zero): '[' jumps to the ']' at 3 (the '+' at 2 never runs); the '+' at 4 sets tape[31] = 1.
        // The scan reads 2 and 3 but does not fetch them: neither map has them.
        { label: "<[+]+", mem: mem(32, { 0: ascii("<[+]+") }),
          expect: { steps: 30, state: { h0: 31 }, mem: { 31: 1 }, writes: [0, 1], fetched: [0, 1, ...range(4, 32)], starts: [0, 1, ...range(4, 32)] } },
        // nested: < [ [ + ] + ] + : the outer '[' matches the ']' at 6.
        { label: "<[[+]+]+", mem: mem(32, { 0: ascii("<[[+]+]+") }), expect: { steps: 27, mem: { 31: 1 }, starts: [0, 1, ...range(7, 32)] } },
        // [ > ] : ']' jumps back to the '[' at position 0 twice (h0 = 1, 2: non-zero), then h0 = 3 (zero): 7 + 29 steps
        { label: "[>]", mem: mem(32, { 0: ascii("[>]") }), expect: { steps: 36, halt: "trap", trap: "bounds", state: { h0: 3, ip: 32 } } },
        // unmatched '[': halts on it (trap 'unmatched', ip on the bracket); unmatched ']' likewise
        { label: "<[", mem: mem(32, { 0: ascii("<[") }), expect: { steps: 2, halt: "trap", trap: "unmatched", state: { ip: 1, h0: 31, trap: 3 }, writes: [0, 0], starts: [0, 1] } },
        { label: "+]", mem: mem(32, { 0: ascii("+]") }), expect: { steps: 2, halt: "trap", trap: "unmatched", state: { ip: 1, trap: 3 }, mem: { 0: 0x2c } } },
        // ']' over a zero does nothing
        { label: "<]", mem: mem(32, { 0: ascii("<]") }), expect: { steps: 32, halt: "trap", trap: "bounds" } },
      ]),
  },
  {
    name: "BFF unmatched policies: 'ignore' (bff.py nohalt) makes the bracket a no-op; a dial halts at the first draw below round(p·2³²)",
    setup: ({ Z, addJob }) => {
      // 64 lanes of 32 ']': every ']' sees a non-zero byte and no '[' before it, so step k draws zil_hash(seed, lane, k, 0)
      const seed = 7;
      const T = Z.dialThreshold(0.5);
      const dial = Array.from({ length: 64 }, (_, lane) => {
        let k = 0;
        while (k < 32 && !(Z.zilHash(seed, lane, k, 0) < T)) k++;
        return { mem: mem(32, {}, 0x5d),
          expect: k < 32 ? { steps: k + 1, halt: "trap", trap: "unmatched", state: { ip: k } } : { steps: 32, halt: "trap", trap: "bounds" } };
      });
      return [
        addJob({ isa: bff, world: pair(16, 32, { halting: { traps: { unmatched: "ignore" } } }) }, [
          { mem: mem(32, { 0: ascii("<[") }), expect: { steps: 32, halt: "trap", trap: "bounds", state: { ip: 32 } } },
          { mem: mem(32, { 0: ascii("+]") }), expect: { steps: 32, trap: "bounds", mem: { 0: 0x2c } } },
        ]),
        addJob({ isa: bff, world: pair(16, 32, { halting: { traps: { unmatched: { halt: { probability: 0.5 } } } } }) }, dial, { seed }),
      ];
    },
    check: ([, d]) => (d.result.filter((r) => r.steps > 1).length > 8 && d.result.filter((r) => r.steps === 1).length > 8 ? [] : ["the dial lanes do not exercise both outcomes"]),
  },
  {
    name: "BFF literal push (param literal, 'P' in BFF_ASCII_LITERAL): two bytes written below head 1 (× lit_rep), operands fetched, the push at the end of the tape",
    setup: ({ addJob }) => {
      const lit = (rep, extra = {}) => ({ core: { isa: bff, params: { alphabet: BFF_ASCII_LITERAL, literal: true, lit_rep: rep } },
        world: pair(16, 32, { outputs: { ...maps, writeCounts: true }, ...extra }) });
      const atEnd = mem(32, { 0: [0x41, 0x42], 31: ascii("P") });
      return [
        // P x y : h1 = 30, tape[31] = 'x', tape[30] = 'y'; ip skips the operands (fetched, not started) to 3.
        addJob(lit(1), [{ mem: mem(32, { 0: ascii("Pxy") }),
          expect: { steps: 30, halt: "trap", trap: "bounds", state: { h1: 30, ip: 32 }, mem: { 30: 0x79, 31: 0x78 }, writes: [0, 2], fetched: upTo(32), starts: [0, ...range(3, 32)] } },
          // the push at position 31 reads positions 0 and 1 (mod P), overwrites itself, and leaves the tape at ip = 34
          { mem: atEnd, expect: { steps: 32, halt: "trap", trap: "bounds", state: { ip: 34, h1: 30 }, mem: { 30: 0x42, 31: 0x41 }, writes: [0, 2], fetched: upTo(32) } }]),
        // lit_rep 2: the pair is written twice, at 31, 30 and 29, 28
        addJob(lit(2), [{ mem: mem(32, { 0: ascii("Pxy") }), expect: { steps: 30, state: { h1: 28 }, mem: { 28: 0x79, 29: 0x78, 30: 0x79, 31: 0x78 }, writes: [0, 4] } }]),
        // with the pointer wrapping (bff.py ip_wrap), the push at 31 continues at 34 mod 32 = 2: steps 33..40 run 2..9
        addJob(lit(1, { halting: { traps: { bounds: "ignore" } } }), [{ mem: atEnd, expect: { steps: 40, halt: "running", trap: 0, state: { ip: 10, h1: 30 } } }], { budget: 40 }),
      ];
    },
  },
  {
    name: "BFF alphabet as a table param: remapped brackets and '+'; the loop test is the byte value 0 whatever byte 0 maps to",
    setup: ({ addJob }) => {
      const t1 = [...BFF_ASCII];
      t1[0x01] = 9;
      t1[0x02] = 10;
      t1[0x78] = 5;
      const t2 = [...BFF_ASCII];
      t2[0x00] = 4; // byte 0 is '}' here, yet '[' over a zero byte still jumps
      const w = pair(16, 32, { outputs: { ...maps, writeCounts: true } });
      return [
        // < 0x01 x 0x02 x = < [ + ] + under t1
        addJob({ core: { isa: bff, params: { alphabet: t1 } }, world: w }, [{ mem: mem(32, { 0: [0x3c, 0x01, 0x78, 0x02, 0x78] }),
          expect: { steps: 30, mem: { 31: 1 }, writes: [0, 1], starts: [0, 1, ...range(4, 32)] } }]),
        // < [ ] then zero bytes, each a '}': the '[' sees tape[31] = 0 and jumps to the ']' at 2; positions 3..31 move h1 to 29
        addJob({ core: { isa: bff, params: { alphabet: t2 } }, world: w }, [{ mem: mem(32, { 0: ascii("<[]") }),
          expect: { steps: 31, halt: "trap", trap: "bounds", state: { h0: 31, h1: 29 }, starts: [0, 1, ...range(3, 32)] } }]),
      ];
    },
  },
  {
    name: "BFF ablation by op id: an ablated '+' writes nothing; an ablated '[' is a no-op but still matches its ']'",
    setup: ({ addJob }) => [
      addJob({ isa: bff, world: pair(16, 32, { ablation: { table: "uniform" }, outputs: { writeCounts: true } }) },
        [{ mem: mem(32, { 0: ascii("++") }), expect: { steps: 32, writes: [0, 0], mem: { 0: 0x2b } } }], { ablation: Uint32Array.from([1 << 5]) }),
      // < [ + ] + with '[' ablated: '+' and ']' loop 256 times (']' finds the ablated '[' at 1), tape[31] wraps to 0;
      // then '+' at 4 and positions 5..31: 2 + 512 + 1 + 27 = 542 steps, 257 writes into B.
      addJob({ isa: bff, world: pair(16, 32, { budget: steps(600), ablation: { table: "uniform" }, outputs: { writeCounts: true } }) },
        [{ mem: mem(32, { 0: ascii("<[+]+") }), expect: { steps: 542, halt: "trap", trap: "bounds", mem: { 31: 1 }, writes: [0, 257] } }], { ablation: Uint32Array.from([1 << 9]) }),
    ],
  },
  {
    name: "BFF on bff.py's pair (two 64-byte tapes, ring 128): a copy into B, a closed loop that runs the budget out; padded ring 136",
    setup: ({ addJob }) => {
      const w = (P, budget) => pair(64, P, { budget: steps(budget), outputs: { ...maps, writeCounts: true } });
      return [
        addJob({ isa: bff, world: w(128, 8192) }, [
          // { . : h1 = 127 (in B), tape[127] = '{'; the pointer runs through B (entered) and leaves at 128
          { mem: mem(128, { 0: ascii("{.") }), expect: { steps: 128, halt: "trap", trap: "bounds", state: { h1: 126 }, mem: { 127: 0x7b }, writes: [0, 1], starts: upTo(128) } },
          // + [ ] : the ']' at 2 jumps back to 1 forever (tape[0] = 0x2C); closed: starts 0, 1, 2 only
          { mem: mem(128, { 0: ascii("+[]") }), expect: { steps: 8192, halt: "running", trap: 0, state: { ip: 2 }, mem: { 0: 0x2c }, writes: [1, 0], starts: [0, 1, 2], fetched: [0, 1, 2] } },
        ]),
        addJob({ isa: bff, world: w(136, 200) }, [
          // { . : h1 = 135, a padding byte: the write is counted as padding and never stored; the ip runs through the
          // padding (zeros) and leaves at 136
          { mem: mem(128, { 0: ascii("{.") }), expect: { steps: 136, halt: "trap", trap: "bounds", state: { ip: 136, h1: 134 }, memAll: [...mem(128, { 0: ascii("{.") })], writes: [0, 0, 1], starts: upTo(136) } },
          // < [ : h0 = 135 (padding, zero); the scan crosses B to the ']' at 127, then the ip runs 128..135
          { mem: mem(128, { 0: ascii("<["), 127: ascii("]") }), expect: { steps: 10, halt: "trap", trap: "bounds", starts: [0, 1, ...range(128, 136)] } },
          // without that ']' the scan reaches the end of the ring: unmatched
          { mem: mem(128, { 0: ascii("<[") }), expect: { steps: 2, halt: "trap", trap: "unmatched", state: { ip: 1 } } },
        ]),
      ];
    },
  },
  {
    name: "one world, three ISAs: pair [16,16] on ring 33, fetch map, writes per segment — Z80, 6502, BFF; trap causes told apart",
    // Each program writes one byte at position 20 (segment B) and stops.
    // Z80: LD A,7; LD (0x14),A; HALT.  6502: LDA #7; STA $0014; JAM.
    // BFF: thirteen '{' move h1 from 0 to 33 - 13 = 20; '.' writes tape[0] = '{' there; the ip then runs to 33 = P
    // (the copied '{' at 20 moves h1 to 19 on the way) and leaves the tape.
    // One spec for all three, with the shared stack convention (the first push lands on the last byte); BFF has no
    // stack and lists init.stack as not applicable. The record tells the three endings apart: halt-insn, illegal, bounds.
    setup: ({ Z, addJob }) => {
      const world = pair(16, 33, { init: { stack: FIRST }, outputs: { fetchMap: true, writeCounts: true } });
      const b = Z.buildMachine({ isa: bff, world });
      if (b.manifest.init.stack.notApplicable !== "no stack") throw new Error(`bff init.stack: ${JSON.stringify(b.manifest.init.stack)}`);
      return [
        addJob({ isa: Z.z80, compat: "0.3", world }, [{ mem: mem(32, { 0: [0x3e, 0x07, 0x32, 0x14, 0x00, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", trap: "halt-insn", mem: { 20: 7 }, writes: [0, 1, 0], fetched: [0, 1, 2, 3, 4, 5] } }], { budget: 40 }),
        addJob({ isa: m6502, world }, [{ mem: mem(32, { 0: [0xa9, 0x07, 0x8d, 0x14, 0x00, 0x02] }),
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
      const n = Z.buildMachine({ isa: Z.z80, compat: "0.3", world: w }).manifest.memory.hostBytesPerLane;
      return [
        // Z80: LD BC,0x1234; PUSH BC; HALT. PUSH writes B (0x12) first, at SP0 - 1, then C (0x34) below it.
        addJob({ isa: Z.z80, compat: "0.3", world: w }, [{ mem: mem(n, { 0: [0x01, 0x34, 0x12, 0xc5, 0x76] }),
          expect: { steps: 3, halt: "halt-insn", state: { sp: (sp0 - 2) & 0xffff }, mem: { [t]: 0x12, [t - 1]: 0x34 } } }]),
        // 6502: LDA #$12; PHA; LDA #$34; PHA; JAM: 0x12 at 0x0100|S0, then 0x34 below it.
        addJob({ isa: m6502, world: w }, [{ mem: mem(n, { 0: [0xa9, 0x12, 0x48, 0xa9, 0x34, 0x48, 0x02] }),
          expect: { steps: 5, halt: "trap", trap: "illegal", state: { s: (s0 - 2) & 0xff }, mem: { [t]: 0x12, [t - 1]: 0x34 } } }]),
      ];
    },
  })),
  ...[128, 137].map((P) => ({
    name: `resumable runs, BFF on a pair of 64-byte tapes on ring ${P}: k = 1, 2, 7 dispatches = one dispatch of 2000 steps (wrap, literal, unmatched dial p = 0.3)`,
    // bff.py's wraplit_hp0.3 world (ring 137: with 9 padding bytes and an odd ring). Op-rich random tapes: brackets
    // loop and halt by the dial at any step, literal pushes write into the partner; the step base reaches every draw.
    setup: ({ addJob }) => {
      const world = pair(64, P, { budget: steps(2000), halting: { traps: { bounds: "ignore", unmatched: { halt: { probability: 0.3 } } } },
        outputs: { writeCounts: true, fetchMap: true, startMap: true } });
      const spec = { core: { isa: bff, params: { alphabet: BFF_ASCII_LITERAL, literal: true } }, world };
      const tapes = Array.from({ length: 4096 }, (_, i) => {
        const m = new Uint8Array(128);
        let s = (i * 2654435761 + 12345) >>> 0;
        for (let k = 0; k < 128; k++) {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          const r = s >>> 24;
          m[k] = r < 140 ? "<>{}+-.,[]P".charCodeAt(r % 11) : r < 180 ? 0 : (s >>> 8) & 0xff;
        }
        return { mem: m };
      });
      return [
        addJob(spec, tapes, { seed: 5, budget: 2000 }),
        addJob(spec, tapes, { seed: 5, stepChunks: [2000] }),
        addJob(spec, tapes, { seed: 5, stepChunks: [1000, 1000] }),
        addJob(spec, tapes, { seed: 5, stepChunks: [3, 290, 311, 333, 500, 400, 163] }),
        addJob(spec, tapes, { seed: 5, stepChunks: [1000, 1000], stepAdvance: false }),
      ];
    },
    check: ([a, b, c, d, bad]) => {
      const same = (x, y, what) => x.result.flatMap((r, i) => (r.raw.every((v, k) => v === y.result[i].raw[k]) && r.mem.every((v, k) => v === y.result[i].mem[k]) ? [] : [`${what}: lane ${i} differs`]));
      const errs = [...same(a, b, "k=1"), ...same(a, c, "k=2"), ...same(a, d, "k=7")];
      if (same(a, bad, "control").length === 0) errs.push("negative control: resuming at step base 0 gave the same records");
      const late = a.result.filter((r) => r.trap === "unmatched" && r.steps > 1000).length;
      if (late < 10 || a.result.filter((r) => r.halt === "running").length < 10) errs.push(`not exercised: ${late} lanes halted by the dial after step 1000`);
      return errs;
    },
    note: ([a]) => `${a.result.filter((r) => r.trap === "unmatched").length} lanes halted by the dial (${a.result.filter((r) => r.trap === "unmatched" && r.steps > 1000).length} after step 1000), ${a.result.filter((r) => r.halt === "running").length} ran 2000 steps`,
  })),
  {
    name: "core params (test-only fake core): the u32, bool, enum and table values reach the core text as constants",
    // Bytes 1 0 2 3 on a ring of 4, 4 steps: acc = (acc << 1) + b·scale (add) or ^ (xor); skip_zero skips the 0.
    // defaults: 1, 2, 6, 15. skip_zero: 1, 1, 4, 11. scale 3, xor: 3, 6, 12^6 = 10, 20^9 = 29.
    // remap b -> 255 - b (a table indexed at run time): 254, 508 + 255 = 763, 1526 + 253 = 1779, 3558 + 252 = 3810.
    setup: ({ addJob }) => {
      const world = { memory: { kind: "ring", bytes: 4 }, budget: steps(4) };
      const lane = (acc) => [{ mem: Uint8Array.from([1, 0, 2, 3]), expect: { steps: 4, halt: "running", trap: 0, state: { acc, pc: 0 } } }];
      return [
        addJob({ core: { isa: fakeCore }, world }, lane(15)),
        addJob({ core: { isa: fakeCore, params: { skip_zero: true } }, world }, lane(11)),
        addJob({ core: { isa: fakeCore, params: { scale: 3, mode: "xor" } }, world }, lane(29)),
        addJob({ core: { isa: fakeCore, params: { remap: Uint8Array.from({ length: 256 }, (_, i) => 255 - i) } }, world }, lane(3810)),
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
