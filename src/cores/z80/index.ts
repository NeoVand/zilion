// The Zilog Z80 behind the IsaCore contract.

import { highestAlias } from "../../contract/address.js";
import type { IsaCore, StateField } from "../../contract/isa.js";
import { z80CoreText, Z80_CORE_WGSL } from "./core.wgsl.js";

export { z80CoreText, Z80_CORE_WGSL };
export type { Z80Hooks } from "./core.wgsl.js";

const r8 = (name: string, wgsl: string): StateField => ({ name, bits: 8, wgsl, randomizable: true });

/** State record of the Z80, in record order (one u32 per field). */
const STATE: readonly StateField[] = [
  r8("a", "cpu_a"),
  r8("f", "cpu_f"),
  r8("b", "cpu_b"),
  r8("c", "cpu_c"),
  r8("d", "cpu_d"),
  r8("e", "cpu_e"),
  r8("h", "cpu_h"),
  r8("l", "cpu_l"),
  r8("a_", "cpu_a2"),
  r8("f_", "cpu_f2"),
  r8("b_", "cpu_b2"),
  r8("c_", "cpu_c2"),
  r8("d_", "cpu_d2"),
  r8("e_", "cpu_e2"),
  r8("h_", "cpu_h2"),
  r8("l_", "cpu_l2"),
  { name: "ix", bits: 16, wgsl: "cpu_ix", randomizable: true },
  { name: "iy", bits: 16, wgsl: "cpu_iy", randomizable: true },
  { name: "sp", bits: 16, wgsl: "cpu_sp" },
  { name: "pc", bits: 16, wgsl: "cpu_pc", note: "parked on the HALT opcode while halted" },
  { name: "i", bits: 8, wgsl: "cpu_i" },
  { name: "r", bits: 8, wgsl: "cpu_r", note: "bits 0-6 count M1 fetches; a wasted DD/FD prefix adds 2 (0.2 semantics)" },
  { name: "iff1", bits: 1, wgsl: "cpu_iff1" },
  { name: "iff2", bits: 1, wgsl: "cpu_iff2" },
  { name: "halted", bits: 8, wgsl: "cpu_halted", note: "0 running; 1 HALT; 2 halted by the host; see haltReason" },
];

/**
 * `init.stack.firstPushAt: t`. PUSH and CALL pre-decrement SP, so the first byte lands at SP − 1 (16-bit): SP is
 * one above the highest address that aliases t (SP = 0x0000 when that address is 0xFFFF).
 */
export function z80FirstPushAt(P: number, t: number): { sp: number } {
  return { sp: (highestAlias(t, P, 16) + 1) & 0xffff };
}

const FINE_PAGE_EXPR =
  "select(select(select(select(select(select(0u, 1u, prefix == 0xcbu), 2u, prefix == 0xedu), 3u, prefix == 0xddu), " +
  "4u, prefix == 0xfdu), 5u, prefix == 0xddcbu), 6u, prefix == 0xfdcbu)";

/**
 * The Z80 (Zilion 0.2 semantics). Every byte decodes; the only native halt is HALT (76), which parks PC on the
 * opcode. Addresses are 16-bit and every multi-byte access is decomposed into byte accesses.
 */
export const z80: IsaCore = {
  id: "z80",
  name: "Zilog Z80",
  coreVersion: "0.2.0",
  status: "stable",
  addressBits: 16,
  fetchUnitBytes: 1,
  endianness: "little",
  state: STATE,
  internals: ["idx_mode", "idx_disp", "idx_uses_mem"],
  symbols: {
    step: "z80_step",
    haltReason: "cpu_halted",
    pc: "cpu_pc",
    // HALT (as-chip or by a trap policy) is the only trap that halts the Z80; it leaves halted = 1.
    trapCause: "select(0u, ZIL_TRAP_HALT_INSN, cpu_halted == 1u)",
  },
  hooks: ["fetch", "instructionStart", "trap", "io"],
  decode: {
    fn: "on_fetch_opcode",
    params: ["prefix", "op"],
    defaultLayout: "coarse",
    layouts: {
      coarse: {
        pages: [
          { id: 0, name: "base", keyBits: 8 },
          { id: 1, name: "cb", keyBits: 8 },
          { id: 2, name: "ed", keyBits: 8 },
        ],
        pageExpr: "select(select(0u, 2u, prefix == 0xedu), 1u, prefix == 0xcbu || prefix == 0xddcbu || prefix == 0xfdcbu)",
        keyExpr: "op",
        description:
          "Three 256-bit pages (Algocell's layout): DD/FD forms follow the base page, DDCB/FDCB follow the CB page.",
      },
      fine: {
        pages: [
          { id: 0, name: "base", keyBits: 8 },
          { id: 1, name: "cb", keyBits: 8 },
          { id: 2, name: "ed", keyBits: 8 },
          { id: 3, name: "dd", keyBits: 8 },
          { id: 4, name: "fd", keyBits: 8 },
          { id: 5, name: "ddcb", keyBits: 8 },
          { id: 6, name: "fdcb", keyBits: 8 },
        ],
        pageExpr: FINE_PAGE_EXPR,
        keyExpr: "op",
        description: "Seven 256-bit pages, one per prefix form.",
      },
    },
    skip:
      "Prefix(es) plus opcode, never operands: a base-page opcode is a 1-byte no-op (its operands run as code), " +
      "CB/ED-page opcodes 2 bytes, DDCB/FDCB 4 bytes; R counts as for a real fetch.",
  },
  conventions: {
    step:
      "One instruction; one iteration of a block repeat (LDIR, CPIR, INIR, OTIR and their decrementing forms); " +
      "a wasted DD/FD prefix (followed by DD, FD or ED). A halted lane takes no further steps.",
    stackTop: (P, t) => ({ sp: highestAlias(t, P, 16) }),
    firstPushAt: z80FirstPushAt,
    entry: (pos) => {
      if (pos < 0 || pos > 0xffff) throw new Error(`z80: entry position ${pos} is not a 16-bit address`);
      return { pc: pos };
    },
    traps: { "halt-insn": "halt" },
    halting:
      "HALT (76) sets halted = 1 and parks PC on the opcode (reason halt-insn). A host halt from " +
      "on_instruction_start sets halted = 2 and backs PC onto the byte (reason host).",
    illegal: "None: every byte decodes (undefined ED opcodes are 2-byte no-ops).",
  },
  variants: { classic: "Zilion 0.2 semantics: no MEMPTR (WZ), IM ignored, IN reads 0 and OUT is a no-op by default." },
  defaultVariant: "classic",
  compat: ["0.2"],
  wgsl(o) {
    const variant = o.variant ?? this.defaultVariant;
    if (!(variant in this.variants)) throw new Error(`z80: unknown variant '${variant}'`);
    const compat = o.compat ?? this.compat[0];
    if (!this.compat.includes(compat)) throw new Error(`z80: unknown compat '${compat}' (known: ${this.compat.join(", ")})`);
    return z80CoreText({
      fetch: !!o.hooks.fetch,
      instructionStart: !!o.hooks.instructionStart,
      trap: !!o.hooks.trap,
      io: !!o.hooks.io,
    });
  },
};
