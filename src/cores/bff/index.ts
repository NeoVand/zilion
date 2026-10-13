// BFF, the Brainfuck family of Agüera y Arcas et al. 2024 (arXiv 2406.19108): a ring-native tape machine.
//
// Semantics are those of Algocell's experiments/micro/bff.py (which follows cubff `bff.inc.h`), reproduced bit for
// bit in every configuration (test/world/bff_equiv.py with the mapping in test/world/bff_machine.mjs; report in
// test/baselines/bff-equivalence.md):
//   - the tape is the world's ring of P positions (bff.py: the pair of two 64-byte tapes, P = 128); the instruction
//     pointer and the two heads start at 0 (or at the world's entry); the heads move modulo P;
//   - each byte maps to an op id through the alphabet (a 256-entry table): 0 no-op, 1..10 `< > { } + - . , [ ]`,
//     11 the literal push; a no-op byte still costs a step;
//   - `[` with a zero byte under head 0 scans forward for the matching `]` (by op id, depth counting) and jumps to it;
//     `]` with a non-zero byte scans backward for the matching `[`; execution resumes after the bracket found. Both
//     scans stay inside [0, P) and never wrap (also when the pointer does). The loop test is the byte VALUE 0,
//     whatever the alphabet maps byte 0 to. A whole scan is one step;
//   - termination is two world-policy traps: the pointer leaving the tape is trap 'bounds' (as-chip: halt, the
//     published rule; 'ignore' wraps it modulo P, bff.py's `ip_wrap`), and an unmatched bracket is trap 'unmatched'
//     (as-chip: halt; 'ignore' makes it a no-op, bff.py's `nohalt`; a dial `{ halt: { probability } }` is bff.py's
//     `halt_p`: the world's draw zil_hash(seed, lane, step, 0) is bff.py's hash32(p·C1 ^ (s+1)·C2 ^ roll_seed));
//   - the literal push (op 11, core param `literal`; byte 0x50 'P' in the ASCII-with-literal map) reads the two
//     bytes after it (positions ip+1 and ip+2 modulo P, fetched as instruction stream), then `lit_rep` times moves
//     head 1 down by two and writes them there (the first at head 1 + 1, the second at head 1), and skips them.
// No stack, no halt instruction, no illegal opcodes.

import type { CoreGenOptions, IsaCore, StateField } from "../../contract/isa.js";

const STATE: readonly StateField[] = [
  { name: "ip", bits: 32, wgsl: "bff_ip", note: "instruction pointer (a ring position); on the bracket while halted on 'unmatched', P after leaving the tape" },
  { name: "h0", bits: 32, wgsl: "bff_h0", note: "head 0 (read/write head of + - , and the loop test)" },
  { name: "h1", bits: 32, wgsl: "bff_h1", note: "head 1 (write head of . and the literal push)" },
  { name: "halted", bits: 8, wgsl: "bff_halted", note: "0 running; 2 host; 3 trap (left the tape, unmatched bracket)" },
  { name: "trap", bits: 8, wgsl: "bff_trap", note: "TRAP_CAUSES code of the trap that halted the core (bounds, unmatched); 0 otherwise" },
];

/** The instruction characters of op ids 1..10 (bff.py OPS); op 11 is the literal push, byte 0x50 ('P') in ASCII. */
export const BFF_OPS = "<>{}+-.,[]";
/** Op id of the literal push (core param `literal`). */
export const BFF_LITERAL_OP = 11;
/** Byte of the literal push in the ASCII-with-literal alphabet (bff.py LIT). */
export const BFF_LITERAL_BYTE = 0x50;

/** bff.py's `ascii_map(literal)`: the published ASCII alphabet, with 'P' → 11 when `literal` is set. */
export function bffAsciiMap(literal = false): number[] {
  const m = new Array<number>(256).fill(0);
  for (let i = 0; i < BFF_OPS.length; i++) m[BFF_OPS.charCodeAt(i)] = i + 1;
  if (literal) m[BFF_LITERAL_BYTE] = BFF_LITERAL_OP;
  return m;
}
/** The published alphabet (the default of param `alphabet`). */
export const BFF_ASCII: readonly number[] = Object.freeze(bffAsciiMap(false));
/** The published alphabet with the literal push on 'P' (use with `literal: true`). */
export const BFF_ASCII_LITERAL: readonly number[] = Object.freeze(bffAsciiMap(true));

/** Check the cross-parameter rules (the generic mechanism checks each parameter alone). */
function checkParams(p: Readonly<Record<string, unknown>>): void {
  const alphabet = p.alphabet as readonly number[];
  const hasLiteral = alphabet.includes(BFF_LITERAL_OP);
  if (p.literal && !hasLiteral) {
    throw new Error(
      "bff: param 'literal' is on but the alphabet maps no byte to op 11 (the literal push), so it would never run; " +
        "use BFF_ASCII_LITERAL (bff.py's ascii_map(True)) or a table with an op-11 byte",
    );
  }
  if (!p.literal && hasLiteral) {
    throw new Error("bff: the alphabet maps a byte to op 11 (the literal push) but param 'literal' is off, so it would be a no-op; set literal: true or map it to 0");
  }
  if (!p.literal && p.lit_rep !== 1) throw new Error(`bff: param 'lit_rep' (${String(p.lit_rep)}) applies only with literal: true`);
}

function text(o: CoreGenOptions): string {
  const h = o.hooks;
  // Every trap path records its cause before halting; with the trap hook a world policy decides (VECTOR is never
  // returned: BFF lists no vector, so the builder refuses that policy).
  const trap = (cause: string, onIgnore: string, indent: string) =>
    h.trap
      ? `if (zil_trap(ZIL_TRAP_${cause}) != ZIL_TRAP_IGNORE) {\n${indent}    bff_halted = ZIL_HALT_TRAP;\n${indent}    bff_trap = ZIL_TRAP_${cause};\n${indent}} else {${onIgnore ? `\n${indent}    ${onIgnore}\n${indent}` : " "}}`
      : `bff_halted = ZIL_HALT_TRAP;\n${indent}bff_trap = ZIL_TRAP_${cause};`;
  const fetch = (pos: string) => (h.fetch ? `on_fetch(${pos}); ` : "");
  return /* wgsl */ `
// === BFF: ring-native tape machine (cubff bff.inc.h semantics, as Algocell's experiments/micro/bff.py) ===
// Uses the core params ZIL_PARAM_ALPHABET (byte -> op id), ZIL_PARAM_LITERAL and ZIL_PARAM_LIT_REP.
var<private> bff_ip: u32;
var<private> bff_h0: u32;
var<private> bff_h1: u32;
var<private> bff_halted: u32;
var<private> bff_trap: u32;     // the trap cause that halted the core (symbols.trapCause)

fn bff_op(b: u32) -> u32 {      // the alphabet: byte -> op id (0 no-op, 1..10 < > { } + - . , [ ], 11 literal)
    return ZIL_PARAM_ALPHABET[b & 0xffu];
}

// An unmatched bracket: trap 'unmatched' (as-chip: halt; ignored, the bracket is a no-op).
fn bff_unmatched() {
    ${trap("UNMATCHED", "", "    ")}
}

// '[' with a zero under head 0: jump to the matching ']' (forward scan by op id, inside [0, P), no wrap).
fn bff_open(pc0: u32) {
    var depth = 1u;
    var q = pc0 + 1u;
    loop {
        if (q >= ZIL_MEM_P) { break; }
        let o = bff_op(mem_read(q));
        if (o == 9u) { depth = depth + 1u; }
        else if (o == 10u) {
            depth = depth - 1u;
            if (depth == 0u) { bff_ip = q; return; }
        }
        q = q + 1u;
    }
    bff_unmatched();
}

// ']' with a non-zero byte under head 0: jump back to the matching '[' (backward scan, down to position 0).
fn bff_close(pc0: u32) {
    var depth = 1u;
    var q = pc0;
    loop {
        if (q == 0u) { break; }
        q = q - 1u;
        let o = bff_op(mem_read(q));
        if (o == 10u) { depth = depth + 1u; }
        else if (o == 9u) {
            depth = depth - 1u;
            if (depth == 0u) { bff_ip = q; return; }
        }
    }
    bff_unmatched();
}

// The literal push (op 11, param literal): the two bytes after the op are instruction stream; lit_rep times, head 1
// moves down by two and they are written at head 1 + 1 and head 1; the pointer skips them.
fn bff_literal(pc0: u32) {
    let p1 = (pc0 + 1u) % ZIL_MEM_P;
    let p2 = (pc0 + 2u) % ZIL_MEM_P;
    ${fetch("p1")}let v1 = mem_read(p1);
    ${fetch("p2")}let v2 = mem_read(p2);
    for (var r = 0u; r < ZIL_PARAM_LIT_REP; r = r + 1u) {
        bff_h1 = (bff_h1 + ZIL_MEM_P - 2u) % ZIL_MEM_P;
        mem_write((bff_h1 + 1u) % ZIL_MEM_P, v1);
        mem_write(bff_h1, v2);
    }
    bff_ip = bff_ip + 2u;
}

fn bff_step() {
    if (bff_halted != 0u) { return; }
    let pc0 = bff_ip;
${h.fetch ? "    on_fetch(pc0);\n" : ""}    let b = mem_read(pc0);
${h.instructionStart ? `    let act = on_instruction_start(pc0, b);
    if (act == ZIL_HALT) { bff_halted = ZIL_HALT_HOST; return; }
    if (act != ZIL_SKIP) {
` : "    {\n"}        let op = bff_op(b);
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
                case 9u: { if (mem_read(bff_h0) == 0u) { bff_open(pc0); } }
                case 10u: { if (mem_read(bff_h0) != 0u) { bff_close(pc0); } }
                case 11u: { if (ZIL_PARAM_LITERAL) { bff_literal(pc0); } }
                default: {}
            }
            if (bff_halted != 0u) { return; }   // an unmatched bracket halted: the pointer stays on it
        }
    }
    bff_ip = bff_ip + 1u;
    if (bff_ip >= ZIL_MEM_P) {   // left the tape
        ${trap("BOUNDS", "bff_ip = bff_ip % ZIL_MEM_P;", "        ")}
    }
}
`;
}

export const bff: IsaCore = {
  id: "bff",
  name: "BFF (Brainfuck family, ring-native tape machine)",
  coreVersion: "1.0.0",
  status: "stable",
  addressBits: 0,
  fetchUnitBytes: 1,
  endianness: "little",
  state: STATE,
  internals: [],
  symbols: {
    step: "bff_step",
    haltReason: "bff_halted",
    pc: "bff_ip",
    trapCause: "select(0u, bff_trap, bff_halted == ZIL_HALT_TRAP)", // the cause only of a halt on a trap
  },
  hooks: ["fetch", "instructionStart", "trap"],
  decode: {
    fn: "on_decode",
    params: ["page", "key"],
    defaultLayout: "ops",
    layouts: {
      ops: {
        pages: [{ id: 0, name: "ops", keyBits: 4 }],
        pageExpr: "page",
        keyExpr: "key",
        description: "One page of op ids, after the alphabet (0 no-op, 1..10 < > { } + - . , [ ], 11 the literal push).",
      },
    },
    skip:
      "One byte: the op is a no-op (a skipped literal push does not skip its two bytes, which then run as code). " +
      "Bracket scans still match an ablated bracket.",
  },
  conventions: {
    step:
      "One op, including a whole bracket scan and every write of a literal push; a no-op byte is a step. The bounds " +
      "check is at the end of the step, so steps equal bff.py's `executed`.",
    stackTop: null,
    firstPushAt: null,
    entry: (pos) => ({ ip: pos }),
    traps: { bounds: "halt", unmatched: "halt" },
    halting:
      "No halt instruction. The instruction pointer leaving the ring ends the encounter (trap 'bounds', ip = P, or P + 1 " +
      "or P + 2 after a literal push); an unmatched bracket ends it (trap 'unmatched', ip on the bracket). Both are " +
      "world-policy traps: 'ignore' wraps the pointer modulo P (bff.py ip_wrap) or makes the bracket a no-op (nohalt).",
    illegal: "None: bytes the alphabet maps to 0 (and op 11 without the literal) are no-ops.",
  },
  variants: { cubff: "cubff bff.inc.h semantics, as Algocell's experiments/micro/bff.py implements them." },
  defaultVariant: "cubff",
  compat: ["bff.py"],
  params: {
    alphabet: {
      type: "table",
      length: 256,
      max: 11,
      default: BFF_ASCII,
      description:
        "byte -> op id (0 no-op, 1..10 < > { } + - . , [ ], 11 literal push); bff.py's `alphabet`. Default: the ASCII " +
        "map; BFF_ASCII_LITERAL adds 'P'; a density map is passed as its table.",
    },
    literal: { type: "bool", default: false, description: "op 11 is the literal push (bff.py `literal`); requires an op-11 byte in the alphabet" },
    lit_rep: { type: "u32", default: 1, description: "times the literal push writes its two bytes (bff.py `lit_rep`); 1 is the published switch" },
  },
  wgsl(o) {
    if ((o.variant ?? "cubff") !== "cubff") throw new Error(`bff: unknown variant '${o.variant}'`);
    if ((o.compat ?? "bff.py") !== "bff.py") throw new Error(`bff: unknown compat '${o.compat}'`);
    checkParams(o.params ?? { alphabet: BFF_ASCII, literal: false, lit_rep: 1 });
    return text(o);
  },
};
