// The MOS 6502 (NMOS) behind the IsaCore contract: all 256 opcodes (151 documented, 105 undocumented), validated
// per instruction against SingleStepTests/65x02 `6502/v1` (test/baselines/6502-v0.3.0-dev.md). The core text and
// the list of NMOS behaviours a soup can observe are in ./core.wgsl.ts.
//
// Contract points this core exercises that the Z80 does not:
//   - a stack fixed in page 1 (0x0100 | S, 8-bit S, a push writes then decrements): the stack-top convention picks
//     the S that makes 0x0100 | S alias the requested ring position, so the first push lands there;
//   - a vector read through the top of the address space (BRK reads 0xFFFE/0xFFFF: on a small ring these are
//     ordinary positions 65534 mod P and 65535 mod P);
//   - illegal opcodes that halt the chip (NMOS JAM), routed through zil_trap as cause `illegal`;
//   - read-modify-write instructions that write twice (the old value, then the new one);
//   - the generic decode hook name `on_decode(page, key)` with one page.

import type { IsaCore, StateField } from "../../contract/isa.js";
import { m6502CoreText, M6502_CORE_WGSL, M6502_JAM_OPCODES, M6502_UNSTABLE } from "./core.wgsl.js";

export { m6502CoreText, M6502_CORE_WGSL, M6502_JAM_OPCODES, M6502_UNSTABLE };
export type { M6502Hooks } from "./core.wgsl.js";

const STATE: readonly StateField[] = [
  { name: "a", bits: 8, wgsl: "m6502_a", randomizable: true },
  { name: "x", bits: 8, wgsl: "m6502_x", randomizable: true },
  { name: "y", bits: 8, wgsl: "m6502_y", randomizable: true },
  { name: "s", bits: 8, wgsl: "m6502_s" },
  {
    name: "p",
    bits: 8,
    wgsl: "m6502_p",
    reset: 0x20,
    note: "N V 1 B D I Z C. Bit 5 reads 1; B and bit 5 are pushed as 1 by PHP/BRK whatever is stored, PLP/RTI store B = 0, bit 5 = 1",
  },
  { name: "pc", bits: 16, wgsl: "m6502_pc", note: "parked on the JAM opcode while halted by it" },
  { name: "halted", bits: 8, wgsl: "m6502_halted", note: "0 running; 2 host; 3 trap (JAM)" },
];

/**
 * The MOS 6502, NMOS. Every byte decodes; the 12 JAM opcodes raise trap `illegal`, which halts the lane as-chip.
 * Addresses are 16-bit and every multi-byte access is decomposed into byte accesses.
 */
export const m6502: IsaCore = {
  id: "m6502",
  name: "MOS 6502 (NMOS)",
  coreVersion: "0.3.0",
  status: "experimental",
  addressBits: 16,
  fetchUnitBytes: 1,
  endianness: "little",
  state: STATE,
  internals: [],
  symbols: { step: "m6502_step", haltReason: "m6502_halted", pc: "m6502_pc" },
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
    step: "One instruction (BRK and JSR are one step each). A halted lane takes no further steps.",
    stackTop: (P, t) => {
      for (let s = 0xff; s >= 0; s--) if ((0x100 + s) % P === t) return { s };
      throw new Error(`m6502: no stack pointer makes 0x0100|S alias position ${t} of ${P} (P > 256)`);
    },
    entry: (pos) => {
      if (pos < 0 || pos > 0xffff) throw new Error(`m6502: entry position ${pos} is not a 16-bit address`);
      return { pc: pos };
    },
    traps: { illegal: "halt" },
    halting:
      "No halt instruction. The 12 NMOS JAM opcodes (02 12 22 32 42 52 62 72 92 B2 D2 F2) raise trap 'illegal': " +
      "as-chip the lane halts (halted = 3, reason trap) with PC parked on the opcode; policy 'ignore' makes JAM a " +
      "1-byte no-op. A host halt from on_instruction_start sets halted = 2 with PC on the opcode (reason host). " +
      "There is no IRQ or NMI line: I only changes the P byte that PHP and BRK push.",
    illegal:
      "Every other undocumented NMOS opcode executes as the chip does (SingleStepTests 6502/v1): LAX SAX DCP ISC SLO " +
      "RLA SRE RRA ANC ALR ARR SBX, SBC # (EB), the 1-, 2- and 3-byte NOPs (which read their operand), and the " +
      "unstable ANE and LXA (magic 0xEE), SHA SHX SHY TAS (value & (H + 1); a page crossing replaces the target's " +
      "high byte with the value) and LAS. Read-modify-write instructions write the old value, then the new one, " +
      "so each counts two writes.",
  },
  variants: {
    nmos:
      "NMOS 6502 as in SingleStepTests 6502/v1: NMOS decimal mode, JMP ($xxFF) page wrap, JAM halts, unstable " +
      "opcodes with ANE/LXA magic 0xEE.",
  },
  defaultVariant: "nmos",
  compat: ["0.3"],
  wgsl(o) {
    const variant = o.variant ?? this.defaultVariant;
    if (!(variant in this.variants)) throw new Error(`m6502: unknown variant '${variant}'`);
    const compat = o.compat ?? this.compat[0];
    if (!this.compat.includes(compat)) throw new Error(`m6502: unknown compat '${compat}' (known: ${this.compat.join(", ")})`);
    return m6502CoreText({ fetch: !!o.hooks.fetch, instructionStart: !!o.hooks.instructionStart, trap: !!o.hooks.trap });
  },
};
