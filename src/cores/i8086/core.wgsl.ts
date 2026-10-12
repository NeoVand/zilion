/** Original real-mode 8086 instruction set. Written from Intel's 1979 manual and hardware vectors. */
export interface I8086Hooks { fetch?: boolean; instructionStart?: boolean; trap?: boolean; io?: boolean }
export function i8086CoreText(h: I8086Hooks = {}): string {
  return `
var<private> i8086_r: array<u32, 8>; // AX CX DX BX SP BP SI DI
var<private> i8086_s: array<u32, 4>; // ES CS SS DS
var<private> i8086_ip: u32;
var<private> i8086_flags: u32;
var<private> i8086_halted: u32;
var<private> i8086_trap: u32;
// REP is one iteration per world step. Its decoded instruction survives a resume.
var<private> i8086_rep: u32;
var<private> i8086_rep_op: u32;
var<private> i8086_rep_seg: u32;
var<private> i8086_rep_start: u32;
var<private> i8086_rep_end: u32;
var<private> i8086_rep_first: u32;
var<private> i8086_rep_interrupt_ip: u32;
var<private> i8086_tf_suppress: u32;
fn i8086_phys(seg: u32, off: u32) -> u32 { return ((seg << 4u) + (off & 0xffffu)) & 0xfffffu; }
fn i8086_pc() -> u32 { return i8086_phys(i8086_s[1], i8086_ip); }
fn i8086_rb(seg: u32, off: u32) -> u32 { return mem_read(i8086_phys(seg, off)); }
fn i8086_rw(seg: u32, off: u32) -> u32 {
  let lo = i8086_rb(seg, off);
  // Each byte wraps its offset before segment translation (including FFFF -> 0000).
  return lo | (i8086_rb(seg, (off + 1u) & 65535u) << 8u);
}
fn i8086_wb(seg: u32, off: u32, v: u32) { mem_write(i8086_phys(seg, off), v & 255u); }
fn i8086_ww(seg: u32, off: u32, v: u32) {
  let a = i8086_phys(seg, off);
  mem_write(a, v & 255u); mem_write(i8086_phys(seg, (off + 1u) & 65535u), (v >> 8u) & 255u);
}
fn i8086_fetch() -> u32 {
  let a = i8086_pc();
  ${h.fetch ? "on_fetch(a);" : ""}
  let v = mem_read(a); i8086_ip = (i8086_ip + 1u) & 0xffffu; return v;
}
fn i8086_fetchw() -> u32 { let lo = i8086_fetch(); return lo | (i8086_fetch() << 8u); }
fn i8086_get(reg: u32, w: u32) -> u32 {
  if (w != 0u) { return i8086_r[reg]; }
  return (i8086_r[reg & 3u] >> select(0u, 8u, reg >= 4u)) & 255u;
}
fn i8086_set(reg: u32, w: u32, v: u32) {
  if (w != 0u) { i8086_r[reg] = v & 0xffffu; }
  else { let shift = select(0u, 8u, reg >= 4u); let n = reg & 3u;
    i8086_r[n] = (i8086_r[n] & ~(255u << shift)) | ((v & 255u) << shift); }
}
fn i8086_push(v: u32) { i8086_r[4] = (i8086_r[4] - 2u) & 0xffffu; i8086_ww(i8086_s[2], i8086_r[4], v); }
fn i8086_pushsize(v: u32, w: u32) {
  i8086_r[4] = (i8086_r[4] - 2u) & 65535u;
  if (w == 0u) { i8086_wb(i8086_s[2], i8086_r[4], v); } else { i8086_ww(i8086_s[2], i8086_r[4], v); }
}
fn i8086_pop() -> u32 { let v = i8086_rw(i8086_s[2], i8086_r[4]); i8086_r[4] = (i8086_r[4] + 2u) & 0xffffu; return v; }
fn i8086_flag(mask: u32, v: bool) { i8086_flags = (i8086_flags & ~mask) | select(0u, mask, v); }
fn i8086_szp(v: u32, w: u32) {
  let mask = select(255u, 65535u, w != 0u); let sign = select(128u, 32768u, w != 0u); let r = v & mask;
  i8086_flags = (i8086_flags & ~196u) | select(0u, 128u, (r & sign) != 0u) | select(0u, 64u, r == 0u) |
    select(0u, 4u, (countOneBits(r & 255u) & 1u) == 0u);
}
fn i8086_alu(op: u32, a: u32, b: u32, w: u32) -> u32 {
  let mask = select(255u, 65535u, w != 0u); let sign = select(128u, 32768u, w != 0u);
  let carry = select(0u, i8086_flags & 1u, op == 2u || op == 3u);
  var r = 0u;
  if (op == 0u || op == 2u) {
    r = a + b + carry;
    i8086_flag(1u, r > mask); i8086_flag(16u, ((a ^ b ^ r) & 16u) != 0u);
    i8086_flag(2048u, ((~(a ^ b) & (a ^ r)) & sign) != 0u);
  } else if (op == 3u || op == 5u || op == 7u) {
    r = a - b - carry;
    i8086_flag(1u, a < b + carry); i8086_flag(16u, ((a ^ b ^ r) & 16u) != 0u);
    i8086_flag(2048u, (((a ^ b) & (a ^ r)) & sign) != 0u);
  } else {
    switch op { case 1u: { r = a | b; } case 4u: { r = a & b; } default: { r = a ^ b; } }
    i8086_flags &= ~2065u;
  }
  r &= mask; i8086_szp(r, w); return r;
}
fn i8086_inc(a: u32, dec: bool, w: u32) -> u32 {
  let c = i8086_flags & 1u; let v = i8086_alu(select(0u, 5u, dec), a, 1u, w);
  i8086_flags = (i8086_flags & ~1u) | c; return v;
}
fn i8086_signed(v: u32, w: u32) -> i32 { let shift = select(24u, 16u, w != 0u); return (i32(v << shift)) >> shift; }
fn i8086_cond(n: u32) -> bool {
  let f = i8086_flags; let c = (f & 1u) != 0u; let z = (f & 64u) != 0u;
  let s = (f & 128u) != 0u; let o = (f & 2048u) != 0u; var v = false;
  switch (n >> 1u) {
    case 0u: { v = o; } case 1u: { v = c; } case 2u: { v = z; } case 3u: { v = c || z; }
    case 4u: { v = s; } case 5u: { v = (f & 4u) != 0u; } case 6u: { v = s != o; }
    default: { v = z || (s != o); }
  }
  return v != ((n & 1u) != 0u);
}
fn i8086_interrupt(n: u32) {
  // Hardware bus traces: both IVT words are read BEFORE any stack writes.
  let destination = i8086_rw(0u, n * 4u); let seg = i8086_rw(0u, n * 4u + 2u);
  i8086_push((i8086_flags & 0xfd5u) | 0xf002u); i8086_flags &= ~768u;
  i8086_push(i8086_s[1]); i8086_push(i8086_ip); i8086_s[1] = seg; i8086_ip = destination;
  i8086_rep = 0u;
}
fn i8086_raise(cause: u32, vector: u32) {
  ${h.trap ? "let decision = zil_trap(cause);" : "let decision = select(ZIL_TRAP_VECTOR, ZIL_TRAP_HALT, cause == ZIL_TRAP_HALT_INSN || cause == ZIL_TRAP_BOUNDS || cause == ZIL_TRAP_UNIMPLEMENTED);"}
  if (decision == ZIL_TRAP_IGNORE) { return; }
  if (decision == ZIL_TRAP_HALT || cause == ZIL_TRAP_HALT_INSN || cause == ZIL_TRAP_BOUNDS || cause == ZIL_TRAP_UNIMPLEMENTED) {
    i8086_halted = select(ZIL_HALT_TRAP, ZIL_HALT_INSN, cause == ZIL_TRAP_HALT_INSN); i8086_trap = cause;
  } else {
    if (vector == 1u && i8086_rep != 0u) { i8086_ip = i8086_rep_interrupt_ip; }
    i8086_interrupt(vector);
  }
}
fn i8086_shift(op: u32, x: u32, n: u32, w: u32) -> u32 {
  if (n == 0u) { return x; }
  let mask = select(255u, 65535u, w != 0u); let sign = select(128u, 32768u, w != 0u); var v = x;
  if (op == 6u) { v = mask; i8086_flags &= ~2065u; i8086_szp(v, w); return v; }
  for (var k = 0u; k < n; k++) {
    let c = i8086_flags & 1u; var out = 0u; let before = v;
    switch op {
      case 0u: { out = select(0u, 1u, (v & sign) != 0u); v = ((v << 1u) | out) & mask; }
      case 1u: { out = v & 1u; v = (v >> 1u) | select(0u, sign, out != 0u); }
      case 2u: { out = select(0u, 1u, (v & sign) != 0u); v = ((v << 1u) | c) & mask; }
      case 3u: { out = v & 1u; v = (v >> 1u) | select(0u, sign, c != 0u); }
      case 4u: { out = select(0u, 1u, (v & sign) != 0u); v = (v << 1u) & mask; }
      case 5u: { out = v & 1u; v >>= 1u; }
      default: { out = v & 1u; v = (v >> 1u) | (v & sign); }
    }
    i8086_flag(1u, out != 0u);
    if (op == 0u || op == 2u || op == 4u) { i8086_flag(2048u, ((v & sign) != 0u) != (out != 0u)); }
    else if (op == 1u || op == 3u) { i8086_flag(2048u, ((v ^ (v << 1u)) & sign) != 0u); }
    else if (op == 5u) { i8086_flag(2048u, (before & sign) != 0u); }
    else { i8086_flag(2048u, false); }
  }
  if (op >= 4u) { i8086_flag(16u, op == 4u && (v & 16u) != 0u); i8086_szp(v, w); }
  return v;
}
fn i8086_string(op: u32, seg: u32) {
  let w = op & 1u; let d = select(1u + w, 0u - (1u + w), (i8086_flags & 1024u) != 0u);
  var a = 0u; var b = 0u;
  if (op == 164u || op == 165u || op == 166u || op == 167u || op == 172u || op == 173u) {
    if (w == 0u) { a = i8086_rb(seg, i8086_r[6]); } else { a = i8086_rw(seg, i8086_r[6]); }
    i8086_r[6] = (i8086_r[6] + d) & 0xffffu;
  }
  if (op == 166u || op == 167u || op == 174u || op == 175u) {
    if (w == 0u) { b = i8086_rb(i8086_s[0], i8086_r[7]); } else { b = i8086_rw(i8086_s[0], i8086_r[7]); }
    if (op >= 174u) { a = i8086_get(0u, w); }
    let unused = i8086_alu(7u, a, b, w);
  } else if (op == 172u || op == 173u) { i8086_set(0u, w, a); }
  else {
    if (op == 170u || op == 171u) { a = i8086_get(0u, w); }
    if (w == 0u) { i8086_wb(i8086_s[0], i8086_r[7], a); } else { i8086_ww(i8086_s[0], i8086_r[7], a); }
  }
  if (op != 172u && op != 173u) { i8086_r[7] = (i8086_r[7] + d) & 0xffffu; }
}
fn i8086_repeat() {
  if (i8086_r[1] != 0u) {
    i8086_string(i8086_rep_op, i8086_rep_seg); i8086_r[1] = (i8086_r[1] - 1u) & 0xffffu;
  }
  let cmp = i8086_rep_op == 166u || i8086_rep_op == 167u || i8086_rep_op == 174u || i8086_rep_op == 175u;
  let again = i8086_r[1] != 0u && (!cmp || (((i8086_flags & 64u) != 0u) == (i8086_rep == 243u)));
  if (again) { i8086_ip = i8086_rep_start; }
  else { i8086_ip = i8086_rep_end; i8086_rep = 0u; }
}
fn i8086_muldiv(op: u32, a: u32, w: u32, rep: u32) {
  let mask = select(255u, 65535u, w != 0u); let bits = select(8u, 16u, w != 0u);
  if (op == 4u || op == 5u) {
    var product = 0u;
    if (op == 4u) { product = i8086_get(0u, w) * a; }
    else { product = u32(i8086_signed(i8086_get(0u, w), w) * i8086_signed(a, w)); }
    if (rep != 0u) { product = 0u - product; }
    let high = (product >> bits) & mask;
    if (w == 0u) { i8086_r[0] = product & 65535u; }
    else { i8086_r[0] = product & 65535u; i8086_r[2] = high; }
    var overflow = high != 0u;
    if (op == 5u) {
      let unused = i8086_alu(0u, high, select(0u, 1u, (product & (1u << (bits - 1u))) != 0u), w);
      overflow = (i8086_flags & 64u) == 0u;
    } else { i8086_flags &= ~2065u; i8086_szp(high, w); }
    i8086_flag(1u, overflow); i8086_flag(2048u, overflow); return;
  }
  var dividend = i8086_r[0]; if (w != 0u) { dividend |= i8086_r[2] << 16u; }
  let original = dividend; var divisor = a; var negative = rep != 0u;
  if (op == 7u) {
    let negativeDividend = (dividend & (1u << (bits * 2u - 1u))) != 0u;
    let negativeDivisor = (a & (1u << (bits - 1u))) != 0u;
    if (negativeDividend) { dividend = 0u - dividend; if (w == 0u) { dividend &= 65535u; } }
    if (negativeDivisor) { divisor = (0u - a) & mask; }
    negative = (negative != negativeDividend) != negativeDivisor;
  }
  var rem = (dividend >> bits) & mask; var q = 0u;
  let unused = i8086_alu(5u, rem, divisor, w);
  if (rem >= divisor) { i8086_raise(ZIL_TRAP_DIV_ZERO, 0u); return; }
  for (var k = bits; k > 0u; k--) {
    let candidate = (rem << 1u) | ((dividend >> (k - 1u)) & 1u);
    var subtract = candidate >= divisor;
    if (candidate > mask) { i8086_flag(1u, false); }
    else { let cmp = i8086_alu(5u, candidate, divisor, w); }
    if (subtract) { rem = (candidate - divisor) & mask; q |= 1u << (k - 1u); }
    else { rem = candidate; }
  }
  i8086_flag(1u, (q & (1u << (bits - 1u))) == 0u);
  if (op == 7u) {
    if ((q & (1u << (bits - 1u))) != 0u) { i8086_raise(ZIL_TRAP_DIV_ZERO, 0u); return; }
    if ((original & (1u << (bits * 2u - 1u))) != 0u) { rem = (0u - rem) & mask; }
    i8086_flags &= ~2049u;
    if (negative) { q = (0u - q) & mask; }
  }

  if (w == 0u) { i8086_r[0] = q | (rem << 8u); } else { i8086_r[0] = q; i8086_r[2] = rem; }
}
fn i8086_execute() {
  if (i8086_halted != ZIL_RUNNING) { return; }
  if (i8086_rep != 0u) {
    ${h.instructionStart ? `let action = on_instruction_start(i8086_pc(), i8086_rep_first);
    if (action == ZIL_HALT) { i8086_halted = ZIL_HALT_HOST; return; }
    if (action == ZIL_SKIP) { i8086_rep = 0u; i8086_ip = (i8086_rep_start + 1u) & 65535u; return; }` : ""}
    if (on_decode(0u, i8086_rep_op)) { i8086_rep = 0u; i8086_ip = i8086_rep_end; return; }
    i8086_repeat(); return;
  }
  let start = i8086_ip; let pc = i8086_pc(); var op = i8086_fetch(); let first = op;
  ${h.instructionStart ? `let action = on_instruction_start(pc, op);
  if (action == ZIL_HALT) { i8086_ip = start; i8086_halted = ZIL_HALT_HOST; return; }
  if (action == ZIL_SKIP) { return; }` : ""}
  var seg = i8086_s[3]; var segover = false; var rep = 0u;
  for (var prefixes = 0u; prefixes < 65536u; prefixes++) {
    if (op == 38u || op == 46u || op == 54u || op == 62u) { seg = i8086_s[(op >> 3u) & 3u]; segover = true; }
    else if (op == 242u || op == 243u) { rep = op; }
    else if (op != 240u && op != 241u) { break; }
    if (prefixes == 65535u) { i8086_raise(ZIL_TRAP_BOUNDS, 0u); return; }
    op = i8086_fetch();
  }
  if (on_decode(0u, op)) { return; }
  var w = op & 1u; var modrm = 0u; var reg = 0u; var rm = 0u; var mode = 3u; var off = 0u;
  let hasmod = (op < 64u && (op & 7u) < 4u) || (op >= 128u && op <= 143u) ||
    (op >= 196u && op <= 199u) || (op >= 208u && op <= 211u) || (op >= 216u && op <= 223u) || op == 246u || op == 247u || op == 254u || op == 255u;
  if (hasmod) {
    modrm = i8086_fetch(); reg = (modrm >> 3u) & 7u; rm = modrm & 7u; mode = modrm >> 6u;
    if (mode != 3u) {
      switch rm {
        case 0u: { off = i8086_r[3] + i8086_r[6]; }
        case 1u: { off = i8086_r[3] + i8086_r[7]; }
        case 2u: { off = i8086_r[5] + i8086_r[6]; }
        case 3u: { off = i8086_r[5] + i8086_r[7]; }
        case 4u: { off = i8086_r[6]; } case 5u: { off = i8086_r[7]; }
        case 6u: { off = i8086_r[5]; } default: { off = i8086_r[3]; }
      }
      if (!segover && (rm == 2u || rm == 3u || (rm == 6u && mode != 0u))) { seg = i8086_s[2]; }
      if (mode == 0u && rm == 6u) { off = i8086_fetchw(); }
      if (mode == 1u) { off += u32(i8086_signed(i8086_fetch(), 0u)); }
      if (mode == 2u) { off += i8086_fetchw(); }
      off &= 65535u;
    }
  }
  if (mode == 3u && (op == 141u || op == 196u || op == 197u)) {
    // These forms consume hidden EA history, excluded from the hardware vectors.
    i8086_raise(ZIL_TRAP_UNIMPLEMENTED, 0u); return;
  }
  // Shared arithmetic phase, register/memory and accumulator immediate forms.
  if ((op < 64u && (op & 7u) < 6u) || (op >= 128u && op <= 133u)) {
    var kind = (op >> 3u) & 7u; var a = 0u; var b = 0u; var dest = 0u;
    var memory = false;
    if (op < 64u && (op & 7u) >= 4u) { a = i8086_get(0u, w); b = i8086_fetch(); if (w != 0u) { b |= i8086_fetch() << 8u; } }
    else {
      if (op >= 128u && op <= 131u) {
        kind = reg; a = i8086_get(rm, w); dest = rm; memory = mode != 3u;
        b = i8086_fetch(); if (op == 129u) { b |= i8086_fetch() << 8u; }
        if (op == 131u) { b = u32(i8086_signed(b, 0u)) & 65535u; }
      } else {
        let direction = (op & 2u) != 0u && op < 64u;
        if (op >= 132u) { kind = 4u; }
        if (direction) { a = i8086_get(reg, w); b = i8086_get(rm, w); dest = reg;
          if (mode != 3u) { if (w == 0u) { b = i8086_rb(seg, off); } else { b = i8086_rw(seg, off); } }
        } else { a = i8086_get(rm, w); b = i8086_get(reg, w); dest = rm; memory = mode != 3u; }
      }
      if (memory) { if (w == 0u) { a = i8086_rb(seg, off); } else { a = i8086_rw(seg, off); } }
    }
    let v = i8086_alu(kind, a, b, w);
    if (kind != 7u && op != 132u && op != 133u) {
      if (memory) { if (w == 0u) { i8086_wb(seg, off, v); } else { i8086_ww(seg, off, v); } }
      else { i8086_set(dest, w, v); }
    }
    return;
  }
  if (op >= 64u && op <= 79u) { let n = op & 7u; i8086_r[n] = i8086_inc(i8086_r[n], op >= 72u, 1u); return; }
  if (op >= 80u && op <= 87u) { let n = op & 7u; var v = i8086_r[n]; if (n == 4u) { v = (v - 2u) & 65535u; } i8086_push(v); return; }
  if (op >= 88u && op <= 95u) { let v = i8086_pop(); i8086_r[op & 7u] = v; return; }
  if (op >= 96u && op <= 127u) { let disp = u32(i8086_signed(i8086_fetch(), 0u)); if (i8086_cond(op & 15u)) { i8086_ip = (i8086_ip + disp) & 65535u; } return; }
  if (op >= 144u && op <= 151u) { let n = op & 7u; let v = i8086_r[n]; i8086_r[n] = i8086_r[0]; i8086_r[0] = v; return; }
  if (op >= 176u && op <= 191u) { w = select(0u, 1u, op >= 184u); var v = i8086_fetch(); if (w != 0u) { v |= i8086_fetch() << 8u; } i8086_set(op & 7u, w, v); return; }
  if (op == 164u || op == 165u || op == 166u || op == 167u || (op >= 170u && op <= 175u)) {
    if (rep != 0u) { i8086_rep = rep; i8086_rep_first = first; i8086_rep_interrupt_ip = (i8086_ip - 2u) & 65535u; i8086_rep_op = op; i8086_rep_seg = seg; i8086_rep_start = start; i8086_rep_end = i8086_ip; i8086_repeat(); }
    else { i8086_string(op, seg); } return;
  }
  if (op >= 160u && op <= 163u) {
    off = i8086_fetchw(); if (op < 162u) { var v = 0u; if (w == 0u) { v = i8086_rb(seg, off); } else { v = i8086_rw(seg, off); } i8086_set(0u, w, v); }
    else { if (w == 0u) { i8086_wb(seg, off, i8086_get(0u, w)); } else { i8086_ww(seg, off, i8086_r[0]); } } return;
  }
  if (op == 168u || op == 169u) { var b = i8086_fetch(); if (w != 0u) { b |= i8086_fetch() << 8u; } let unused = i8086_alu(4u, i8086_get(0u, w), b, w); return; }
  // Shared ModRM execution phase.
  if (hasmod) {
    if (op == 140u || op == 141u || op == 142u || op == 143u || op >= 196u && op <= 199u) { w = 1u; }
    if (op >= 216u && op <= 223u) { if (mode != 3u) { let unused = i8086_rw(seg, off); } return; }
    var testImmediate = 0u;
    if ((op == 246u || op == 247u) && reg <= 1u) {
      testImmediate = i8086_fetch(); if (w != 0u) { testImmediate |= i8086_fetch() << 8u; }
    }
    var v = i8086_get(rm, w);
    let needsread = op != 136u && op != 137u && op != 140u && op != 141u && op != 143u && op != 198u && op != 199u;
    if (mode != 3u && needsread) { if (w == 0u) { v = i8086_rb(seg, off); } else { v = i8086_rw(seg, off); } }
    var store = false;
    if (op == 134u || op == 135u) { let t = i8086_get(reg, w); i8086_set(reg, w, v); v = t; store = true; }
    else if (op == 136u || op == 137u) { v = i8086_get(reg, w); store = true; }
    else if (op == 138u || op == 139u) { i8086_set(reg, w, v); }
    else if (op == 140u) { v = i8086_s[reg & 3u]; store = true; }
    else if (op == 141u) { i8086_r[reg] = off; }
    else if (op == 142u) { i8086_s[reg & 3u] = v; i8086_tf_suppress = 1u; }
    else if (op == 143u) { v = i8086_pop(); store = true; }
    else if (op == 196u || op == 197u) { i8086_r[reg] = v; i8086_s[select(0u, 3u, op == 197u)] = i8086_rw(seg, (off + 2u) & 65535u); }
    else if (op == 198u || op == 199u) { w = op & 1u; v = i8086_fetch(); if (w != 0u) { v |= i8086_fetch() << 8u; } store = true; }
    else if (op >= 208u && op <= 211u) { let n = select(1u, i8086_r[1] & 255u, op >= 210u); v = i8086_shift(reg, v, n, w); store = true; }
    else if (op == 246u || op == 247u) {
      if (reg <= 1u) { let unused = i8086_alu(4u, v, testImmediate, w); }
      else if (reg == 2u) { v = ~v; store = true; }
      else if (reg == 3u) { v = i8086_alu(5u, 0u, v, w); store = true; }
      else { i8086_muldiv(reg, v, w, rep); }
    } else if (op == 254u || op == 255u) {
      if (reg <= 1u) { v = i8086_inc(v, reg == 1u, w); store = true; }
      else if (reg == 2u) {
        var destination = v;
        if (w == 0u) { destination |= 0xff00u; if (mode == 3u) { let raw = i8086_r[rm & 3u]; destination = select(raw, ((raw >> 8u) | (raw << 8u)) & 65535u, rm >= 4u); } }
        i8086_pushsize(i8086_ip, w); i8086_ip = destination;
      }
      else if (reg == 3u || reg == 5u) {
        var destination = v; var cs = 0u;
        if (w == 0u) {
          destination |= 0xff00u;
          var secondseg = i8086_s[3]; if (rm == 2u || rm == 3u || (rm == 6u && mode != 0u)) { secondseg = i8086_s[2]; }
          cs = i8086_rb(secondseg, off) | 0xff00u;
        } else { cs = i8086_rw(seg, (off + 2u) & 65535u); }
        if (reg == 3u) { i8086_pushsize(i8086_s[1], w); i8086_pushsize(i8086_ip, w); }
        i8086_s[1] = cs; i8086_ip = destination;
      }
      else if (reg == 4u) {
        if (w == 0u) { v |= 0xff00u; if (mode == 3u) { let raw = i8086_r[rm & 3u]; v = select(raw, ((raw >> 8u) | (raw << 8u)) & 65535u, rm >= 4u); } }
        i8086_ip = v;
      }
      else { if (op == 255u && mode == 3u && rm == 4u) { v = (v - 2u) & 65535u; } i8086_pushsize(v, w); }
    }
    if (store) { if (mode == 3u) { i8086_set(rm, w, v); } else if (w == 0u) { i8086_wb(seg, off, v); } else { i8086_ww(seg, off, v); } }
    return;
  }
  switch op {
    case 6u, 14u, 22u, 30u: { i8086_push(i8086_s[(op >> 3u) & 3u]); }
    case 7u, 15u, 23u, 31u: { let v = i8086_pop(); i8086_s[(op >> 3u) & 3u] = v; i8086_tf_suppress = 1u; }
    case 39u, 47u: {
      let old = i8086_r[0] & 255u; let oldf = i8086_flags; var v = old;
      let adjust = (old & 15u) > 9u || (oldf & 16u) != 0u;
      if (adjust) { v = i8086_alu(select(0u, 5u, op == 47u), v, 6u, 0u); }
      let high = old > select(153u, 159u, (oldf & 16u) != 0u) || (oldf & 1u) != 0u;
      if (high) { v = i8086_alu(select(0u, 5u, op == 47u), v, 96u, 0u); }
      i8086_flag(2048u, ((old ^ v) & 128u) != 0u && (((old & 128u) != 0u) == (op == 47u)));
      i8086_flag(16u, adjust); i8086_flag(1u, high); i8086_szp(v, 0u); i8086_set(0u, 0u, v);
    }
    case 55u, 63u: {
      let old = i8086_r[0]; let low = old & 255u;
      let adjust = (low & 15u) > 9u || (i8086_flags & 16u) != 0u;
      var result = old;
      if (adjust) { if (op == 55u) { result = ((old + 256u) & 0xff00u) | ((low + 6u) & 255u); } else { result = ((old - 256u) & 0xff00u) | ((low - 6u) & 255u); } }
      // Undefined flags arise from the byte add/subtract preceding AL's nibble mask.
      let unused = i8086_alu(select(0u, 5u, op == 63u), low, select(0u, 6u, adjust), 0u);
      i8086_flag(1u, adjust); i8086_flag(16u, adjust); i8086_r[0] = result & 0xff0fu;
    }
    case 152u: { i8086_r[0] = u32(i8086_signed(i8086_r[0] & 255u, 0u)) & 65535u; }
    case 153u: { i8086_r[2] = select(0u, 65535u, (i8086_r[0] & 32768u) != 0u); }
    case 154u: { let destination = i8086_fetchw(); let cs = i8086_fetchw(); i8086_push(i8086_s[1]); i8086_push(i8086_ip); i8086_s[1] = cs; i8086_ip = destination; }
    case 155u: {} // WAIT without a coprocessor
    case 156u: { i8086_push((i8086_flags & 0xfd5u) | 0xf002u); }
    case 157u: { i8086_flags = (i8086_pop() & 0xfd5u) | 0xf002u; }
    case 158u: { i8086_flags = (i8086_flags & ~213u) | ((i8086_r[0] >> 8u) & 213u); }
    case 159u: { i8086_r[0] = (i8086_r[0] & 255u) | ((i8086_flags & 213u | 2u) << 8u); }
    case 192u, 193u, 194u, 195u, 200u, 201u, 202u, 203u: {
      var extra = 0u; if ((op & 1u) == 0u) { extra = i8086_fetchw(); }
      let destination = i8086_pop(); if (op >= 200u) { i8086_s[1] = i8086_pop(); }
      i8086_ip = destination; i8086_r[4] = (i8086_r[4] + extra) & 65535u;
    }
    case 204u: { i8086_raise(ZIL_TRAP_SYSCALL, 3u); }
    case 205u: { let n = i8086_fetch(); i8086_raise(ZIL_TRAP_SYSCALL, n); }
    case 206u: { if ((i8086_flags & 2048u) != 0u) { i8086_raise(ZIL_TRAP_SYSCALL, 4u); } }
    case 207u: { let destination = i8086_pop(); let cs = i8086_pop(); let flags = i8086_pop(); i8086_ip = destination; i8086_s[1] = cs; i8086_flags = (flags & 0xfd5u) | 0xf002u; }
    case 212u: { let base = i8086_fetch(); let a = i8086_r[0] & 255u; if (base == 0u) { let unused = i8086_alu(5u, 0u, 0u, 0u); i8086_raise(ZIL_TRAP_DIV_ZERO, 0u); }
      else { i8086_r[0] = ((a / base) << 8u) | (a % base); i8086_flags &= ~2065u; i8086_szp(a % base, 0u); } }
    case 213u: { let base = i8086_fetch(); let a = (i8086_r[0] >> 8u) * base; i8086_r[0] = i8086_alu(0u, i8086_r[0] & 255u, a & 255u, 0u); }
    case 214u: { i8086_set(0u, 0u, select(0u, 255u, (i8086_flags & 1u) != 0u)); }
    case 215u: { i8086_set(0u, 0u, i8086_rb(seg, (i8086_r[3] + (i8086_r[0] & 255u)) & 65535u)); }
    case 224u, 225u, 226u, 227u: {
      let disp = u32(i8086_signed(i8086_fetch(), 0u)); var take = false;
      if (op == 227u) { take = i8086_r[1] == 0u; }
      else { i8086_r[1] = (i8086_r[1] - 1u) & 65535u; take = i8086_r[1] != 0u;
        if (op < 226u) { take = take && (((i8086_flags & 64u) != 0u) == (op == 225u)); } }
      if (take) { i8086_ip = (i8086_ip + disp) & 65535u; }
    }
    case 228u, 229u, 230u, 231u, 236u, 237u, 238u, 239u: {
      var port = i8086_r[2]; if (op < 232u) { port = i8086_fetch(); }
      if ((op & 2u) == 0u) {
        var v = ${h.io ? "io_in(port)" : "255u"};
        if (w != 0u) { v |= ${h.io ? "io_in((port + 1u) & 65535u)" : "255u"} << 8u; } i8086_set(0u, w, v);
      } else {
        ${h.io ? "io_out(port, i8086_r[0] & 255u); if (w != 0u) { io_out((port + 1u) & 65535u, i8086_r[0] >> 8u); }" : ""}
      }
    }
    case 232u: { let disp = i8086_fetchw(); let next = i8086_ip; i8086_push(next); i8086_ip = (next + disp) & 65535u; }
    case 233u: { let disp = i8086_fetchw(); i8086_ip = (i8086_ip + disp) & 65535u; }
    case 234u: { let destination = i8086_fetchw(); let cs = i8086_fetchw(); i8086_ip = destination; i8086_s[1] = cs; }
    case 235u: { let disp = u32(i8086_signed(i8086_fetch(), 0u)); i8086_ip = (i8086_ip + disp) & 65535u; }
    case 244u: { i8086_raise(ZIL_TRAP_HALT_INSN, 0u); }
    case 245u: { i8086_flags ^= 1u; }
    case 248u: { i8086_flags &= ~1u; } case 249u: { i8086_flags |= 1u; }
    case 250u: { i8086_flags &= ~512u; } case 251u: { i8086_flags |= 512u; }
    case 252u: { i8086_flags &= ~1024u; } case 253u: { i8086_flags |= 1024u; }
    default: { i8086_raise(ZIL_TRAP_UNIMPLEMENTED, 0u); }
  }
}
fn i8086_step() {
  if (i8086_halted != ZIL_RUNNING) { return; }
  let tf = (i8086_flags & 256u) != 0u;
  i8086_tf_suppress = 0u;
  i8086_execute();
  if (tf && i8086_tf_suppress == 0u && i8086_halted == ZIL_RUNNING) {
    i8086_raise(ZIL_TRAP_SYSCALL, 1u);
  }
}
`;
}
