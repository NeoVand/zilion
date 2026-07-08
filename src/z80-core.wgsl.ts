// Zilion — WebGPU Z80 core (WGSL), generated from a differentially-tested
// implementation. Do not edit by hand; see the project README.
//
// `__MEM_SIZE__` and `__MEM_MASK__` are replaced at shader build time with the
// per-instance memory size (a power of two) and its address mask.

export const Z80_CORE_WGSL = /* wgsl */ `
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
//   fn mem_read(addr: u32) -> u32               // read one byte from memory
//   fn mem_write(addr: u32, val: u32)           // write one byte to memory
//   fn on_fetch_opcode(op: u32) -> bool         // return true to skip (NOP) an
//                                               // opcode after prefix resolution
// This lets the host choose the memory model (mask, modulo, storage buffer, …)
// and hook opcode execution (e.g. instruction suppression). See buildComputeShader.

// Z80 flag bits
const CF: u32 = 0x01u;
const NF: u32 = 0x02u;
const PF: u32 = 0x04u;
const F3: u32 = 0x08u;
const HF: u32 = 0x10u;
const F5: u32 = 0x20u;
const ZF: u32 = 0x40u;
const SFl: u32 = 0x80u;


fn z80_fetch() -> u32 {
    let val = mem_read(cpu_pc);
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
    }
}

fn z80_inc8(val: u32) -> u32 {
    let r = (val + 1u) & 0xffu;
    cpu_f = (cpu_f & CF) | sz_flags(r) |
            select(0u, PF, val == 0x7fu) |
            select(0u, HF, (r & 0x0fu) == 0u);
    return r;
}

fn z80_dec8(val: u32) -> u32 {
    let r = (val - 1u) & 0xffu;
    cpu_f = (cpu_f & CF) | sz_flags(r) | NF |
            select(0u, PF, val == 0x80u) |
            select(0u, HF, (val & 0x0fu) == 0u);
    return r;
}

fn z80_add_hl(val: u32) {
    let hl = idx_reg16(); // ADD HL,rp / ADD IX,rp / ADD IY,rp
    let r = hl + val;
    cpu_f = (cpu_f & (SFl | ZF | PF)) |
            select(0u, CF, r > 0xffffu) |
            select(0u, HF, ((hl ^ val ^ r) & 0x1000u) != 0u) |
            ((r >> 8u) & (F3 | F5));
    set_idx_reg16(r & 0xffffu);
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
            cpu_f = (cpu_f & (SFl | ZF | PF)) | CF | (cpu_a & (F3 | F5));
        }
        case 7u: { // CCF
            cpu_f = (cpu_f & (SFl | ZF | PF)) |
                    select(0u, HF, c != 0u) |
                    select(CF, 0u, c != 0u) |
                    (cpu_a & (F3 | F5));
        }
        default: {}
    }
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
    }
    return r;
}

fn z80_exec_cb() {
    let op = z80_fetch();
    r_inc(); // M1: CB-page opcode fetch
    let x = (op >> 6u) & 3u;
    let y = (op >> 3u) & 7u;
    let z = op & 7u;
    let val = get_reg(z);
    switch(x) {
        case 0u: { set_reg(z, z80_cb_rot(y, val)); }
        case 1u: { // BIT
            cpu_f = (cpu_f & CF) | HF |
                    select(0u, ZF | PF, (val & (1u << y)) == 0u) |
                    select(0u, SFl, y == 7u && (val & 0x80u) != 0u) |
                    (val & (F3 | F5));
        }
        case 2u: { set_reg(z, val & ~(1u << y)); }
        case 3u: { set_reg(z, val | (1u << y)); }
        default: {}
    }
}

// DDCB / FDCB: operates on (IX+d)/(IY+d). The displacement (idx_disp) has
// already been fetched. For rot/shift/RES/SET the result is written to memory
// AND (undocumented) copied to the real register in the low 3 bits unless it is
// 6. For BIT, the undocumented F3/F5 come from the high byte of the address.
fn z80_exec_idxcb(cbop: u32) {
    let addr = (idx_reg16() + idx_disp) & 0xffffu;
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
                    ((addr >> 8u) & (F3 | F5));
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
            (n & F3) | select(0u, F5, (n & 0x02u) != 0u);
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
            (n & F3) | select(0u, F5, (n & 0x02u) != 0u);
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
            (n & F3) | ((n & 0x02u) << 4u);
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
            (n & F3) | ((n & 0x02u) << 4u);
}

// === ED Prefix ===
fn z80_exec_ed() {
    let op = z80_fetch();
    r_inc(); // M1: ED-page opcode fetch
    switch(op) {
        case 0xa0u: { z80_ldi(); }
        case 0xa8u: { z80_ldd(); }
        case 0xb0u: { z80_ldi(); if (get_bc() != 0u) { cpu_pc = (cpu_pc - 2u) & 0xffffu; } } // LDIR
        case 0xb8u: { z80_ldd(); if (get_bc() != 0u) { cpu_pc = (cpu_pc - 2u) & 0xffffu; } } // LDDR
        case 0xa1u: { z80_cpi(); }
        case 0xa9u: { z80_cpd(); }
        case 0xb1u: { z80_cpi(); if (get_bc() != 0u && (cpu_f & ZF) == 0u) { cpu_pc = (cpu_pc - 2u) & 0xffffu; } }
        case 0xb9u: { z80_cpd(); if (get_bc() != 0u && (cpu_f & ZF) == 0u) { cpu_pc = (cpu_pc - 2u) & 0xffffu; } }
        // NEG
        case 0x44u, 0x4cu, 0x54u, 0x5cu, 0x64u, 0x6cu, 0x74u, 0x7cu: {
            let a = cpu_a; cpu_a = 0u; z80_alu(2u, a);
        }
        // RETN/RETI
        case 0x45u, 0x4du, 0x55u, 0x5du, 0x65u, 0x6du, 0x75u, 0x7du: {
            cpu_iff1 = cpu_iff2; cpu_pc = z80_pop16();
        }
        // LD I,A / LD R,A / LD A,I / LD A,R
        case 0x47u: { cpu_i = cpu_a; } // LD I,A
        case 0x4fu: { cpu_r = cpu_a; } // LD R,A
        // LD A,I / LD A,R: load I or R into A. Flags: S/Z (+F3/F5) from the loaded
        // value, PF = IFF2, N/H reset, C preserved.
        case 0x57u: { cpu_a = cpu_i; cpu_f = (cpu_f & CF) | sz_flags(cpu_i) | select(0u, PF, cpu_iff2 != 0u); }
        case 0x5fu: { cpu_a = cpu_r; cpu_f = (cpu_f & CF) | sz_flags(cpu_r) | select(0u, PF, cpu_iff2 != 0u); }
        // LD (nn), rr
        case 0x43u, 0x53u, 0x63u, 0x73u: {
            let nn = z80_fetch_word();
            let rp = (op >> 4u) & 3u;
            let val = get_reg16(rp);
            mem_write(nn, val & 0xffu);
            mem_write((nn + 1u) & 0xffffu, (val >> 8u) & 0xffu);
        }
        // LD rr, (nn)
        case 0x4bu, 0x5bu, 0x6bu, 0x7bu: {
            let nn = z80_fetch_word();
            let rp = (op >> 4u) & 3u;
            let lo = mem_read(nn);
            let hi = mem_read((nn + 1u) & 0xffffu);
            set_reg16(rp, (hi << 8u) | lo);
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
                    select(0u, CF, r > 0xffffu) | ((r >> 8u) & (F3 | F5));
            set_hl(r & 0xffffu);
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
                    select(0u, CF, r < 0) | ((ru >> 8u) & (F3 | F5));
            set_hl(ru);
        }
        // RRD
        case 0x67u: {
            let m = mem_read(get_hl());
            mem_write(get_hl(), ((cpu_a << 4u) | (m >> 4u)) & 0xffu);
            cpu_a = (cpu_a & 0xf0u) | (m & 0x0fu);
            cpu_f = (cpu_f & CF) | sz_flags(cpu_a) | select(0u, PF, parity(cpu_a));
        }
        // RLD
        case 0x6fu: {
            let m = mem_read(get_hl());
            mem_write(get_hl(), ((m << 4u) | (cpu_a & 0x0fu)) & 0xffu);
            cpu_a = (cpu_a & 0xf0u) | (m >> 4u);
            cpu_f = (cpu_f & CF) | sz_flags(cpu_a) | select(0u, PF, parity(cpu_a));
        }
        // IN r,(C): no I/O device, so the port reads 0. Store it (except for the
        // reg-6 form IN (C), which only sets flags) and set S/Z/F3/F5/P flags.
        case 0x40u, 0x48u, 0x50u, 0x58u, 0x60u, 0x68u, 0x70u, 0x78u: {
            let val = 0u;
            let reg = (op >> 3u) & 7u;
            if (reg != 6u) { set_reg(reg, val); }
            cpu_f = (cpu_f & CF) | sz_flags(val) | select(0u, PF, parity(val));
        }
        // Block input: INI (A2) / IND (AA) / INIR (B2) / INDR (BA). No I/O
        // device, so the port reads 0. Writes it to (HL), decrements B, moves HL,
        // sets the block-I/O flags, and repeats (R-forms) while B != 0.
        case 0xa2u, 0xaau, 0xb2u, 0xbau: {
            let val = 0u;
            mem_write(get_hl(), val);
            cpu_b = (cpu_b - 1u) & 0xffu;
            let dec = (op & 0x08u) != 0u;
            let s = (val + cpu_c) & 0xffu;
            let other = select((s + 1u) & 0xffu, (s - 1u) & 0xffu, dec);
            cpu_f = select(0u, NF, (val & 0x80u) != 0u) |
                    select(0u, HF | CF, other < val) |
                    select(0u, PF, parity((other & 7u) ^ cpu_b)) |
                    sz_flags(cpu_b);
            if (dec) { set_hl((get_hl() - 1u) & 0xffffu); } else { set_hl((get_hl() + 1u) & 0xffffu); }
            if ((op & 0x10u) != 0u && cpu_b != 0u) { cpu_pc = (cpu_pc - 2u) & 0xffffu; }
        }
        // Block output: OUTI (A3) / OUTD (AB) / OTIR (B3) / OTDR (BB). Reads (HL),
        // decrements B, moves HL, sends to the (absent) port, sets flags, repeats.
        case 0xa3u, 0xabu, 0xb3u, 0xbbu: {
            let val = mem_read(get_hl());
            cpu_b = (cpu_b - 1u) & 0xffu;
            let dec = (op & 0x08u) != 0u;
            if (dec) { set_hl((get_hl() - 1u) & 0xffffu); } else { set_hl((get_hl() + 1u) & 0xffffu); }
            let other = (val + cpu_l) & 0xffu;
            cpu_f = select(0u, NF, (val & 0x80u) != 0u) |
                    select(0u, HF | CF, other < val) |
                    select(0u, PF, parity((other & 7u) ^ cpu_b)) |
                    sz_flags(cpu_b);
            if ((op & 0x10u) != 0u && cpu_b != 0u) { cpu_pc = (cpu_pc - 2u) & 0xffffu; }
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
                    if (cpu_b != 0u) { cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu; }
                }
                case 3u: { // JR
                    let d = signed_byte(z80_fetch());
                    cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu;
                }
                default: { // JR cc (y-4)
                    let d = signed_byte(z80_fetch());
                    if (check_cc(y - 4u)) { cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu; }
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
                    case 0u: { mem_write(get_bc(), cpu_a); }
                    case 1u: { mem_write(get_de(), cpu_a); }
                    case 2u: { let nn = z80_fetch_word(); let hl = idx_reg16(); mem_write(nn, hl & 0xffu); mem_write((nn+1u) & 0xffffu, (hl >> 8u) & 0xffu); }
                    case 3u: { mem_write(z80_fetch_word(), cpu_a); }
                    default: {}
                }
            } else {
                switch(p) {
                    case 0u: { cpu_a = mem_read(get_bc()); }
                    case 1u: { cpu_a = mem_read(get_de()); }
                    case 2u: { let nn = z80_fetch_word(); let lo = mem_read(nn); let hi = mem_read((nn+1u) & 0xffffu); set_idx_reg16((hi << 8u) | lo); }
                    case 3u: { cpu_a = mem_read(z80_fetch_word()); }
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
        case 0u: { if (check_cc(y)) { cpu_pc = z80_pop16(); } }
        case 1u: {
            if (q == 0u) { set_reg16_af(p, z80_pop16()); }
            else {
                switch(p) {
                    case 0u: { cpu_pc = z80_pop16(); } // RET
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
        case 2u: { let nn = z80_fetch_word(); if (check_cc(y)) { cpu_pc = nn; } }
        case 3u: {
            switch(y) {
                case 0u: { cpu_pc = z80_fetch_word(); } // JP nn
                case 1u: { z80_exec_cb(); }
                case 2u: { z80_fetch(); } // OUT (n),A - no I/O device, discard (matches zff outPort no-op)
                case 3u: { z80_fetch(); cpu_a = 0u; } // IN A,(n) - no I/O device, reads 0 (matches zff inPort→0)
                case 4u: { // EX (SP),HL / EX (SP),IX / EX (SP),IY
                    let lo = mem_read(cpu_sp);
                    let hi = mem_read((cpu_sp + 1u) & 0xffffu);
                    let hl = idx_reg16();
                    mem_write(cpu_sp, hl & 0xffu);
                    mem_write((cpu_sp + 1u) & 0xffffu, (hl >> 8u) & 0xffu);
                    set_idx_reg16((hi << 8u) | lo);
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
        case 4u: { let nn = z80_fetch_word(); if (check_cc(y)) { z80_push16(cpu_pc); cpu_pc = nn; } }
        case 5u: {
            if (q == 0u) { z80_push16(get_reg16_af(p)); }
            else {
                switch(p) {
                    case 0u: { let nn = z80_fetch_word(); z80_push16(cpu_pc); cpu_pc = nn; } // CALL nn
                    case 1u, 3u: {} // DD/FD prefix handled in z80_step
                    case 2u: { z80_exec_ed(); }
                    default: {}
                }
            }
        }
        case 6u: { z80_alu(y, z80_fetch()); }
        case 7u: { z80_push16(cpu_pc); cpu_pc = y * 8u; } // RST
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
                cpu_halted = 1u;
                cpu_pc = (cpu_pc - 1u) & 0xffffu;
            }
            else { set_reg(y, get_reg(z)); }
        }
        case 2u: { z80_alu(y, get_reg(z)); }
        case 3u: { z80_exec_x3(y, z, p, q); }
        default: {}
    }
}

fn z80_step() {
    // While halted, the CPU keeps executing HALT: each step is an M1 fetch of
    // the same opcode (R increments), PC stays put. It resumes only on interrupt.
    if (cpu_halted != 0u) { r_inc(); return; }
    // Reset per-instruction index-prefix state.
    idx_mode = 0u;
    idx_uses_mem = 0u;
    idx_disp = 0u;

    var op = z80_fetch();
    r_inc(); // M1: opcode (or prefix) fetch
    // A DD/FD prefix selects IX/IY for the following opcode.
    if (op == 0xddu || op == 0xfdu) {
        idx_mode = select(2u, 1u, op == 0xddu);
        let next = z80_fetch();
        r_inc(); // M1: opcode after the prefix
        // A prefix immediately followed by another prefix or ED is a wasted M1:
        // this step consumes just the prefix; back up so the next step restarts
        // at the following byte (matches real Z80 timing and avoids an
        // unbounded fetch loop on all-prefix programs).
        if (next == 0xddu || next == 0xfdu || next == 0xedu) {
            cpu_pc = (cpu_pc - 1u) & 0xffffu;
            return;
        }
        op = next;
    }

    // Host hook: skip execution (treat as NOP) if requested.
    if (on_fetch_opcode(op)) { return; }

    if (idx_mode != 0u) {
        if (op == 0xcbu) {
            // DDCB/FDCB: displacement precedes the CB opcode.
            idx_disp = signext(z80_fetch());
            let cbop = z80_fetch();
            z80_exec_idxcb(cbop);
            return;
        }
        if (op_uses_hl_mem(op)) {
            idx_uses_mem = 1u;
            idx_disp = signext(z80_fetch());
        }
    }
    z80_execute(op);
}
`;
