// MOS 6502 (NMOS) — SKELETON core. It exists to validate the IsaCore contract against a second, differently shaped
// CPU before the contract is frozen; it implements a handful of opcodes and traps on every other one. Do not use it
// for results. The full core (all 151 documented opcodes, the NMOS undocumented ones with pinned constants, decimal
// mode, SingleStepTests/65x02 conformance) is milestone M2; docs/ADDING_A_CORE.md lists what it needs.
//
// Contract points this core exercises that the Z80 does not:
//   - a stack fixed in page 1 (0x0100 | S, 8-bit S, push writes then decrements): the stack-top convention picks
//     the S that makes 0x0100 | S alias the requested ring position;
//   - a vector read through the top of the address space (BRK reads 0xFFFE/0xFFFF: on a small ring these are
//     ordinary positions 65534 mod P and 65535 mod P);
//   - illegal opcodes that halt the chip (NMOS JAM), routed through zil_trap as cause `illegal`;
//   - a non-zero reset value in the state (P = 0x24: bit 5 always reads 1, I set);
//   - the generic decode hook name `on_decode(page, key)` with one page.

import { TRAP_CAUSES } from "../../contract/host.js";
import type { CoreGenOptions, IsaCore, StateField } from "../../contract/isa.js";

const STATE: readonly StateField[] = [
  { name: "a", bits: 8, wgsl: "m6502_a", randomizable: true },
  { name: "x", bits: 8, wgsl: "m6502_x", randomizable: true },
  { name: "y", bits: 8, wgsl: "m6502_y", randomizable: true },
  { name: "s", bits: 8, wgsl: "m6502_s" },
  { name: "p", bits: 8, wgsl: "m6502_p", reset: 0x24, note: "NV-BDIZC; bit 5 reads 1" },
  { name: "pc", bits: 16, wgsl: "m6502_pc" },
  { name: "halted", bits: 8, wgsl: "m6502_halted", note: "0 running; 2 host; 3 trap (JAM or an unimplemented opcode)" },
  { name: "trap", bits: 8, wgsl: "m6502_trap", note: "TRAP_CAUSES code of the trap that halted the core (illegal, unimplemented); 0 otherwise" },
];

/**
 * `init.stack.firstPushAt: t`: a push writes 0x0100 | S, then decrements S, so the first byte lands at t when
 * 0x0100 | S aliases t (the largest such S).
 */
export function m6502FirstPushAt(P: number, t: number): { s: number } {
  for (let s = 0xff; s >= 0; s--) if ((0x100 + s) % P === t) return { s };
  throw new Error(`m6502: no stack pointer makes 0x0100|S alias position ${t} of ${P} (P > 256)`);
}

const JAM = [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2];

function text(o: CoreGenOptions): string {
  const h = o.hooks;
  const fetchHook = h.fetch ? "    on_fetch(m6502_pc);\n" : "";
  const start = h.instructionStart
    ? `    let act = on_instruction_start(pc0, op);
    if (act == ZIL_HALT) { m6502_halted = ZIL_HALT_HOST; m6502_pc = pc0; return; }
    if (act == ZIL_SKIP) { return; }
`
    : "";
  // A trap: with the hook, the world decides (ZIL_TRAP_IGNORE continues after the opcode byte); without it the
  // chip halts with PC on the opcode.
  const trap = (cause: keyof typeof TRAP_CAUSES) =>
    h.trap
      ? `if (zil_trap(ZIL_TRAP_${cause.toUpperCase()}) != ZIL_TRAP_IGNORE) { m6502_halted = ZIL_HALT_TRAP; m6502_trap = ZIL_TRAP_${cause.toUpperCase()}; m6502_pc = pc0; }`
      : `m6502_halted = ZIL_HALT_TRAP; m6502_trap = ZIL_TRAP_${cause.toUpperCase()}; m6502_pc = pc0;`;
  return /* wgsl */ `
// === MOS 6502 (NMOS) — SKELETON: a handful of opcodes; every other opcode traps as 'unimplemented' ===
var<private> m6502_a: u32;
var<private> m6502_x: u32;
var<private> m6502_y: u32;
var<private> m6502_s: u32;
var<private> m6502_p: u32;
var<private> m6502_pc: u32;
var<private> m6502_halted: u32;
var<private> m6502_trap: u32;   // the trap cause that halted the core (symbols.trapCause)
const M6502_ADDR_MASK: u32 = 0xffffu;

fn m6502_fetch() -> u32 {
${fetchHook}    let v = mem_read(m6502_pc);
    m6502_pc = (m6502_pc + 1u) & 0xffffu;
    return v;
}
fn m6502_fetch16() -> u32 { let lo = m6502_fetch(); let hi = m6502_fetch(); return (hi << 8u) | lo; }
fn m6502_push(v: u32) { mem_write(0x100u | m6502_s, v & 0xffu); m6502_s = (m6502_s - 1u) & 0xffu; }  // page 1
fn m6502_pull() -> u32 { m6502_s = (m6502_s + 1u) & 0xffu; return mem_read(0x100u | m6502_s); }
fn m6502_nz(v: u32) { m6502_p = (m6502_p & 0x7du) | (v & 0x80u) | select(0u, 0x02u, v == 0u); }

fn m6502_step() {
    if (m6502_halted != 0u) { return; }
    let pc0 = m6502_pc;
    let op = m6502_fetch();
${start}    if (on_decode(0u, op)) { return; }   // ablated: a 1-byte no-op; operand bytes run as code
    switch (op) {
        case 0xa9u: { m6502_a = m6502_fetch(); m6502_nz(m6502_a); }                          // LDA #
        case 0xa2u: { m6502_x = m6502_fetch(); m6502_nz(m6502_x); }                          // LDX #
        case 0xa0u: { m6502_y = m6502_fetch(); m6502_nz(m6502_y); }                          // LDY #
        case 0x85u: { mem_write(m6502_fetch(), m6502_a); }                                   // STA zp
        case 0x8du: { mem_write(m6502_fetch16(), m6502_a); }                                 // STA abs
        case 0xe8u: { m6502_x = (m6502_x + 1u) & 0xffu; m6502_nz(m6502_x); }                // INX
        case 0x48u: { m6502_push(m6502_a); }                                                 // PHA
        case 0x68u: { m6502_a = m6502_pull(); m6502_nz(m6502_a); }                           // PLA
        case 0x4cu: { m6502_pc = m6502_fetch16(); }                                          // JMP abs
        case 0xeau: {}                                                                       // NOP
        case 0x00u: {                                                                        // BRK
            m6502_fetch();                                                                   // signature byte
            m6502_push(m6502_pc >> 8u);
            m6502_push(m6502_pc & 0xffu);
            m6502_push(m6502_p | 0x30u);                                                     // B and bit 5 set
            m6502_p = m6502_p | 0x04u;                                                       // I
            m6502_pc = mem_read(0xfffeu) | (mem_read(0xffffu) << 8u);                        // vector: top of the ring
        }
        case ${JAM.map((j) => `0x${j.toString(16)}u`).join(", ")}: { ${trap("illegal")} }   // JAM
        default: { ${trap("unimplemented")} }
    }
}
`;
}

export const m6502: IsaCore = {
  id: "m6502",
  name: "MOS 6502 (NMOS) — skeleton",
  coreVersion: "0.0.0-skeleton",
  status: "skeleton",
  addressBits: 16,
  fetchUnitBytes: 1,
  endianness: "little",
  state: STATE,
  internals: [],
  symbols: { step: "m6502_step", haltReason: "m6502_halted", pc: "m6502_pc", trapCause: "m6502_trap" },
  hooks: ["fetch", "instructionStart", "trap"],
  decode: {
    fn: "on_decode",
    params: ["page", "key"],
    defaultLayout: "opcode",
    layouts: {
      opcode: { pages: [{ id: 0, name: "opcode", keyBits: 8 }], pageExpr: "page", keyExpr: "key", description: "One 256-bit page: the opcode byte." },
    },
    skip: "The opcode byte only; operand bytes run as code.",
  },
  conventions: {
    step: "One instruction (BRK is one step).",
    stackTop: (P, t) => {
      for (let s = 0xff; s >= 0; s--) if ((0x100 + s) % P === t) return { s };
      throw new Error(`m6502: no stack pointer makes 0x0100|S alias position ${t} of ${P} (P > 256)`);
    },
    firstPushAt: m6502FirstPushAt,
    entry: (pos) => {
      if (pos < 0 || pos > 0xffff) throw new Error(`m6502: entry position ${pos} is not a 16-bit address`);
      return { pc: pos };
    },
    traps: { illegal: "halt", unimplemented: "halt" },
    halting: "No halt instruction; NMOS JAM opcodes lock the chip (trap 'illegal', as-chip halt, PC on the opcode).",
    illegal: "NMOS: 12 JAM opcodes trap; the other undocumented opcodes are not in this skeleton (trap 'unimplemented').",
  },
  variants: { nmos: "NMOS 6502 (skeleton)." },
  defaultVariant: "nmos",
  compat: ["skeleton"],
  wgsl(o) {
    if ((o.variant ?? "nmos") !== "nmos") throw new Error(`m6502: unknown variant '${o.variant}'`);
    if ((o.compat ?? "skeleton") !== "skeleton") throw new Error(`m6502: unknown compat '${o.compat}'`);
    return text(o);
  },
};
