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
  id: "i8086", name: "8086/8088 instruction semantics, validated against hardware 8088 vectors, with coherent fetch", coreVersion: "0.3.0", status: "experimental",
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
    illegal: "8086 undocumented aliases execute, including 60-6F Jcc, C0/C1/C8/C9 RET, F1 LOCK, SETMO/SETMOC, F6/F7 /1 TEST and FF /7 PUSH. No 80186 decoding. Register LEA/LES/LDS raise unimplemented after ModRM. Register FE/FF far CALL/JMP use the deterministic zero-ea policy: effective offset zero, register destination, memory-fed segment; no hidden history. Other unsupported forms raise unimplemented. These are declared abstractions, not hardware-certified hidden-state behaviour.",
  },
  variants: { nmos: "8086/8088 instruction semantics, validated against hardware 8088 vectors, with coherent fetch; hardware undefined flags and declared zero-ea hidden-latch abstraction." }, defaultVariant: "nmos", compat: ["0.3"],
  params: { prefetch: { type: "enum", values: ["coherent", "8088"], default: "coherent",
    description: "Every consumed opcode, prefix and operand byte is read from current memory, without a prefetch queue. REP retains its decoded operation across iterations. Deliberate paper abstraction; 8088 queue requests are rejected." },
    hidden_latch: { type: "enum", values: ["zero_ea"], default: "zero_ea",
      description: "Register LEA/LES/LDS trap; register FE/FF far transfers substitute effective offset zero, never history or uninitialized state. See docs/I8086.md." } },
  wgsl(o) {
    if (o.variant !== undefined && o.variant !== "nmos") throw new Error(`i8086: unknown variant '${o.variant}'`);
    if (o.compat !== undefined && o.compat !== "0.3") throw new Error(`i8086: unknown compat '${o.compat}'`);
    if (o.params?.prefetch === "8088") throw new Error("i8086: prefetch '8088' is not implemented or validated; select 'coherent' (the paper's deliberate no-queue abstraction)");
    return i8086CoreText(o.hooks);
  },
};
