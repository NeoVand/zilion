// BFF (the Brainfuck family of Agüera y Arcas et al. 2024, arXiv 2406.19108) — SKELETON core, ring-native.
// It exists to validate the IsaCore contract against a machine that is not bus-shaped at all; the eight
// head/byte ops run, the two brackets are stubs (trap 'unimplemented'). Do not use it for results. The full core
// must reproduce Algocell's experiments/micro/bff.py bit for bit (milestone M2); docs/ADDING_A_CORE.md lists what
// it needs.
//
// Contract points this core exercises that the Z80 does not:
//   - ring-native addressing (addressBits 0): positions are computed by the core modulo ZIL_MEM_P, the world's
//     ring size, so the same world (a pair of tapes on a ring, padding, write counts) applies unchanged;
//   - an alphabet: the decode key is the op id after the byte → op map, not the byte;
//   - termination by traps the world can re-policy: the instruction pointer leaving the tape is trap 'bounds'
//     (as-chip: halt, the published rule; 'ignore' wraps it modulo the ring, Algocell's ip_wrap variant), and an
//     unmatched bracket is trap 'unmatched' (the published rule halts; nohalt = 'ignore'; the probability dial is
//     a world dial, zil_hash(seed, pair, step, 0), which equals bff.py's hash32(p·C1 ^ (s+1)·C2 ^ roll_seed));
//   - no stack (conventions.stackTop = null) and no native halt instruction.

import type { CoreGenOptions, IsaCore, StateField } from "../../contract/isa.js";

const STATE: readonly StateField[] = [
  { name: "ip", bits: 32, wgsl: "bff_ip" },
  { name: "h0", bits: 32, wgsl: "bff_h0" },
  { name: "h1", bits: 32, wgsl: "bff_h1" },
  { name: "halted", bits: 8, wgsl: "bff_halted", note: "0 running; 2 host; 3 trap (left the tape, unmatched bracket)" },
  { name: "trap", bits: 8, wgsl: "bff_trap", note: "TRAP_CAUSES code of the trap that halted the core (bounds, unmatched, unimplemented); 0 otherwise" },
];

/** Op ids 1..10: < > { } + - . , [ ] (bff.py OPS), on the published ASCII alphabet. */
const ASCII: Record<number, number> = { 0x3c: 1, 0x3e: 2, 0x7b: 3, 0x7d: 4, 0x2b: 5, 0x2d: 6, 0x2e: 7, 0x2c: 8, 0x5b: 9, 0x5d: 10 };

function text(o: CoreGenOptions): string {
  const h = o.hooks;
  const trap = (cause: string, onIgnore: string) =>
    h.trap
      ? `if (zil_trap(ZIL_TRAP_${cause}) != ZIL_TRAP_IGNORE) { bff_halted = ZIL_HALT_TRAP; bff_trap = ZIL_TRAP_${cause}; } else { ${onIgnore} }`
      : `bff_halted = ZIL_HALT_TRAP; bff_trap = ZIL_TRAP_${cause};`;
  const cases = Object.entries(ASCII)
    .map(([b, id]) => `        case ${b}u: { return ${id}u; }`)
    .join("\n");
  return /* wgsl */ `
// === BFF — SKELETON: ring-native; < > { } + - . , run; [ ] are stubs ===
var<private> bff_ip: u32;
var<private> bff_h0: u32;
var<private> bff_h1: u32;
var<private> bff_halted: u32;
var<private> bff_trap: u32;     // the trap cause that halted the core (symbols.trapCause)
const BFF_ADDR_MASK: u32 = 0u;   // ring-native: the core computes positions modulo ZIL_MEM_P itself

fn bff_op(b: u32) -> u32 {       // the alphabet (variant 'ascii'): byte -> op id, 0 = no-op
    switch (b) {
${cases}
        default: { return 0u; }
    }
}

fn bff_step() {
    if (bff_halted != 0u) { return; }
    let pc0 = bff_ip;
${h.fetch ? "    on_fetch(pc0);\n" : ""}    let b = mem_read(pc0);
${h.instructionStart ? `    let act = on_instruction_start(pc0, b);
    if (act == ZIL_HALT) { bff_halted = ZIL_HALT_HOST; return; }
    if (act != ZIL_SKIP) {
` : "    {\n"}    let op = bff_op(b);
    if (!on_decode(0u, op)) {
        switch (op) {
            case 1u: { bff_h0 = (bff_h0 + ZIL_MEM_P - 1u) % ZIL_MEM_P; }
            case 2u: { bff_h0 = (bff_h0 + 1u) % ZIL_MEM_P; }
            case 3u: { bff_h1 = (bff_h1 + ZIL_MEM_P - 1u) % ZIL_MEM_P; }
            case 4u: { bff_h1 = (bff_h1 + 1u) % ZIL_MEM_P; }
            case 5u: { mem_write(bff_h0, mem_read(bff_h0) + 1u); }
            case 6u: { mem_write(bff_h0, mem_read(bff_h0) + 255u); }
            case 7u: { mem_write(bff_h1, mem_read(bff_h0)); }
            case 8u: { mem_write(bff_h0, mem_read(bff_h1)); }
            case 9u, 10u: { ${trap("UNIMPLEMENTED", "")} if (bff_halted != 0u) { return; } }   // brackets: stub
            default: {}
        }
    }
    }
    bff_ip = bff_ip + 1u;
    if (bff_ip >= ZIL_MEM_P) { ${trap("BOUNDS", "bff_ip = bff_ip % ZIL_MEM_P;")} }   // left the tape
}
`;
}

export const bff: IsaCore = {
  id: "bff",
  name: "BFF (ring-native tape machine) — skeleton",
  coreVersion: "0.0.0-skeleton",
  status: "skeleton",
  addressBits: 0,
  fetchUnitBytes: 1,
  endianness: "little",
  state: STATE,
  internals: [],
  symbols: { step: "bff_step", haltReason: "bff_halted", pc: "bff_ip", trapCause: "bff_trap" },
  hooks: ["fetch", "instructionStart", "trap"],
  decode: {
    fn: "on_decode",
    params: ["page", "key"],
    defaultLayout: "ops",
    layouts: {
      ops: { pages: [{ id: 0, name: "ops", keyBits: 4 }], pageExpr: "page", keyExpr: "key", description: "One page of op ids (0 = no-op, 1..10 = < > { } + - . , [ ])." },
    },
    skip: "One byte (the op is a no-op).",
  },
  conventions: {
    step: "One op, including a whole bracket scan (cubff semantics); a no-op byte is a step.",
    stackTop: null,
    firstPushAt: null,
    entry: (pos) => ({ ip: pos }),
    traps: { bounds: "halt", unmatched: "halt", unimplemented: "halt" },
    halting:
      "No halt instruction. The instruction pointer leaving the ring ends the encounter (trap 'bounds'); an unmatched " +
      "bracket ends it (trap 'unmatched'). Both are world-policy traps.",
    illegal: "None: bytes outside the alphabet are no-ops.",
  },
  variants: { ascii: "The published ASCII alphabet (bff.py ascii_map)." },
  defaultVariant: "ascii",
  compat: ["skeleton"],
  wgsl(o) {
    if ((o.variant ?? "ascii") !== "ascii") throw new Error(`bff: unknown variant '${o.variant}'`);
    if ((o.compat ?? "skeleton") !== "skeleton") throw new Error(`bff: unknown compat '${o.compat}'`);
    return text(o);
  },
};
