// Zilion Z80 core (WGSL), host contract v2.
//
// `z80CoreText(hooks, { compat, variant })` generates the core text:
//   compat '0.3' (the default)  the current semantics, below;
//   compat '0.2'                the frozen 0.2 text (./core-0.2.wgsl.ts): with every hook off it is the 0.2.0 core
//                               byte for byte (`Z80_CORE_WGSL`, scripts/check-byte-identity.mjs).
// Each opt-in hook adds text only at a fixed insertion point and never edits the anchors Algocell patches
// (docs/ARCHITECTURE.md, "Anchors"); they occur exactly once in every configuration.
//
// Semantics 0.3, beyond 0.2 (design §5.2–§5.4, validated on SingleStepTests/z80 and the analytic probes):
//   - R: a wasted DD/FD prefix (followed by DD, FD or ED) is one M1, so R + 1 (0.2 counted the follower twice);
//   - MEMPTR (WZ) in full (cpu_wz), and BIT n,(HL) takes F3/F5 from WZ bits 11 and 13;
//   - the interrupt mode (cpu_im) is set by IM 0/1/2 and their mirrors (no interrupts are modelled);
//   - block repeats: a repeating LDIR/LDDR/CPIR/CPDR/INIR/INDR/OTIR/OTDR takes X/Y from PC bits 11/13, and the block
//     I/O forms also adjust H and P/V; WZ = PC + 1 on a repeat;
//   - OUT (C),r and OUT (C),0 exist without the io hooks (they set WZ); IN reads 0 and OUT is a no-op unless the io
//     hooks are enabled;
//   - halt reasons: cpu_halted is Z80_HALT_INSN (HALT) or Z80_HALT_HOST (on_instruction_start); a lane halted by HALT
//     keeps executing it (R + 1 per step), a lane halted by the host is frozen;
//   - z80_reset() (the world reset: everything 0) and z80_run(budget).
// Variant 'zilog-nmos' adds the Q latch (cpu_q): Q = F after an instruction that writes F, else 0, and SCF/CCF take
// X/Y from ((Q ^ F) | A), Q being the latch as the step began. Vendor-specific (Zilog NMOS), so not the default. It
// adds statements inside the same functions (no wrapper), so z80_step holds the anchors in every configuration.

import { Z80_CORE_WGSL, z80CoreText02 } from "./core-0.2.wgsl.js";

/** Host-contract-v2 hooks the generated Z80 core calls. All off: a core that needs only mem_read, mem_write and on_fetch_opcode. */
export interface Z80Hooks {
  /** `on_fetch(addr)` for every instruction-stream byte (opcode, prefix, operand, displacement), before it is read. */
  fetch?: boolean;
  /**
   * `on_instruction_start(pc, unit) -> u32` once per step, after the first byte is fetched and its M1 counted
   * (R already incremented), before DD/FD resolution and before the decode hook. `ZIL_HALT` halts the lane with
   * `cpu_halted = ZIL_HALT_HOST` and PC backed onto the byte; `ZIL_SKIP` consumes that one byte as a no-op.
   */
  instructionStart?: boolean;
  /** `zil_trap(ZIL_TRAP_HALT_INSN)` when HALT executes; `ZIL_TRAP_IGNORE` turns HALT into a 1-byte no-op. */
  trap?: boolean;
  /** `io_in(port) -> u32` and `io_out(port, val)` for IN/OUT and block I/O. */
  io?: boolean;
}

/** Semantics of the generated text: `compat` selects historical semantics, `variant` vendor-specific behaviour. */
export interface Z80Semantics {
  /** '0.3' (default): the current semantics. '0.2': the frozen 0.2 text. */
  compat?: "0.3" | "0.2";
  /** 'classic' (default) or 'zilog-nmos' (the Q latch; compat '0.3' only). */
  variant?: "classic" | "zilog-nmos";
}

export const Z80_COMPAT = ["0.3", "0.2"] as const;
export const Z80_VARIANTS = ["classic", "zilog-nmos"] as const;

interface HookText {
  fetch: string;
  start: string;
  haltOpen: string;
  haltClose: string;
  /** Body of z80_in(port) -> u32. */
  inBody: string;
  /** Body of z80_out(port, val). */
  outBody: string;
}

/** The instruction-start hook. A host halt executes no instruction: nothing but R (the M1 already happened), PC (backed
 * onto the byte) and halted changes, Q included. A skip consumes the unit as a no-op instruction (zilog-nmos: Q = 0). */
const startHook = (nmos: boolean) =>
  "    // host contract v2: instruction start (raw first byte; R already counted; before prefixes and decode)\n" +
  "    {\n" +
  "        let zil_act = on_instruction_start((cpu_pc + 0xffffu) & 0xffffu, op);\n" +
  "        if (zil_act == ZIL_HALT) { cpu_halted = Z80_HALT_HOST; cpu_pc = (cpu_pc - 1u) & 0xffffu; return; }\n" +
  `        if (zil_act == ZIL_SKIP) {${nmos ? " cpu_q = 0u;" : ""} return; }\n` +
  "    }\n";

/**
 * The Z80 core text with the given hooks and semantics. Needs the host-contract prelude (`HOST_CONTRACT_PRELUDE_WGSL`)
 * when the instructionStart or trap hook is enabled, and always needs `mem_read`, `mem_write` and `on_fetch_opcode`
 * from the host.
 */
export function z80CoreText(hooks: Z80Hooks = {}, semantics: Z80Semantics = {}): string {
  const compat = semantics.compat ?? "0.3";
  const variant = semantics.variant ?? "classic";
  if (!(Z80_COMPAT as readonly string[]).includes(compat)) throw new Error(`z80: unknown compat '${compat}' (known: ${Z80_COMPAT.join(", ")})`);
  if (!(Z80_VARIANTS as readonly string[]).includes(variant)) throw new Error(`z80: unknown variant '${variant}' (known: ${Z80_VARIANTS.join(", ")})`);
  if (compat === "0.2") {
    if (variant !== "classic") throw new Error(`z80: variant '${variant}' needs compat '0.3' (compat '0.2' is the frozen 0.2 text)`);
    return z80CoreText02(hooks);
  }
  const h: HookText = {
    fetch: hooks.fetch ? "    on_fetch(cpu_pc);\n" : "",
    start: hooks.instructionStart ? startHook(variant === "zilog-nmos") : "",
    haltOpen: hooks.trap ? "                if (zil_trap(ZIL_TRAP_HALT_INSN) != ZIL_TRAP_IGNORE) {\n" : "",
    haltClose: hooks.trap ? "                }\n" : "",
    inBody: hooks.io ? "return io_in(port) & 0xffu;" : "return 0u;",
    outBody: hooks.io ? "io_out(port, val & 0xffu);" : "",
  };
  return template(h, variant === "zilog-nmos");
}

function template(h: HookText, nmos: boolean): string {
  // zilog-nmos: every write of F also latches it into Q (cpu_q = cpu_f); z80_step keeps the latch as the step began
  // in z80_qprev (for SCF/CCF) and clears cpu_q, so an instruction that leaves F alone ends with Q = 0.
  const qf = nmos ? "\n    cpu_q = cpu_f; // Q" : "";
  const qfi = nmos ? " cpu_q = cpu_f;" : "";
  const xyScfCcf = nmos ? "(((z80_qprev ^ cpu_f) | cpu_a) & (F3 | F5))" : "(cpu_a & (F3 | F5))";
  return /* wgsl */ `
// === Z80 CPU State (per invocation) ===
var<private> cpu_a: u32;
var<private> cpu_f: u32;
var<private> cpu_b: u32;
var<private> cpu_c: u32;
var<private> cpu_d: u32;
var<private> cpu_e: u32;
var<private> cpu_h: u32;
var<private> cpu_l: u32;
var<private> cpu_sp: u32;
var<private> cpu_pc: u32;
var<private> cpu_a2: u32;
var<private> cpu_f2: u32;
var<private> cpu_b2: u32;
var<private> cpu_c2: u32;
var<private> cpu_d2: u32;
var<private> cpu_e2: u32;
var<private> cpu_h2: u32;
var<private> cpu_l2: u32;
var<private> cpu_halted: u32;
var<private> cpu_iff1: u32;
var<private> cpu_iff2: u32;
var<private> cpu_ix: u32;
var<private> cpu_iy: u32;
var<private> cpu_i: u32; // interrupt vector register (I)
var<private> cpu_r: u32; // memory refresh register (R); bits 0-6 count M1 cycles, bit 7 preserved
var<private> cpu_wz: u32; // MEMPTR (WZ): internal address latch; visible only through BIT n,(HL) F3/F5
var<private> cpu_im: u32; // interrupt mode 0, 1 or 2 (set by IM; no interrupts are modelled)
${nmos ? `var<private> cpu_q: u32; // Q (Zilog NMOS): F if the last instruction wrote the flags, else 0
var<private> z80_qprev: u32; // Q as the current step began (read by SCF/CCF; set at the start of every step)
` : ""}
// Halt reasons held in cpu_halted. They equal the host contract's ZIL_RUNNING, ZIL_HALT_INSN, ZIL_HALT_HOST and
// ZIL_HALT_TRAP, so that the core text needs no prelude when its hooks are off.
const Z80_RUNNING: u32 = 0u;
const Z80_HALT_INSN: u32 = 1u;
const Z80_HALT_HOST: u32 = 2u;
const Z80_HALT_TRAP: u32 = 3u;

// Increment R once per M1 (opcode/prefix) fetch: 7-bit counter, bit 7 preserved.
fn r_inc() { cpu_r = (cpu_r & 0x80u) | ((cpu_r + 1u) & 0x7fu); }
// Index-prefix state for the instruction currently executing:
//   idx_mode: 0 = HL, 1 = IX, 2 = IY
//   idx_disp: sign-extended displacement for (IX+d)/(IY+d)
//   idx_uses_mem: 1 when this instruction dereferences (IX+d)/(IY+d), which
//     means H/L operands are NOT substituted by IXH/IXL (real Z80 rule).
var<private> idx_mode: u32;
var<private> idx_disp: u32;
var<private> idx_uses_mem: u32;

// HOST CONTRACT: the host shader must declare the following BEFORE this core:
//   fn mem_read(addr: u32) -> u32                      // read one byte from memory
//   fn mem_write(addr: u32, val: u32)                  // write one byte to memory
//   fn on_fetch_opcode(prefix: u32, op: u32) -> bool   // return true to skip (NOP)
//                                                      // the decoded instruction
// The hook fires once per executed instruction, after full prefix resolution, with
//   prefix = 0u       base page            (op = the opcode byte)
//   prefix = 0xddu / 0xfdu  IX / IY form of a base-page opcode (op = the opcode byte)
//   prefix = 0xcbu    CB page              (op = the byte after CB)
//   prefix = 0xedu    ED page              (op = the byte after ED)
//   prefix = 0xddcbu / 0xfdcbu  DDCB / FDCB page (op = the byte after the displacement)
// Prefix bytes themselves (CB, ED, DD, FD) are never reported as op. When the
// hook returns true the opcode byte(s) and prefix are consumed and nothing
// executes: a 1-byte NOP for base-page opcodes (operand bytes are NOT skipped —
// they run as the next instruction, exactly as if the opcode had been removed
// from the ISA), a 2-byte NOP for CB/ED-page opcodes (like undefined ED opcodes
// on a real Z80), and a 4-byte NOP for DDCB/FDCB. R increments as for a real
// fetch; nothing else changes (WZ included). With the opt-in host-contract-v2
// hooks enabled the host also declares on_fetch, on_instruction_start, zil_trap
// and io_in/io_out (see core.wgsl.ts).

// Z80 flag bits
const CF: u32 = 0x01u;
const NF: u32 = 0x02u;
const PF: u32 = 0x04u;
const F3: u32 = 0x08u;
const HF: u32 = 0x10u;
const F5: u32 = 0x20u;
const ZF: u32 = 0x40u;
const SFl: u32 = 0x80u;

// The world reset (not the chip's reset sequence): every register, latch and internal at 0, PC 0, running.
fn z80_reset() {
    cpu_a = 0u; cpu_f = 0u; cpu_b = 0u; cpu_c = 0u; cpu_d = 0u; cpu_e = 0u; cpu_h = 0u; cpu_l = 0u;
    cpu_a2 = 0u; cpu_f2 = 0u; cpu_b2 = 0u; cpu_c2 = 0u; cpu_d2 = 0u; cpu_e2 = 0u; cpu_h2 = 0u; cpu_l2 = 0u;
    cpu_ix = 0u; cpu_iy = 0u; cpu_sp = 0u; cpu_pc = 0u; cpu_i = 0u; cpu_r = 0u; cpu_iff1 = 0u; cpu_iff2 = 0u;
    cpu_wz = 0u; cpu_im = 0u; cpu_halted = Z80_RUNNING;${nmos ? " cpu_q = 0u; z80_qprev = 0u;" : ""}
    idx_mode = 0u; idx_disp = 0u; idx_uses_mem = 0u;
}

// Port I/O: through the host's io_in/io_out with the io hooks; without them there is no device (IN reads 0, OUT
// does nothing).
fn z80_in(port: u32) -> u32 { ${h.inBody} }
fn z80_out(port: u32, val: u32) {${h.outBody ? ` ${h.outBody} ` : ""}}

fn z80_fetch() -> u32 {
${h.fetch}    let val = mem_read(cpu_pc);
    cpu_pc = (cpu_pc + 1u) & 0xffffu;
    return val;
}

fn z80_fetch_word() -> u32 {
    let lo = z80_fetch();
    let hi = z80_fetch();
    return (hi << 8u) | lo;
}

fn z80_push16(val: u32) {
    cpu_sp = (cpu_sp - 1u) & 0xffffu;
    mem_write(cpu_sp, (val >> 8u) & 0xffu);
    cpu_sp = (cpu_sp - 1u) & 0xffffu;
    mem_write(cpu_sp, val & 0xffu);
}

fn z80_pop16() -> u32 {
    let lo = mem_read(cpu_sp);
    cpu_sp = (cpu_sp + 1u) & 0xffffu;
    let hi = mem_read(cpu_sp);
    cpu_sp = (cpu_sp + 1u) & 0xffffu;
    return (hi << 8u) | lo;
}

fn signed_byte(b: u32) -> i32 {
    let sb = i32(b);
    if (sb > 127) { return sb - 256; }
    return sb;
}

// === Register Access ===
fn get_bc() -> u32 { return (cpu_b << 8u) | cpu_c; }
fn get_de() -> u32 { return (cpu_d << 8u) | cpu_e; }
fn get_hl() -> u32 { return (cpu_h << 8u) | cpu_l; }
fn get_af() -> u32 { return (cpu_a << 8u) | cpu_f; }

fn set_bc(v: u32) { cpu_b = (v >> 8u) & 0xffu; cpu_c = v & 0xffu; }
fn set_de(v: u32) { cpu_d = (v >> 8u) & 0xffu; cpu_e = v & 0xffu; }
fn set_hl(v: u32) { cpu_h = (v >> 8u) & 0xffu; cpu_l = v & 0xffu; }
fn set_af(v: u32) { cpu_a = (v >> 8u) & 0xffu; cpu_f = v & 0xffu; }

fn get_reg(idx: u32) -> u32 {
    switch(idx) {
        case 0u: { return cpu_b; }
        case 1u: { return cpu_c; }
        case 2u: { return cpu_d; }
        case 3u: { return cpu_e; }
        case 4u: {
            if (idx_mode != 0u && idx_uses_mem == 0u) { return (idx_reg16() >> 8u) & 0xffu; } // IXH/IYH
            return cpu_h;
        }
        case 5u: {
            if (idx_mode != 0u && idx_uses_mem == 0u) { return idx_reg16() & 0xffu; } // IXL/IYL
            return cpu_l;
        }
        case 6u: { return mem_read(idx_addr()); }
        case 7u: { return cpu_a; }
        default: { return 0u; }
    }
}

fn set_reg(idx: u32, val: u32) {
    let v = val & 0xffu;
    switch(idx) {
        case 0u: { cpu_b = v; }
        case 1u: { cpu_c = v; }
        case 2u: { cpu_d = v; }
        case 3u: { cpu_e = v; }
        case 4u: {
            if (idx_mode != 0u && idx_uses_mem == 0u) { set_idx_reg16((idx_reg16() & 0x00ffu) | (v << 8u)); }
            else { cpu_h = v; }
        }
        case 5u: {
            if (idx_mode != 0u && idx_uses_mem == 0u) { set_idx_reg16((idx_reg16() & 0xff00u) | v); }
            else { cpu_l = v; }
        }
        case 6u: { mem_write(idx_addr(), v); }
        case 7u: { cpu_a = v; }
        default: {}
    }
}

fn get_reg16(idx: u32) -> u32 {
    switch(idx) {
        case 0u: { return get_bc(); }
        case 1u: { return get_de(); }
        case 2u: { return idx_reg16(); } // HL / IX / IY
        case 3u: { return cpu_sp; }
        default: { return 0u; }
    }
}

fn set_reg16(idx: u32, val: u32) {
    let v = val & 0xffffu;
    switch(idx) {
        case 0u: { set_bc(v); }
        case 1u: { set_de(v); }
        case 2u: { set_idx_reg16(v); } // HL / IX / IY
        case 3u: { cpu_sp = v; }
        default: {}
    }
}

fn get_reg16_af(idx: u32) -> u32 {
    if (idx == 3u) { return get_af(); }
    return get_reg16(idx);
}

fn set_reg16_af(idx: u32, val: u32) {
    if (idx == 3u) { set_af(val); } else { set_reg16(idx, val); }
}

// === Index register (IX/IY) helpers ===
// The 16-bit register the current prefix maps HL to (HL itself when no prefix).
fn idx_reg16() -> u32 {
    if (idx_mode == 1u) { return cpu_ix; }
    if (idx_mode == 2u) { return cpu_iy; }
    return get_hl();
}
fn set_idx_reg16(v: u32) {
    if (idx_mode == 1u) { cpu_ix = v & 0xffffu; }
    else if (idx_mode == 2u) { cpu_iy = v & 0xffffu; }
    else { set_hl(v); }
}
// Address used for (HL) / (IX+d) / (IY+d).
fn idx_addr() -> u32 {
    if (idx_mode != 0u) { return (idx_reg16() + idx_disp) & 0xffffu; }
    return get_hl();
}
// Sign-extend a displacement byte to 16 bits (two's complement).
fn signext(b: u32) -> u32 {
    if (b >= 0x80u) { return b | 0xff00u; }
    return b;
}
// Does this main opcode dereference (HL)? (Determines displacement fetch and
// whether H/L operands are IXH/IXL or real H/L under a DD/FD prefix.)
fn op_uses_hl_mem(op: u32) -> bool {
    let x = (op >> 6u) & 3u;
    let y = (op >> 3u) & 7u;
    let z = op & 7u;
    if (x == 1u) { return (y == 6u || z == 6u) && !(y == 6u && z == 6u); } // LD r,(HL)/(HL),r (not HALT)
    if (x == 2u) { return z == 6u; }                                        // ALU A,(HL)
    if (x == 0u) {
        if (z == 4u || z == 5u || z == 6u) { return y == 6u; }              // INC/DEC (HL), LD (HL),n
        return false;
    }
    return false;
}
// Write a REAL 8-bit register (no IX/IY substitution) — used by the
// undocumented DDCB/FDCB register-copy side effect.
fn set_reg_raw(idx: u32, val: u32) {
    let v = val & 0xffu;
    switch(idx) {
        case 0u: { cpu_b = v; }
        case 1u: { cpu_c = v; }
        case 2u: { cpu_d = v; }
        case 3u: { cpu_e = v; }
        case 4u: { cpu_h = v; }
        case 5u: { cpu_l = v; }
        case 7u: { cpu_a = v; }
        default: {}
    }
}

// === Flag Helpers ===
fn sz_flags(val: u32) -> u32 {
    var f = val & SFl;
    if (val == 0u) { f |= ZF; }
    f |= val & (F3 | F5);
    return f;
}

fn parity(val: u32) -> bool {
    var p = val;
    p ^= p >> 4u;
    p ^= p >> 2u;
    p ^= p >> 1u;
    return (p & 1u) == 0u;
}

fn check_cc(cc: u32) -> bool {
    switch(cc) {
        case 0u: { return (cpu_f & ZF) == 0u; }
        case 1u: { return (cpu_f & ZF) != 0u; }
        case 2u: { return (cpu_f & CF) == 0u; }
        case 3u: { return (cpu_f & CF) != 0u; }
        case 4u: { return (cpu_f & PF) == 0u; }
        case 5u: { return (cpu_f & PF) != 0u; }
        case 6u: { return (cpu_f & SFl) == 0u; }
        case 7u: { return (cpu_f & SFl) != 0u; }
        default: { return false; }
    }
}

// === ALU ===
fn z80_alu(op: u32, val: u32) {
    let a = cpu_a;
    let c = cpu_f & CF;
    switch(op) {
        case 0u: { // ADD
            let r = a + val;
            cpu_f = sz_flags(r & 0xffu) | select(0u, CF, r > 0xffu) |
                    ((a ^ val ^ r) & HF) |
                    select(0u, PF, ((~(a ^ val)) & (a ^ r) & 0x80u) != 0u);
            cpu_a = r & 0xffu;
        }
        case 1u: { // ADC
            let r = a + val + c;
            cpu_f = sz_flags(r & 0xffu) | select(0u, CF, r > 0xffu) |
                    ((a ^ val ^ r) & HF) |
                    select(0u, PF, ((~(a ^ val)) & (a ^ r) & 0x80u) != 0u);
            cpu_a = r & 0xffu;
        }
        case 2u: { // SUB
            let r = i32(a) - i32(val);
            let ru = u32(r) & 0xffu;
            cpu_f = sz_flags(ru) | NF | select(0u, CF, r < 0) |
                    ((a ^ val ^ u32(r)) & HF) |
                    select(0u, PF, (((a ^ val) & (a ^ u32(r))) & 0x80u) != 0u);
            cpu_a = ru;
        }
        case 3u: { // SBC
            let r = i32(a) - i32(val) - i32(c);
            let ru = u32(r) & 0xffu;
            cpu_f = sz_flags(ru) | NF | select(0u, CF, r < 0) |
                    ((a ^ val ^ u32(r)) & HF) |
                    select(0u, PF, (((a ^ val) & (a ^ u32(r))) & 0x80u) != 0u);
            cpu_a = ru;
        }
        case 4u: { // AND
            cpu_a = a & val;
            cpu_f = sz_flags(cpu_a) | HF | select(0u, PF, parity(cpu_a));
        }
        case 5u: { // XOR
            cpu_a = a ^ val;
            cpu_f = sz_flags(cpu_a) | select(0u, PF, parity(cpu_a));
        }
        case 6u: { // OR
            cpu_a = a | val;
            cpu_f = sz_flags(cpu_a) | select(0u, PF, parity(cpu_a));
        }
        case 7u: { // CP
            let r = i32(a) - i32(val);
            let ru = u32(r) & 0xffu;
            cpu_f = (ru & SFl) | select(0u, ZF, ru == 0u) | (val & (F3 | F5)) | NF |
                    select(0u, CF, r < 0) | ((a ^ val ^ u32(r)) & HF) |
                    select(0u, PF, (((a ^ val) & (a ^ u32(r))) & 0x80u) != 0u);
        }
        default: {}
    }${qf}
}

fn z80_inc8(val: u32) -> u32 {
    let r = (val + 1u) & 0xffu;
    cpu_f = (cpu_f & CF) | sz_flags(r) |
            select(0u, PF, val == 0x7fu) |
            select(0u, HF, (r & 0x0fu) == 0u);${qf}
    return r;
}

fn z80_dec8(val: u32) -> u32 {
    let r = (val - 1u) & 0xffu;
    cpu_f = (cpu_f & CF) | sz_flags(r) | NF |
            select(0u, PF, val == 0x80u) |
            select(0u, HF, (val & 0x0fu) == 0u);${qf}
    return r;
}

fn z80_add_hl(val: u32) {
    let hl = idx_reg16(); // ADD HL,rp / ADD IX,rp / ADD IY,rp
    let r = hl + val;
    cpu_f = (cpu_f & (SFl | ZF | PF)) |
            select(0u, CF, r > 0xffffu) |
            select(0u, HF, ((hl ^ val ^ r) & 0x1000u) != 0u) |
            ((r >> 8u) & (F3 | F5));${qf}
    set_idx_reg16(r & 0xffffu);
    cpu_wz = (hl + 1u) & 0xffffu;
}

// === Rotate/Shift for accumulator ===
fn z80_rot_accum(y: u32) {
    let a = cpu_a;
    let c = cpu_f & CF;
    let keep = cpu_f & (SFl | ZF | PF);
    switch(y) {
        case 0u: { // RLCA
            cpu_a = ((a << 1u) | (a >> 7u)) & 0xffu;
            cpu_f = keep | (a >> 7u) | (cpu_a & (F3 | F5));
        }
        case 1u: { // RRCA
            cpu_a = ((a >> 1u) | (a << 7u)) & 0xffu;
            cpu_f = keep | (a & 1u) | (cpu_a & (F3 | F5));
        }
        case 2u: { // RLA
            cpu_a = ((a << 1u) | c) & 0xffu;
            cpu_f = keep | (a >> 7u) | (cpu_a & (F3 | F5));
        }
        case 3u: { // RRA
            cpu_a = ((a >> 1u) | (c << 7u)) & 0xffu;
            cpu_f = keep | (a & 1u) | (cpu_a & (F3 | F5));
        }
        case 4u: { // DAA
            var correction = 0u;
            var carry = c;
            if ((cpu_f & HF) != 0u || (a & 0x0fu) > 9u) { correction |= 0x06u; }
            if (c != 0u || a > 0x99u) { correction |= 0x60u; carry = 1u; }
            if ((cpu_f & NF) != 0u) { cpu_a = (a - correction) & 0xffu; }
            else { cpu_a = (a + correction) & 0xffu; }
            cpu_f = (cpu_f & NF) | sz_flags(cpu_a) | carry |
                    ((a ^ cpu_a) & HF) | select(0u, PF, parity(cpu_a));
        }
        case 5u: { // CPL
            cpu_a = (~a) & 0xffu;
            cpu_f = (cpu_f & (SFl | ZF | PF | CF)) | HF | NF | (cpu_a & (F3 | F5));
        }
        case 6u: { // SCF
            cpu_f = (cpu_f & (SFl | ZF | PF)) | CF | ${xyScfCcf};
        }
        case 7u: { // CCF
            cpu_f = (cpu_f & (SFl | ZF | PF)) |
                    select(0u, HF, c != 0u) |
                    select(CF, 0u, c != 0u) |
                    ${xyScfCcf};
        }
        default: {}
    }${qf}
}

// === CB Prefix (bit ops, rotates, shifts) ===
fn z80_cb_rot(op: u32, val: u32) -> u32 {
    let c = cpu_f & CF;
    var r = 0u;
    switch(op) {
        case 0u: { r = ((val << 1u) | (val >> 7u)) & 0xffu; cpu_f = sz_flags(r) | (val >> 7u) | select(0u, PF, parity(r)); }
        case 1u: { r = ((val >> 1u) | (val << 7u)) & 0xffu; cpu_f = sz_flags(r) | (val & 1u) | select(0u, PF, parity(r)); }
        case 2u: { r = ((val << 1u) | c) & 0xffu; cpu_f = sz_flags(r) | (val >> 7u) | select(0u, PF, parity(r)); }
        case 3u: { r = ((val >> 1u) | (c << 7u)) & 0xffu; cpu_f = sz_flags(r) | (val & 1u) | select(0u, PF, parity(r)); }
        case 4u: { r = (val << 1u) & 0xffu; cpu_f = sz_flags(r) | (val >> 7u) | select(0u, PF, parity(r)); }
        case 5u: { r = ((val >> 1u) | (val & 0x80u)) & 0xffu; cpu_f = sz_flags(r) | (val & 1u) | select(0u, PF, parity(r)); }
        case 6u: { r = ((val << 1u) | 1u) & 0xffu; cpu_f = sz_flags(r) | (val >> 7u) | select(0u, PF, parity(r)); }
        case 7u: { r = (val >> 1u) & 0xffu; cpu_f = sz_flags(r) | (val & 1u) | select(0u, PF, parity(r)); }
        default: { r = val; }
    }${qf}
    return r;
}

fn z80_exec_cb() {
    let op = z80_fetch();
    r_inc(); // M1: CB-page opcode fetch
    if (on_fetch_opcode(0xcbu, op)) { return; } // host hook (2-byte NOP)
    let x = (op >> 6u) & 3u;
    let y = (op >> 3u) & 7u;
    let z = op & 7u;
    let val = get_reg(z);
    switch(x) {
        case 0u: { set_reg(z, z80_cb_rot(y, val)); }
        case 1u: { // BIT; for BIT n,(HL) the undocumented F3/F5 come from WZ bits 11 and 13 (MEMPTR)
            let xy = select(val, cpu_wz >> 8u, z == 6u);
            cpu_f = (cpu_f & CF) | HF |
                    select(0u, ZF | PF, (val & (1u << y)) == 0u) |
                    select(0u, SFl, y == 7u && (val & 0x80u) != 0u) |
                    (xy & (F3 | F5));${qfi}
        }
        case 2u: { set_reg(z, val & ~(1u << y)); }
        case 3u: { set_reg(z, val | (1u << y)); }
        default: {}
    }
}

// DDCB / FDCB: operates on (IX+d)/(IY+d). The displacement (idx_disp) has
// already been fetched. For rot/shift/RES/SET the result is written to memory
// AND (undocumented) copied to the real register in the low 3 bits unless it is
// 6. For BIT, the undocumented F3/F5 come from the high byte of the address
// (which is WZ: every (IX+d) instruction sets WZ = IX+d).
fn z80_exec_idxcb(cbop: u32) {
    let addr = (idx_reg16() + idx_disp) & 0xffffu;
    cpu_wz = addr;
    let cx = (cbop >> 6u) & 3u;
    let cy = (cbop >> 3u) & 7u;
    let cz = cbop & 7u;
    let val = mem_read(addr);
    switch(cx) {
        case 0u: {
            let r = z80_cb_rot(cy, val);
            mem_write(addr, r);
            if (cz != 6u) { set_reg_raw(cz, r); }
        }
        case 1u: { // BIT n,(IX+d)
            cpu_f = (cpu_f & CF) | HF |
                    select(0u, ZF | PF, (val & (1u << cy)) == 0u) |
                    select(0u, SFl, cy == 7u && (val & 0x80u) != 0u) |
                    ((addr >> 8u) & (F3 | F5));${qfi}
        }
        case 2u: {
            let r = val & ~(1u << cy);
            mem_write(addr, r);
            if (cz != 6u) { set_reg_raw(cz, r); }
        }
        case 3u: {
            let r = val | (1u << cy);
            mem_write(addr, r);
            if (cz != 6u) { set_reg_raw(cz, r); }
        }
        default: {}
    }
}

// === Block Transfer (ED prefix) ===
fn z80_ldi() {
    let val = mem_read(get_hl());
    mem_write(get_de(), val);
    set_hl((get_hl() + 1u) & 0xffffu);
    set_de((get_de() + 1u) & 0xffffu);
    set_bc((get_bc() - 1u) & 0xffffu);
    let n = (val + cpu_a) & 0xffu;
    cpu_f = (cpu_f & (SFl | ZF | CF)) |
            select(0u, PF, get_bc() != 0u) |
            (n & F3) | select(0u, F5, (n & 0x02u) != 0u);${qf}
}

fn z80_ldd() {
    let val = mem_read(get_hl());
    mem_write(get_de(), val);
    set_hl((get_hl() - 1u) & 0xffffu);
    set_de((get_de() - 1u) & 0xffffu);
    set_bc((get_bc() - 1u) & 0xffffu);
    let n = (val + cpu_a) & 0xffu;
    cpu_f = (cpu_f & (SFl | ZF | CF)) |
            select(0u, PF, get_bc() != 0u) |
            (n & F3) | select(0u, F5, (n & 0x02u) != 0u);${qf}
}

fn z80_cpi() {
    let val = mem_read(get_hl());
    let r = (cpu_a - val) & 0xffu;
    let hf = (cpu_a ^ val ^ r) & HF;
    // Undocumented F3/F5 come from n = A-(HL)-HF (bit 3 -> F3, bit 1 -> F5).
    let n = (r - select(0u, 1u, hf != 0u)) & 0xffu;
    set_hl((get_hl() + 1u) & 0xffffu);
    set_bc((get_bc() - 1u) & 0xffffu);
    cpu_f = (cpu_f & CF) | (r & SFl) | select(0u, ZF, r == 0u) | NF |
            hf | select(0u, PF, get_bc() != 0u) |
            (n & F3) | ((n & 0x02u) << 4u);${qf}
    cpu_wz = (cpu_wz + 1u) & 0xffffu;
}

fn z80_cpd() {
    let val = mem_read(get_hl());
    let r = (cpu_a - val) & 0xffu;
    let hf = (cpu_a ^ val ^ r) & HF;
    let n = (r - select(0u, 1u, hf != 0u)) & 0xffu;
    set_hl((get_hl() - 1u) & 0xffffu);
    set_bc((get_bc() - 1u) & 0xffffu);
    cpu_f = (cpu_f & CF) | (r & SFl) | select(0u, ZF, r == 0u) | NF |
            hf | select(0u, PF, get_bc() != 0u) |
            (n & F3) | ((n & 0x02u) << 4u);${qf}
    cpu_wz = (cpu_wz - 1u) & 0xffffu;
}

// A block instruction that repeats: PC goes back onto the ED byte, WZ = PC + 1, and the undocumented X/Y flags come
// from PC bits 11 and 13 (the high byte of the instruction's address).
fn z80_block_repeat() {
    cpu_pc = (cpu_pc - 2u) & 0xffffu;
    cpu_wz = (cpu_pc + 1u) & 0xffffu;
    cpu_f = (cpu_f & ~(F3 | F5)) | ((cpu_pc >> 8u) & (F3 | F5));${qf}
}

// Block I/O flags (INI/IND/OUTI/OUTD and the repeating forms). \`val\` is the byte transferred, \`k\` the 8-bit-overflow
// operand sum (val + ((C +/- 1) & 255) for input, val + L for output), B already decremented. A repeating instruction
// (B != 0 for the R forms) also takes X/Y from PC and adjusts H and P/V.
fn z80_block_io_flags(val: u32, k: u32, rep: bool) {
    let carry = k > 0xffu;
    var f = select(0u, NF, (val & 0x80u) != 0u) |
            select(0u, HF | CF, carry) |
            select(0u, PF, parity((k & 7u) ^ cpu_b)) |
            sz_flags(cpu_b);
    if (rep && cpu_b != 0u) {
        f = (f & ~(F3 | F5)) | ((((cpu_pc - 2u) & 0xffffu) >> 8u) & (F3 | F5));
        var pb = cpu_b;
        if (carry) {
            if ((val & 0x80u) != 0u) {
                pb = (cpu_b - 1u) & 0xffu;
                f = (f & ~HF) | select(0u, HF, (cpu_b & 0x0fu) == 0x00u);
            } else {
                pb = (cpu_b + 1u) & 0xffu;
                f = (f & ~HF) | select(0u, HF, (cpu_b & 0x0fu) == 0x0fu);
            }
        }
        // P/V ^= parity(pb & 7) ^ 1 (parity() is true for even parity)
        if (!parity(pb & 7u)) { f = f ^ PF; }
    }
    cpu_f = f;${qf}
}

// === ED Prefix ===
fn z80_exec_ed() {
    let op = z80_fetch();
    r_inc(); // M1: ED-page opcode fetch
    if (on_fetch_opcode(0xedu, op)) { return; } // host hook (2-byte NOP)
    switch(op) {
        case 0xa0u: { z80_ldi(); }
        case 0xa8u: { z80_ldd(); }
        case 0xb0u: { z80_ldi(); if (get_bc() != 0u) { z80_block_repeat(); } } // LDIR
        case 0xb8u: { z80_ldd(); if (get_bc() != 0u) { z80_block_repeat(); } } // LDDR
        case 0xa1u: { z80_cpi(); }
        case 0xa9u: { z80_cpd(); }
        case 0xb1u: { z80_cpi(); if (get_bc() != 0u && (cpu_f & ZF) == 0u) { z80_block_repeat(); } } // CPIR
        case 0xb9u: { z80_cpd(); if (get_bc() != 0u && (cpu_f & ZF) == 0u) { z80_block_repeat(); } } // CPDR
        // NEG
        case 0x44u, 0x4cu, 0x54u, 0x5cu, 0x64u, 0x6cu, 0x74u, 0x7cu: {
            let a = cpu_a; cpu_a = 0u; z80_alu(2u, a);
        }
        // RETN/RETI
        case 0x45u, 0x4du, 0x55u, 0x5du, 0x65u, 0x6du, 0x75u, 0x7du: {
            cpu_iff1 = cpu_iff2; cpu_pc = z80_pop16(); cpu_wz = cpu_pc;
        }
        // IM 0 / IM 1 / IM 2 and their mirrors: ED 46 4E 66 6E -> 0, 56 76 -> 1, 5E 7E -> 2
        case 0x46u, 0x4eu, 0x56u, 0x5eu, 0x66u, 0x6eu, 0x76u, 0x7eu: {
            let m = (op >> 3u) & 3u;
            cpu_im = select(0u, m - 1u, m >= 2u);
        }
        // LD I,A / LD R,A / LD A,I / LD A,R
        case 0x47u: { cpu_i = cpu_a; } // LD I,A
        case 0x4fu: { cpu_r = cpu_a; } // LD R,A
        // LD A,I / LD A,R: load I or R into A. Flags: S/Z (+F3/F5) from the loaded
        // value, PF = IFF2, N/H reset, C preserved.
        case 0x57u: { cpu_a = cpu_i; cpu_f = (cpu_f & CF) | sz_flags(cpu_i) | select(0u, PF, cpu_iff2 != 0u);${qfi} }
        case 0x5fu: { cpu_a = cpu_r; cpu_f = (cpu_f & CF) | sz_flags(cpu_r) | select(0u, PF, cpu_iff2 != 0u);${qfi} }
        // LD (nn), rr
        case 0x43u, 0x53u, 0x63u, 0x73u: {
            let nn = z80_fetch_word();
            let rp = (op >> 4u) & 3u;
            let val = get_reg16(rp);
            mem_write(nn, val & 0xffu);
            mem_write((nn + 1u) & 0xffffu, (val >> 8u) & 0xffu);
            cpu_wz = (nn + 1u) & 0xffffu;
        }
        // LD rr, (nn)
        case 0x4bu, 0x5bu, 0x6bu, 0x7bu: {
            let nn = z80_fetch_word();
            let rp = (op >> 4u) & 3u;
            let lo = mem_read(nn);
            let hi = mem_read((nn + 1u) & 0xffffu);
            set_reg16(rp, (hi << 8u) | lo);
            cpu_wz = (nn + 1u) & 0xffffu;
        }
        // ADC HL, rr
        case 0x4au, 0x5au, 0x6au, 0x7au: {
            let rp = (op >> 4u) & 3u;
            let hl = get_hl();
            let val = get_reg16(rp);
            let c = cpu_f & CF;
            let r = hl + val + c;
            cpu_f = ((r >> 8u) & SFl) | select(0u, ZF, (r & 0xffffu) == 0u) |
                    select(0u, HF, ((hl ^ val ^ r) & 0x1000u) != 0u) |
                    select(0u, PF, ((~(hl ^ val)) & (hl ^ r) & 0x8000u) != 0u) |
                    select(0u, CF, r > 0xffffu) | ((r >> 8u) & (F3 | F5));${qfi}
            set_hl(r & 0xffffu);
            cpu_wz = (hl + 1u) & 0xffffu;
        }
        // SBC HL, rr
        case 0x42u, 0x52u, 0x62u, 0x72u: {
            let rp = (op >> 4u) & 3u;
            let hl = get_hl();
            let val = get_reg16(rp);
            let c = cpu_f & CF;
            let r = i32(hl) - i32(val) - i32(c);
            let ru = u32(r) & 0xffffu;
            cpu_f = ((ru >> 8u) & SFl) | select(0u, ZF, ru == 0u) | NF |
                    select(0u, HF, ((hl ^ val ^ u32(r)) & 0x1000u) != 0u) |
                    select(0u, PF, (((hl ^ val) & (hl ^ u32(r))) & 0x8000u) != 0u) |
                    select(0u, CF, r < 0) | ((ru >> 8u) & (F3 | F5));${qfi}
            set_hl(ru);
            cpu_wz = (hl + 1u) & 0xffffu;
        }
        // RRD
        case 0x67u: {
            let m = mem_read(get_hl());
            mem_write(get_hl(), ((cpu_a << 4u) | (m >> 4u)) & 0xffu);
            cpu_a = (cpu_a & 0xf0u) | (m & 0x0fu);
            cpu_f = (cpu_f & CF) | sz_flags(cpu_a) | select(0u, PF, parity(cpu_a));${qfi}
            cpu_wz = (get_hl() + 1u) & 0xffffu;
        }
        // RLD
        case 0x6fu: {
            let m = mem_read(get_hl());
            mem_write(get_hl(), ((m << 4u) | (cpu_a & 0x0fu)) & 0xffu);
            cpu_a = (cpu_a & 0xf0u) | (m >> 4u);
            cpu_f = (cpu_f & CF) | sz_flags(cpu_a) | select(0u, PF, parity(cpu_a));${qfi}
            cpu_wz = (get_hl() + 1u) & 0xffffu;
        }
        // IN r,(C): store the port value (except for the reg-6 form IN (C), which only sets flags) and set
        // S/Z/F3/F5/P flags; H = N = 0, C kept. WZ = BC + 1 (BC before the load).
        case 0x40u, 0x48u, 0x50u, 0x58u, 0x60u, 0x68u, 0x70u, 0x78u: {
            let bc = get_bc();
            let val = z80_in(bc);
            let reg = (op >> 3u) & 7u;
            if (reg != 6u) { set_reg(reg, val); }
            cpu_f = (cpu_f & CF) | sz_flags(val) | select(0u, PF, parity(val));${qfi}
            cpu_wz = (bc + 1u) & 0xffffu;
        }
        // OUT (C),r and OUT (C),0 (ED 71). WZ = BC + 1.
        case 0x41u, 0x49u, 0x51u, 0x59u, 0x61u, 0x69u, 0x71u, 0x79u: {
            let reg = (op >> 3u) & 7u;
            var v = 0u;
            if (reg != 6u) { v = get_reg(reg); }
            z80_out(get_bc(), v);
            cpu_wz = (get_bc() + 1u) & 0xffffu;
        }
        // Block input: INI (A2) / IND (AA) / INIR (B2) / INDR (BA). The port is BC before B is decremented; the byte
        // goes to (HL); B - 1; HL +/- 1; WZ = BC(before) +/- 1, or PC + 1 when repeating; flags as z80_block_io_flags.
        case 0xa2u, 0xaau, 0xb2u, 0xbau: {
            let bc = get_bc();
            let val = z80_in(bc);
            mem_write(get_hl(), val);
            cpu_b = (cpu_b - 1u) & 0xffu;
            let dec = (op & 0x08u) != 0u;
            let rep = (op & 0x10u) != 0u;
            let k = val + (select((cpu_c + 1u) & 0xffu, (cpu_c - 1u) & 0xffu, dec));
            cpu_wz = select((bc + 1u) & 0xffffu, (bc - 1u) & 0xffffu, dec);
            z80_block_io_flags(val, k, rep);
            if (dec) { set_hl((get_hl() - 1u) & 0xffffu); } else { set_hl((get_hl() + 1u) & 0xffffu); }
            if (rep && cpu_b != 0u) { cpu_pc = (cpu_pc - 2u) & 0xffffu; cpu_wz = (cpu_pc + 1u) & 0xffffu; }
        }
        // Block output: OUTI (A3) / OUTD (AB) / OTIR (B3) / OTDR (BB). Reads (HL), decrements B, sends the byte to
        // port BC (B already decremented), moves HL; WZ = BC(after) +/- 1, or PC + 1 when repeating.
        case 0xa3u, 0xabu, 0xb3u, 0xbbu: {
            let val = mem_read(get_hl());
            cpu_b = (cpu_b - 1u) & 0xffu;
            z80_out(get_bc(), val);
            let dec = (op & 0x08u) != 0u;
            let rep = (op & 0x10u) != 0u;
            cpu_wz = select((get_bc() + 1u) & 0xffffu, (get_bc() - 1u) & 0xffffu, dec);
            if (dec) { set_hl((get_hl() - 1u) & 0xffffu); } else { set_hl((get_hl() + 1u) & 0xffffu); }
            z80_block_io_flags(val, val + cpu_l, rep);
            if (rep && cpu_b != 0u) { cpu_pc = (cpu_pc - 2u) & 0xffffu; cpu_wz = (cpu_pc + 1u) & 0xffffu; }
        }
        default: {} // unknown ED ops = NOP
    }
}

// === Main Opcode Execution ===
fn z80_exec_x0(y: u32, z: u32, p: u32, q: u32) {
    switch(z) {
        case 0u: {
            switch(y) {
                case 0u: {} // NOP
                case 1u: { // EX AF,AF'
                    var t = cpu_a; cpu_a = cpu_a2; cpu_a2 = t;
                    t = cpu_f; cpu_f = cpu_f2; cpu_f2 = t;
                }
                case 2u: { // DJNZ
                    let d = signed_byte(z80_fetch());
                    cpu_b = (cpu_b - 1u) & 0xffu;
                    if (cpu_b != 0u) { cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu; cpu_wz = cpu_pc; }
                }
                case 3u: { // JR
                    let d = signed_byte(z80_fetch());
                    cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu;
                    cpu_wz = cpu_pc;
                }
                default: { // JR cc (y-4)
                    let d = signed_byte(z80_fetch());
                    if (check_cc(y - 4u)) { cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu; cpu_wz = cpu_pc; }
                }
            }
        }
        case 1u: {
            if (q == 0u) { set_reg16(p, z80_fetch_word()); }
            else { z80_add_hl(get_reg16(p)); }
        }
        case 2u: {
            if (q == 0u) {
                switch(p) {
                    case 0u: { mem_write(get_bc(), cpu_a); cpu_wz = (cpu_a << 8u) | ((get_bc() + 1u) & 0xffu); }
                    case 1u: { mem_write(get_de(), cpu_a); cpu_wz = (cpu_a << 8u) | ((get_de() + 1u) & 0xffu); }
                    case 2u: { let nn = z80_fetch_word(); let hl = idx_reg16(); mem_write(nn, hl & 0xffu); mem_write((nn+1u) & 0xffffu, (hl >> 8u) & 0xffu); cpu_wz = (nn + 1u) & 0xffffu; }
                    case 3u: { let nn = z80_fetch_word(); mem_write(nn, cpu_a); cpu_wz = (cpu_a << 8u) | ((nn + 1u) & 0xffu); }
                    default: {}
                }
            } else {
                switch(p) {
                    case 0u: { cpu_a = mem_read(get_bc()); cpu_wz = (get_bc() + 1u) & 0xffffu; }
                    case 1u: { cpu_a = mem_read(get_de()); cpu_wz = (get_de() + 1u) & 0xffffu; }
                    case 2u: { let nn = z80_fetch_word(); let lo = mem_read(nn); let hi = mem_read((nn+1u) & 0xffffu); set_idx_reg16((hi << 8u) | lo); cpu_wz = (nn + 1u) & 0xffffu; }
                    case 3u: { let nn = z80_fetch_word(); cpu_a = mem_read(nn); cpu_wz = (nn + 1u) & 0xffffu; }
                    default: {}
                }
            }
        }
        case 3u: {
            if (q == 0u) { set_reg16(p, (get_reg16(p) + 1u) & 0xffffu); }
            else { set_reg16(p, (get_reg16(p) - 1u) & 0xffffu); }
        }
        case 4u: { set_reg(y, z80_inc8(get_reg(y))); }
        case 5u: { set_reg(y, z80_dec8(get_reg(y))); }
        case 6u: { set_reg(y, z80_fetch()); }
        case 7u: { z80_rot_accum(y); }
        default: {}
    }
}

fn z80_exec_x3(y: u32, z: u32, p: u32, q: u32) {
    switch(z) {
        case 0u: { if (check_cc(y)) { cpu_pc = z80_pop16(); cpu_wz = cpu_pc; } } // RET cc
        case 1u: {
            if (q == 0u) { set_reg16_af(p, z80_pop16()); }
            else {
                switch(p) {
                    case 0u: { cpu_pc = z80_pop16(); cpu_wz = cpu_pc; } // RET
                    case 1u: { // EXX
                        var t = cpu_b; cpu_b = cpu_b2; cpu_b2 = t;
                        t = cpu_c; cpu_c = cpu_c2; cpu_c2 = t;
                        t = cpu_d; cpu_d = cpu_d2; cpu_d2 = t;
                        t = cpu_e; cpu_e = cpu_e2; cpu_e2 = t;
                        t = cpu_h; cpu_h = cpu_h2; cpu_h2 = t;
                        t = cpu_l; cpu_l = cpu_l2; cpu_l2 = t;
                    }
                    case 2u: { cpu_pc = idx_reg16(); } // JP (HL)/(IX)/(IY)
                    case 3u: { cpu_sp = idx_reg16(); } // LD SP,HL/IX/IY
                    default: {}
                }
            }
        }
        case 2u: { let nn = z80_fetch_word(); cpu_wz = nn; if (check_cc(y)) { cpu_pc = nn; } } // JP cc,nn (WZ even if not taken)
        case 3u: {
            switch(y) {
                case 0u: { cpu_pc = z80_fetch_word(); cpu_wz = cpu_pc; } // JP nn
                case 1u: { z80_exec_cb(); }
                case 2u: { // OUT (n),A: port (A << 8) | n; WZ = (A << 8) | ((n + 1) & 0xFF)
                    let n = z80_fetch();
                    z80_out((cpu_a << 8u) | n, cpu_a);
                    cpu_wz = (cpu_a << 8u) | ((n + 1u) & 0xffu);
                }
                case 3u: { // IN A,(n): port (A << 8) | n; WZ = port + 1; flags unaffected
                    let port = (cpu_a << 8u) | z80_fetch();
                    cpu_a = z80_in(port);
                    cpu_wz = (port + 1u) & 0xffffu;
                }
                case 4u: { // EX (SP),HL / EX (SP),IX / EX (SP),IY
                    let lo = mem_read(cpu_sp);
                    let hi = mem_read((cpu_sp + 1u) & 0xffffu);
                    let hl = idx_reg16();
                    mem_write(cpu_sp, hl & 0xffu);
                    mem_write((cpu_sp + 1u) & 0xffffu, (hl >> 8u) & 0xffu);
                    set_idx_reg16((hi << 8u) | lo);
                    cpu_wz = (hi << 8u) | lo;
                }
                case 5u: { // EX DE,HL
                    let td = cpu_d; let te = cpu_e;
                    cpu_d = cpu_h; cpu_e = cpu_l;
                    cpu_h = td; cpu_l = te;
                }
                case 6u: { cpu_iff1 = 0u; cpu_iff2 = 0u; }
                case 7u: { cpu_iff1 = 1u; cpu_iff2 = 1u; }
                default: {}
            }
        }
        case 4u: { let nn = z80_fetch_word(); cpu_wz = nn; if (check_cc(y)) { z80_push16(cpu_pc); cpu_pc = nn; } } // CALL cc,nn (WZ even if not taken)
        case 5u: {
            if (q == 0u) { z80_push16(get_reg16_af(p)); }
            else {
                switch(p) {
                    case 0u: { let nn = z80_fetch_word(); z80_push16(cpu_pc); cpu_pc = nn; cpu_wz = nn; } // CALL nn
                    case 1u, 3u: {} // DD/FD prefix handled in z80_step
                    case 2u: { z80_exec_ed(); }
                    default: {}
                }
            }
        }
        case 6u: { z80_alu(y, z80_fetch()); }
        case 7u: { z80_push16(cpu_pc); cpu_pc = y * 8u; cpu_wz = cpu_pc; } // RST
        default: {}
    }
}

fn z80_execute(op: u32) {
    let x = (op >> 6u) & 3u;
    let y = (op >> 3u) & 7u;
    let z = op & 7u;
    let p = (y >> 1u) & 3u;
    let q = y & 1u;
    switch(x) {
        case 0u: { z80_exec_x0(y, z, p, q); }
        case 1u: {
            if (y == 6u && z == 6u) {
                // HALT: mark halted and back PC up onto the HALT opcode so the
                // CPU re-executes it every step until an interrupt.
${h.haltOpen}                cpu_halted = Z80_HALT_INSN;
                cpu_pc = (cpu_pc - 1u) & 0xffffu;
${h.haltClose}            }
            else { set_reg(y, get_reg(z)); }
        }
        case 2u: { z80_alu(y, get_reg(z)); }
        case 3u: { z80_exec_x3(y, z, p, q); }
        default: {}
    }
}

fn z80_step() {
    // While halted by HALT, the CPU keeps executing it: each step is an M1 fetch of
    // the same opcode (R increments), PC stays put. It resumes only on interrupt.
    // A lane halted by the host (or a trap) is stopped: a step changes nothing.
    if (cpu_halted != Z80_RUNNING) { if (cpu_halted == Z80_HALT_INSN) { r_inc();${nmos ? " cpu_q = 0u;" : ""} } return; }
    // Reset per-instruction index-prefix state.
    idx_mode = 0u;
    idx_uses_mem = 0u;
    idx_disp = 0u;

    var op = z80_fetch();
    r_inc(); // M1: opcode (or prefix) fetch
${h.start}${nmos ? `    z80_qprev = cpu_q; // Q as this instruction begins (SCF/CCF read it)
    cpu_q = 0u;        // 0 unless the instruction writes F: a wasted prefix, an ablated one, POP AF ...
` : ""}    // A DD/FD prefix selects IX/IY for the following opcode.
    if (op == 0xddu || op == 0xfdu) {
        idx_mode = select(2u, 1u, op == 0xddu);
        let next = z80_fetch();
        // A prefix immediately followed by another prefix or ED is wasted: one M1 (counted above). This step
        // consumes just the prefix; back up so the next step restarts at the following byte, which is fetched and
        // counted again as that step's first M1 (avoids an unbounded fetch loop on all-prefix programs).
        if (next == 0xddu || next == 0xfdu || next == 0xedu) {
            cpu_pc = (cpu_pc - 1u) & 0xffffu;
            return;
        }
        r_inc(); // M1: opcode after the prefix
${nmos ? "        z80_qprev = 0u; // the prefix was an instruction cycle of its own that left F alone: SCF/CCF see Q = 0\n" : ""}        op = next;
    }

    // Host hook for base-page opcodes (and their IX/IY forms). The CB and ED
    // prefix bytes are not reported here; their pages report from their own
    // dispatch with prefix = 0xCB / 0xED / 0xDDCB / 0xFDCB.
    if (op != 0xcbu && op != 0xedu) {
        let pfx = select(select(0xfdu, 0xddu, idx_mode == 1u), 0u, idx_mode == 0u);
        if (on_fetch_opcode(pfx, op)) { return; }
    }

    if (idx_mode != 0u) {
        if (op == 0xcbu) {
            // DDCB/FDCB: displacement precedes the CB opcode.
            idx_disp = signext(z80_fetch());
            let cbop = z80_fetch();
            let pfx = select(0xfdcbu, 0xddcbu, idx_mode == 1u);
            if (on_fetch_opcode(pfx, cbop)) { return; } // host hook (4-byte NOP)
            z80_exec_idxcb(cbop);
            return;
        }
        if (op_uses_hl_mem(op)) {
            idx_uses_mem = 1u;
            idx_disp = signext(z80_fetch());
            cpu_wz = (idx_reg16() + idx_disp) & 0xffffu; // every (IX+d)/(IY+d) instruction: WZ = IX/IY + d
        }
    }
    z80_execute(op);
}

// Runs up to \`budget\` steps and returns how many ran; stops after the step that halts.
fn z80_run(budget: u32) -> u32 {
    var n = 0u;
    loop {
        if (n >= budget || cpu_halted != Z80_RUNNING) { break; }
        z80_step();
        n = n + 1u;
    }
    return n;
}
`;
}

/**
 * The bare Z80 core of 0.2.0, byte for byte (the frozen 0.2 text with no hooks; `compat: '0.2'`). The root export of
 * the 0.2 API: a host declares `mem_read`, `mem_write` and `on_fetch_opcode(prefix, op) -> bool`, initialises the
 * `cpu_*` registers and calls `z80_step()`. Current semantics: `z80CoreText()` or `z80.wgsl({ hooks: {} })`.
 */
export { Z80_CORE_WGSL };
