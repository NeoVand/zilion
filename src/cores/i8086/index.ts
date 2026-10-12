import type { IsaCore, StateField } from "../../contract/isa.js";
import { i8086CoreText } from "./core.wgsl.js";
export { i8086CoreText };
export type { I8086Hooks } from "./core.wgsl.js";
const registers = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const segments = ["es", "cs", "ss", "ds"];
const state: StateField[] = [
  ...registers.map((name, n) => ({ name, bits: 16, wgsl: `i8086_r[${n}]`, randomizable: n !== 4 })),
  ...segments.map((name, n) => ({ name, bits: 16, wgsl: `i8086_s[${n}]` })),
  { name: "ip", bits: 16, wgsl: "i8086_ip" },
  { name: "flags", bits: 16, wgsl: "i8086_flags", reset: 0xf002, note: "Raw init may contain impossible reserved bits; PUSHF/INT read bits3/5 clear, bit1 and bits12..15 set. POPF/IRET normalize stored flags." },
  { name: "halted", bits: 8, wgsl: "i8086_halted" },
  { name: "trap", bits: 8, wgsl: "i8086_trap" },
  ...["rep", "rep_op", "rep_seg", "rep_start", "rep_end", "rep_first", "rep_interrupt_ip"].map(name => ({ name, bits: 16, wgsl: `i8086_${name}` })),
];
/** 8088 bus writes the low byte at SS:SP-2 first, then the high byte at SS:(SP-1) (offset wraps at 16 bits). */
export function i8086FirstPushAt(P: number, t: number): { sp: number } {
  for (let a = 0xffff; a >= 0; a--) if (a % P === t) return { sp: (a + 2) & 0xffff };
  throw new Error(`i8086: no SS=0 stack offset aliases ${t} on ring ${P}`);
}
export const i8086: IsaCore = {
  id: "i8086", name: "Intel 8086/8088 (real mode)", coreVersion: "0.3.0", status: "skeleton",
  addressBits: 20, fetchUnitBytes: 1, endianness: "little", state, internals: ["i8086_tf_suppress"],
  symbols: { step: "i8086_step", haltReason: "i8086_halted", pc: "i8086_pc()",
    trapCause: "select(0u, i8086_trap, i8086_halted == ZIL_HALT_TRAP || i8086_halted == ZIL_HALT_INSN)" },
  hooks: ["fetch", "instructionStart", "trap", "io"],
  decode: { fn: "on_decode", params: ["page", "key"], defaultLayout: "opcode",
    layouts: { opcode: { pages: [{ id: 0, name: "opcode", keyBits: 8 }], pageExpr: "page", keyExpr: "key",
      description: "Final opcode byte after segment/LOCK/REP prefixes." } },
    skip: "Prefixes and opcode only; ModRM, displacement and immediate bytes run as code." },
  conventions: {
    step: "One instruction or one REP string iteration. Prefixes belong to their instruction; a full segment of prefixes raises bounds. REP continuation uses saved decode state.",
    firstPushAt: i8086FirstPushAt,
    stackTop(P, t) { for (let sp = 0xffff; sp >= 0; sp--) if (sp % P === t) return { sp }; throw new Error("i8086: stack offset unavailable"); },
    entry(pos) { if (pos > 0xffff) throw new Error("i8086: entry must fit CS=0 IP"); return { ip: pos }; },
    traps: { "halt-insn": "halt", "div-zero": "vector", syscall: "vector", bounds: "halt", unimplemented: "halt" },
    halting: "HLT sets halt-insn, IP past HLT; software interrupts and divide errors vector through 0000:0000. No external IRQ/NMI device. Host halt parks IP on first prefix.",
    illegal: "8086 aliases execute as hardware; unsupported forms raise unimplemented and halt. No 80186 instructions.",
  },
  variants: { nmos: "8088 NMOS instruction semantics, including hardware undefined flags." }, defaultVariant: "nmos", compat: ["0.3"],
  params: { prefetch: { type: "enum", values: ["none", "8088"], default: "none",
    description: "Architectural fetch ('none'); '8088' is reserved and rejected until cycle/queue validation is implemented. No paper default is selected." } },
  wgsl(o) {
    if (o.variant !== undefined && o.variant !== "nmos") throw new Error(`i8086: unknown variant '${o.variant}'`);
    if (o.compat !== undefined && o.compat !== "0.3") throw new Error(`i8086: unknown compat '${o.compat}'`);
    if (o.params?.prefetch === "8088") throw new Error("i8086: prefetch '8088' is not implemented or validated; this skeleton is not ready for registered soup experiments");
    return i8086CoreText(o.hooks);
  },
};
