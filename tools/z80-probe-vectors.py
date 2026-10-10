#!/usr/bin/env python3
"""Write analytic R and WZ (MEMPTR) probes for the Z80 (SingleStepTests format), one file per table row.

Every expected value is derived by hand from the documented rules, not from an emulator:
  * WZ: design 2026-10-10 §5.3, from the MEMPTR documents (boo_boo and Vladimir Kladov, "MEMPTR, esoteric register
    of the Zilog Z80 CPU"), and for block repeats the redcode Z80 Block Flags Test notes (WZ = PC + 1 when a block
    instruction repeats; X/Y from PC bits 13 and 11; INxR/OTxR also adjust H and P/V);
  * R: design §5.2 and Sean Young, "The Undocumented Z80 Documented" (R counts M1 cycles in its low 7 bits, bit 7
    kept; CB, ED, DD and FD are M1 cycles, a DDCB displacement and opcode are not; a wasted prefix is one M1);
  * flags: Sean Young's tables (S, Z, X, Y from the result unless noted; H, P/V, N, C per instruction).
Each test fixes the full state, so a probe also checks every register, memory and port its instruction touches. The
edge cases are the point: 16-bit wraps of WZ, the low-byte-only increment of LD (rp),A / LD (nn),A / OUT (n),A,
JP cc and CALL cc not taken (WZ still set), JR cc and RET cc not taken (WZ kept), IN C,(C) (BC before the load).

Q: initial Q is 0; the final Q is F when the instruction writes the flags and 0 otherwise (Zilog NMOS), so the
zilog-nmos variant checks it and the classic variant's Q rule explains it. ei and p are 0 before and after.

The files are written to test/vectors/z80/analytic/probes/ (a separate directory, so the 0.2.0 baseline's inputs,
test/vectors/z80/analytic/, stay as they were). File keys start with "wz " or "r " and never collide with
SingleStepTests keys; the vector adapter reports them in the group "probe".

Usage: python -I tools/z80-probe-vectors.py [out_dir]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

FIELDS = ("pc", "sp", "a", "b", "c", "d", "e", "f", "h", "l", "i", "r", "ix", "iy", "af_", "bc_", "de_", "hl_",
          "iff1", "iff2", "im", "ei", "p", "q", "wz")
BASE = {k: 0 for k in FIELDS} | {"pc": 0x4000, "sp": 0x8000, "a": 0x5A, "b": 0x12, "c": 0x34, "d": 0x56, "e": 0x78,
                                  "f": 0x01, "h": 0x9A, "l": 0xBC, "i": 0x3F, "r": 0x10, "ix": 0x1357, "iy": 0x2468,
                                  "af_": 0x1111, "bc_": 0x2222, "de_": 0x3333, "hl_": 0x4444, "wz": 0x0F0F}

S, Z, Y, H, X, P, N, C = 0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01


def par(v: int) -> int:
    return P if bin(v & 0xFF).count("1") % 2 == 0 else 0


def sz53(v: int) -> int:
    v &= 0xFF
    return (v & (S | Y | X)) | (Z if v == 0 else 0)


def r_plus(r: int, m1: int) -> int:
    return (r & 0x80) | ((r + m1) & 0x7F)


FILES: dict[str, list] = {}


def probe(key: str, code: list[int], *, init: dict | None = None, ram: dict | None = None, out: dict | None = None,
          ram_out: dict | None = None, m1: int = 1, length: int | None = None, ports=None, writes_f: bool = False):
    """One test: `code` at PC, `init` over BASE, `ram` extra initial bytes; `out` changes (pc defaults to PC + length,
    r to R + m1); `ram_out` final bytes that differ; `writes_f` sets the final Q to the final F."""
    s0 = BASE | (init or {})
    pc = s0["pc"]
    mem0 = {(pc + k) & 0xFFFF: b for k, b in enumerate(code)} | (ram or {})
    s1 = dict(s0)
    s1["pc"] = (pc + (len(code) if length is None else length)) & 0xFFFF
    s1["r"] = r_plus(s0["r"], m1)
    s1 |= out or {}
    s1["q"] = s1["f"] if writes_f else 0
    mem1 = mem0 | (ram_out or {})
    for k, v in s0.items():
        assert 0 <= v < (1 << 16), (key, k, v)
    tests = FILES.setdefault(key, [])
    t = {"name": f"{key} {len(tests):04x}", "initial": s0 | {"ram": sorted([a, v] for a, v in mem0.items())},
         "final": s1 | {"ram": sorted([a, v] for a, v in mem1.items())}}
    if ports:
        t["ports"] = ports
    tests.append(t)


def w16(a: int, v: int) -> dict:
    return {a & 0xFFFF: v & 0xFF, (a + 1) & 0xFFFF: (v >> 8) & 0xFF}


# ---------------------------------------------------------------------------------------------------- WZ rows
def wz_loads() -> None:
    # LD A,(BC) / LD A,(DE): WZ = rp + 1 (16-bit)
    for bc in (0x12FF, 0xFFFF):
        probe("wz 0a", [0x0A], init={"b": bc >> 8, "c": bc & 0xFF}, ram={bc: 0x99}, out={"a": 0x99, "wz": (bc + 1) & 0xFFFF})
    probe("wz 1a", [0x1A], init={"d": 0x80, "e": 0x00}, ram={0x8000: 0x42}, out={"a": 0x42, "wz": 0x8001})
    # LD (BC),A / LD (DE),A: WZ = (A << 8) | ((rp + 1) & 0xFF): the low byte wraps without a carry into the high byte
    probe("wz 02", [0x02], init={"a": 0x5A, "b": 0x34, "c": 0xFF}, ram={0x34FF: 0}, ram_out={0x34FF: 0x5A}, out={"wz": 0x5A00})
    probe("wz 12", [0x12], init={"a": 0xC3, "d": 0x12, "e": 0x34}, ram={0x1234: 0}, ram_out={0x1234: 0xC3}, out={"wz": 0xC335})
    # LD A,(nn): WZ = nn + 1; LD (nn),A: WZ = (A << 8) | ((nn + 1) & 0xFF)
    probe("wz 3a", [0x3A, 0xFF, 0xFF], ram={0xFFFF: 0x77}, out={"a": 0x77, "wz": 0x0000})
    probe("wz 3a", [0x3A, 0x34, 0x12], ram={0x1234: 0x01}, out={"a": 0x01, "wz": 0x1235})
    probe("wz 32", [0x32, 0xFF, 0x12], init={"a": 0x77}, ram={0x12FF: 0}, ram_out={0x12FF: 0x77}, out={"wz": 0x7700})
    # 16-bit loads and stores through (nn): WZ = nn + 1
    probe("wz 2a", [0x2A, 0xFF, 0xFF], ram={0xFFFF: 0x34, 0x0000: 0x12}, out={"h": 0x12, "l": 0x34, "wz": 0x0000})
    probe("wz 22", [0x22, 0x00, 0x90], ram=w16(0x9000, 0), ram_out=w16(0x9000, 0x9ABC), out={"wz": 0x9001})
    probe("wz dd 2a", [0xDD, 0x2A, 0x10, 0x90], ram=w16(0x9010, 0xBEEF), out={"ix": 0xBEEF, "wz": 0x9011}, m1=2)
    probe("wz fd 22", [0xFD, 0x22, 0x10, 0x90], ram=w16(0x9010, 0), ram_out=w16(0x9010, 0x2468), out={"wz": 0x9011}, m1=2)
    probe("wz ed 4b", [0xED, 0x4B, 0x20, 0x90], ram=w16(0x9020, 0xCAFE), out={"b": 0xCA, "c": 0xFE, "wz": 0x9021}, m1=2)
    probe("wz ed 73", [0xED, 0x73, 0xFF, 0xFF], ram=w16(0xFFFF, 0), ram_out=w16(0xFFFF, 0x8000), out={"wz": 0x0000}, m1=2)


def add16_flags(f: int, a: int, b: int, carry_in: int, sub: bool, full: bool) -> tuple[int, int]:
    """ADD (full=False: S, Z, P/V kept) or ADC/SBC (full=True) on 16 bits. X/Y from the high byte of the result."""
    if sub:
        r = a - b - carry_in
        res = r & 0xFFFF
        h = ((a ^ b ^ r) >> 8) & H
        c = C if r < 0 else 0
        v = P if ((a ^ b) & (a ^ res) & 0x8000) else 0
    else:
        r = a + b + carry_in
        res = r & 0xFFFF
        h = ((a ^ b ^ r) >> 8) & H
        c = C if r > 0xFFFF else 0
        v = P if (~(a ^ b) & (a ^ res) & 0x8000) else 0
    xy = (res >> 8) & (X | Y)
    if not full:
        return res, (f & (S | Z | P)) | h | c | xy
    return res, ((res >> 8) & S) | (Z if res == 0 else 0) | h | v | (N if sub else 0) | c | xy


def wz_arith() -> None:
    # ADD HL,rr / ADD IX,rr / ADC HL,rr / SBC HL,rr: WZ = the first operand + 1, before the operation
    hl, bc = 0xFFFF, 0x0001
    res, f = add16_flags(0xC5, hl, bc, 0, False, False)
    probe("wz 09", [0x09], init={"h": 0xFF, "l": 0xFF, "b": 0x00, "c": 0x01, "f": 0xC5},
          out={"h": res >> 8, "l": res & 0xFF, "f": f, "wz": 0x0000}, writes_f=True)
    res, f = add16_flags(0x00, 0x0FFF, 0x0FFF, 0, False, False)
    probe("wz dd 29", [0xDD, 0x29], init={"ix": 0x0FFF, "f": 0x00}, out={"ix": res, "f": f, "wz": 0x1000}, m1=2, writes_f=True)
    res, f = add16_flags(0x01, 0x7FFF, 0x0000, 1, False, True)
    probe("wz ed 4a", [0xED, 0x4A], init={"h": 0x7F, "l": 0xFF, "b": 0, "c": 0, "f": 0x01},
          out={"h": res >> 8, "l": res & 0xFF, "f": f, "wz": 0x8000}, m1=2, writes_f=True)
    res, f = add16_flags(0x00, 0x0000, 0x0001, 0, True, True)
    probe("wz ed 42", [0xED, 0x42], init={"h": 0, "l": 0, "b": 0, "c": 1, "f": 0x00},
          out={"h": res >> 8, "l": res & 0xFF, "f": f, "wz": 0x0001}, m1=2, writes_f=True)
    # RLD / RRD: WZ = HL + 1. A low nibble <-> (HL) nibbles; S Z X Y P from A, H = N = 0, C kept.
    a, m = 0x12, 0x34
    a1, m1_ = (a & 0xF0) | (m >> 4), ((m << 4) | (a & 0x0F)) & 0xFF
    probe("wz ed 6f", [0xED, 0x6F], init={"a": a, "h": 0xFF, "l": 0xFF, "f": 0x01}, ram={0xFFFF: m}, ram_out={0xFFFF: m1_},
          out={"a": a1, "f": sz53(a1) | par(a1) | C, "wz": 0x0000}, m1=2, writes_f=True)
    a1, m1_ = (a & 0xF0) | (m & 0x0F), ((a << 4) | (m >> 4)) & 0xFF
    probe("wz ed 67", [0xED, 0x67], init={"a": a, "h": 0x20, "l": 0x00, "f": 0x00}, ram={0x2000: m}, ram_out={0x2000: m1_},
          out={"a": a1, "f": sz53(a1) | par(a1), "wz": 0x2001}, m1=2, writes_f=True)


def wz_jumps() -> None:
    pc = 0x4000
    # JR e: WZ = target. JR cc: taken -> target; not taken -> WZ kept.
    probe("wz 18", [0x18, 0xFE], out={"pc": pc, "wz": pc})                            # JR -2: to itself
    probe("wz 20", [0x20, 0x10], init={"f": 0x00}, out={"pc": pc + 0x12, "wz": pc + 0x12})  # JR NZ taken
    probe("wz 20", [0x20, 0x10], init={"f": Z})                                       # not taken: WZ kept
    probe("wz 10", [0x10, 0x80], init={"b": 2}, out={"b": 1, "pc": pc + 2 - 128, "wz": pc + 2 - 128})  # DJNZ taken
    probe("wz 10", [0x10, 0x80], init={"b": 1}, out={"b": 0})                         # DJNZ not taken: WZ kept
    # JP nn; JP cc,nn sets WZ = nn whether or not it is taken
    probe("wz c3", [0xC3, 0x34, 0x12], out={"pc": 0x1234, "wz": 0x1234})
    probe("wz c2", [0xC2, 0x34, 0x12], init={"f": 0x00}, out={"pc": 0x1234, "wz": 0x1234})
    probe("wz c2", [0xC2, 0x34, 0x12], init={"f": Z}, out={"wz": 0x1234})
    # CALL nn; CALL cc,nn sets WZ = nn whether or not it is taken
    ret = pc + 3
    probe("wz cd", [0xCD, 0x78, 0x56], ram=w16(0x7FFE, 0), ram_out=w16(0x7FFE, ret), out={"pc": 0x5678, "sp": 0x7FFE, "wz": 0x5678})
    probe("wz c4", [0xC4, 0x78, 0x56], init={"f": Z}, out={"wz": 0x5678})
    probe("wz c4", [0xC4, 0x78, 0x56], init={"f": 0}, ram=w16(0x7FFE, 0), ram_out=w16(0x7FFE, ret),
          out={"pc": 0x5678, "sp": 0x7FFE, "wz": 0x5678})
    # RET; RET cc taken -> popped PC; not taken -> WZ kept; RETN -> popped PC (and IFF1 = IFF2)
    probe("wz c9", [0xC9], ram=w16(0x8000, 0xABCD), out={"pc": 0xABCD, "sp": 0x8002, "wz": 0xABCD})
    probe("wz c0", [0xC0], init={"f": 0}, ram=w16(0x8000, 0xABCD), out={"pc": 0xABCD, "sp": 0x8002, "wz": 0xABCD})
    probe("wz c0", [0xC0], init={"f": Z}, ram=w16(0x8000, 0xABCD))
    probe("wz ed 45", [0xED, 0x45], init={"iff1": 0, "iff2": 1}, ram=w16(0x8000, 0x0102),
          out={"pc": 0x0102, "sp": 0x8002, "wz": 0x0102, "iff1": 1}, m1=2)
    # RST p: WZ = p
    probe("wz ff", [0xFF], ram=w16(0x7FFE, 0), ram_out=w16(0x7FFE, pc + 1), out={"pc": 0x38, "sp": 0x7FFE, "wz": 0x38})
    # EX (SP),HL / EX (SP),IX: WZ = the new HL / IX
    probe("wz e3", [0xE3], ram=w16(0x8000, 0x1122), ram_out=w16(0x8000, 0x9ABC), out={"h": 0x11, "l": 0x22, "wz": 0x1122})
    probe("wz dd e3", [0xDD, 0xE3], ram=w16(0x8000, 0x3344), ram_out=w16(0x8000, 0x1357), out={"ix": 0x3344, "wz": 0x3344}, m1=2)
    # Left alone: JP (HL), LD SP,HL, PUSH, POP, LDI
    probe("wz e9", [0xE9], out={"pc": 0x9ABC})
    probe("wz f9", [0xF9], out={"sp": 0x9ABC})
    probe("wz c5", [0xC5], ram=w16(0x7FFE, 0), ram_out=w16(0x7FFE, 0x1234), out={"sp": 0x7FFE})
    probe("wz c1", [0xC1], ram=w16(0x8000, 0xFEDC), out={"b": 0xFE, "c": 0xDC, "sp": 0x8002})


def inc8_flags(f: int, v: int) -> tuple[int, int]:
    r = (v + 1) & 0xFF
    return r, (f & C) | sz53(r) | (P if v == 0x7F else 0) | (H if (r & 0x0F) == 0 else 0)


def bit_flags(f: int, n: int, v: int, xy_src: int) -> int:
    z = (v >> n) & 1 == 0
    return (f & C) | H | ((Z | P) if z else 0) | (S if n == 7 and not z else 0) | (xy_src & (X | Y))


def wz_index() -> None:
    # Every (IX+d)/(IY+d) instruction: WZ = IX/IY + d (16-bit, d signed)
    probe("wz dd 7e", [0xDD, 0x7E, 0x80], init={"ix": 0x0010}, ram={0xFF90: 0x66}, out={"a": 0x66, "wz": 0xFF90}, m1=2)
    probe("wz fd 36", [0xFD, 0x36, 0x05, 0xAA], init={"iy": 0xFFFE}, ram={0x0003: 0}, ram_out={0x0003: 0xAA}, out={"wz": 0x0003}, m1=2)
    r, f = inc8_flags(0x00, 0x7F)
    probe("wz dd 34", [0xDD, 0x34, 0x01], init={"ix": 0x2000, "f": 0x00}, ram={0x2001: 0x7F}, ram_out={0x2001: r},
          out={"f": f, "wz": 0x2001}, m1=2, writes_f=True)
    # DDCB: WZ = IX + d; BIT n,(IX+d) X/Y from its high byte (two M1 cycles: DD and CB)
    probe("wz dd cb __ 46", [0xDD, 0xCB, 0x02, 0x46], init={"ix": 0x27FE, "f": 0x00}, ram={0x2800: 0x01},
          out={"f": bit_flags(0x00, 0, 0x01, 0x28), "wz": 0x2800}, m1=2, writes_f=True)
    probe("wz fd cb __ c6", [0xFD, 0xCB, 0xFF, 0xC6], init={"iy": 0x0000}, ram={0xFFFF: 0x00}, ram_out={0xFFFF: 0x01},
          out={"wz": 0xFFFF}, m1=2)


def wz_bit_hl() -> None:
    # BIT n,(HL): S Z P H N C as usual, X/Y from WZ bits 13 and 11, not from the operand
    for wz, v, n in ((0x2800, 0x00, 0), (0x0000, 0xFF, 7), (0x08FF, 0x28, 3), (0x2000, 0x80, 7)):
        probe("wz cb 46" if n == 0 else ("wz cb 7e" if n == 7 else "wz cb 5e"), [0xCB, 0x46 | (n << 3)],
              init={"wz": wz, "h": 0x30, "l": 0x00, "f": 0x01}, ram={0x3000: v},
              out={"f": bit_flags(0x01, n, v, wz >> 8)}, m1=2, writes_f=True)


def wz_io() -> None:
    # IN A,(n): port (A << 8) | n; WZ = port + 1 (16-bit); flags kept
    probe("wz db", [0xDB, 0xFF], init={"a": 0x12}, ports=[[0x12FF, 0x9C, "r"]], out={"a": 0x9C, "wz": 0x1300})
    # OUT (n),A: port (A << 8) | n; WZ = (A << 8) | ((n + 1) & 0xFF)
    probe("wz d3", [0xD3, 0xFF], init={"a": 0x12}, ports=[[0x12FF, 0x12, "w"]], out={"wz": 0x1200})
    # IN r,(C): r <- port BC; S Z X Y P from the value, H = N = 0, C kept; WZ = BC + 1 (BC before the load)
    probe("wz ed 78", [0xED, 0x78], init={"b": 0xFF, "c": 0xFF, "f": 0x01}, ports=[[0xFFFF, 0x80, "r"]],
          out={"a": 0x80, "f": sz53(0x80) | par(0x80) | C, "wz": 0x0000}, m1=2, writes_f=True)
    probe("wz ed 48", [0xED, 0x48], init={"b": 0x12, "c": 0x34, "f": 0x00}, ports=[[0x1234, 0x00, "r"]],
          out={"c": 0x00, "f": Z | P, "wz": 0x1235}, m1=2, writes_f=True)
    probe("wz ed 70", [0xED, 0x70], init={"b": 0x00, "c": 0x10, "f": 0x00}, ports=[[0x0010, 0x28, "r"]],
          out={"f": sz53(0x28) | par(0x28), "wz": 0x0011}, m1=2, writes_f=True)
    # OUT (C),r and OUT (C),0: port BC; WZ = BC + 1
    probe("wz ed 79", [0xED, 0x79], init={"a": 0x55, "b": 0xAB, "c": 0xFF}, ports=[[0xABFF, 0x55, "w"]], out={"wz": 0xAC00}, m1=2)
    probe("wz ed 71", [0xED, 0x71], init={"b": 0x00, "c": 0x07}, ports=[[0x0007, 0x00, "w"]], out={"wz": 0x0008}, m1=2)


def ld_block(f: int, a: int, v: int, bc1: int, pc_rep: int | None) -> int:
    """LDI/LDD flags: S Z C kept, H = N = 0, P/V = BC != 0; X/Y from n = v + A (X = bit 3, Y = bit 1), or from PC
    bits 11 and 13 when the instruction repeats."""
    n = (v + a) & 0xFF
    xy = (n & X) | (Y if n & 0x02 else 0)
    if pc_rep is not None:
        xy = (pc_rep >> 8) & (X | Y)
    return (f & (S | Z | C)) | (P if bc1 else 0) | xy


def cp_block(f: int, a: int, v: int, bc1: int, pc_rep: int | None) -> int:
    """CPI/CPD flags: S Z H from A - v, N = 1, P/V = BC != 0, C kept; X/Y from n = A - v - H (X = bit 3, Y = bit
    1), or from PC bits 11 and 13 when the instruction repeats."""
    r = (a - v) & 0xFF
    h = (a ^ v ^ r) & H
    n = (r - (1 if h else 0)) & 0xFF
    xy = (n & X) | (Y if n & 0x02 else 0)
    if pc_rep is not None:
        xy = (pc_rep >> 8) & (X | Y)
    return (f & C) | (r & S) | (Z if r == 0 else 0) | h | N | (P if bc1 else 0) | xy


def io_block(v: int, k: int, b1: int, pc_rep: int | None) -> int:
    """INI/IND/OUTI/OUTD flags (B already decremented, k the 9-bit sum): S Z X Y from B, N = bit 7 of the value,
    H = C = (k > 255), P/V = parity((k & 7) ^ B). Repeating (B != 0): X/Y from PC bits 11 and 13, and if C: H and
    P/V from B -/+ 1 (N set / clear: H = (B & 15) == 0 / == 15, P/V ^= parity((B -/+ 1) & 7) ^ 1), else
    P/V ^= parity(B & 7) ^ 1."""
    c = k > 0xFF
    f = sz53(b1) | (N if v & 0x80 else 0) | ((H | C) if c else 0) | par((k & 7) ^ b1)
    if pc_rep is None:
        return f
    f = (f & ~(X | Y)) | ((pc_rep >> 8) & (X | Y))
    pb = b1
    if c:
        if v & 0x80:
            pb = (b1 - 1) & 0xFF
            f = (f & ~H) | (H if (b1 & 0x0F) == 0x00 else 0)
        else:
            pb = (b1 + 1) & 0xFF
            f = (f & ~H) | (H if (b1 & 0x0F) == 0x0F else 0)
    if not par(pb & 7):
        f ^= P
    return f


def wz_block() -> None:
    pc = 0x2900  # PC bits 13 and 11 set: X and Y come out set when the instruction repeats
    # LDI leaves WZ alone; LDIR/LDDR repeating: WZ = PC + 1; LDIR finishing (BC = 1): WZ kept
    probe("wz ed a0", [0xED, 0xA0], init={"pc": pc, "a": 0x00, "h": 0x10, "l": 0x00, "d": 0x20, "e": 0x00, "b": 0, "c": 2, "f": 0xC1},
          ram={0x1000: 0x0A, 0x2000: 0}, ram_out={0x2000: 0x0A},
          out={"h": 0x10, "l": 0x01, "d": 0x20, "e": 0x01, "c": 1, "f": ld_block(0xC1, 0, 0x0A, 1, None)}, m1=2, writes_f=True)
    probe("wz ed b0", [0xED, 0xB0], init={"pc": pc, "a": 0x00, "h": 0x10, "l": 0x00, "d": 0x20, "e": 0x00, "b": 0, "c": 2, "f": 0x00},
          ram={0x1000: 0x00, 0x2000: 0}, ram_out={0x2000: 0x00},
          out={"pc": pc, "l": 0x01, "e": 0x01, "c": 1, "f": ld_block(0, 0, 0x00, 1, pc), "wz": pc + 1}, m1=2, writes_f=True)
    probe("wz ed b0", [0xED, 0xB0], init={"pc": pc, "a": 0x00, "h": 0x10, "l": 0x00, "d": 0x20, "e": 0x00, "b": 0, "c": 1, "f": 0x00},
          ram={0x1000: 0x0A, 0x2000: 0}, ram_out={0x2000: 0x0A},
          out={"l": 0x01, "e": 0x01, "c": 0, "f": ld_block(0, 0, 0x0A, 0, None)}, m1=2, writes_f=True)
    probe("wz ed b8", [0xED, 0xB8], init={"pc": 0x0100, "a": 0x01, "h": 0x10, "l": 0x00, "d": 0x20, "e": 0x00, "b": 1, "c": 0, "f": 0x00},
          ram={0x1000: 0x0A, 0x2000: 0}, ram_out={0x2000: 0x0A},
          out={"pc": 0x0100, "h": 0x0F, "l": 0xFF, "d": 0x1F, "e": 0xFF, "b": 0, "c": 0xFF,
               "f": ld_block(0, 1, 0x0A, 1, 0x0100), "wz": 0x0101}, m1=2, writes_f=True)
    # CPI: WZ + 1 (wraps); CPD: WZ - 1 (wraps); CPIR repeating: PC + 1; CPIR stopping on a match: WZ + 1
    probe("wz ed a1", [0xED, 0xA1], init={"pc": pc, "wz": 0xFFFF, "a": 0x10, "h": 0x10, "l": 0x00, "b": 0, "c": 5, "f": 0x01},
          ram={0x1000: 0x01}, out={"l": 0x01, "c": 4, "f": cp_block(0x01, 0x10, 0x01, 4, None), "wz": 0x0000}, m1=2, writes_f=True)
    probe("wz ed a9", [0xED, 0xA9], init={"pc": pc, "wz": 0x0000, "a": 0x10, "h": 0x10, "l": 0x00, "b": 0, "c": 1, "f": 0x00},
          ram={0x1000: 0x10}, out={"h": 0x0F, "l": 0xFF, "c": 0, "f": cp_block(0, 0x10, 0x10, 0, None), "wz": 0xFFFF}, m1=2, writes_f=True)
    probe("wz ed b1", [0xED, 0xB1], init={"pc": pc, "wz": 0x1234, "a": 0x10, "h": 0x10, "l": 0x00, "b": 0, "c": 5, "f": 0x00},
          ram={0x1000: 0x01}, out={"pc": pc, "l": 0x01, "c": 4, "f": cp_block(0, 0x10, 0x01, 4, pc), "wz": pc + 1}, m1=2, writes_f=True)
    probe("wz ed b1", [0xED, 0xB1], init={"pc": pc, "wz": 0x1234, "a": 0x10, "h": 0x10, "l": 0x00, "b": 0, "c": 5, "f": 0x00},
          ram={0x1000: 0x10}, out={"l": 0x01, "c": 4, "f": cp_block(0, 0x10, 0x10, 4, None), "wz": 0x1235}, m1=2, writes_f=True)
    # INI: port BC (before B - 1) -> (HL); WZ = BC(before) + 1; IND: BC(before) - 1; INIR repeating: PC + 1
    for key, op, dec in (("wz ed a2", 0xA2, False), ("wz ed aa", 0xAA, True)):
        b0, c0, v = 0x05, 0x10, 0x81
        k = v + (((c0 - 1) if dec else (c0 + 1)) & 0xFF)
        hl1 = 0x2FFF if dec else 0x3001
        probe(key, [0xED, op], init={"pc": pc, "b": b0, "c": c0, "h": 0x30, "l": 0x00}, ram={0x3000: 0},
              ram_out={0x3000: v}, ports=[[(b0 << 8) | c0, v, "r"]],
              out={"b": b0 - 1, "h": hl1 >> 8, "l": hl1 & 0xFF, "f": io_block(v, k, b0 - 1, None),
                   "wz": ((b0 << 8) | c0) + (-1 if dec else 1)}, m1=2, writes_f=True)
    for v, c0 in ((0x81, 0xF0), (0x01, 0xF0), (0x01, 0x10)):  # carry with N set, carry with N clear, no carry
        b0 = 0x10
        k = v + ((c0 + 1) & 0xFF)
        probe("wz ed b2", [0xED, 0xB2], init={"pc": pc, "b": b0, "c": c0, "h": 0x30, "l": 0x00}, ram={0x3000: 0},
              ram_out={0x3000: v}, ports=[[(b0 << 8) | c0, v, "r"]],
              out={"pc": pc, "b": b0 - 1, "l": 0x01, "f": io_block(v, k, b0 - 1, pc), "wz": pc + 1}, m1=2, writes_f=True)
    # OUTI: (HL) -> port BC (after B - 1); WZ = BC(after) + 1; OUTD: BC(after) - 1; OTIR repeating: PC + 1
    for key, op, dec in (("wz ed a3", 0xA3, False), ("wz ed ab", 0xAB, True)):
        b0, c0, v = 0x01, 0x00, 0x7F
        hl1 = 0x2FFF if dec else 0x3001
        probe(key, [0xED, op], init={"pc": pc, "b": b0, "c": c0, "h": 0x30, "l": 0x00}, ram={0x3000: v},
              ports=[[((b0 - 1) << 8) | c0, v, "w"]],
              out={"b": b0 - 1, "h": hl1 >> 8, "l": hl1 & 0xFF, "f": io_block(v, v + (hl1 & 0xFF), b0 - 1, None),
                   "wz": ((((b0 - 1) << 8) | c0) + (-1 if dec else 1)) & 0xFFFF}, m1=2, writes_f=True)
    for v, l0 in ((0x80, 0xF0), (0x70, 0xF0), (0x01, 0x00)):  # carry with N set, carry with N clear, no carry
        b0, c0 = 0x21, 0x40
        probe("wz ed b3", [0xED, 0xB3], init={"pc": pc, "b": b0, "c": c0, "h": 0x30, "l": l0}, ram={0x3000 | l0: v},
              ports=[[((b0 - 1) << 8) | c0, v, "w"]],
              out={"pc": pc, "b": b0 - 1, "l": l0 + 1, "f": io_block(v, v + l0 + 1, b0 - 1, pc), "wz": pc + 1},
              m1=2, writes_f=True)


# ---------------------------------------------------------------------------------------------------- R rows
def r_rows() -> None:
    # One M1 per opcode byte and per prefix byte, low 7 bits only, bit 7 kept
    for r in (0x7F, 0xFF, 0x00):
        probe("r 00", [0x00], init={"r": r})
    probe("r cb 00", [0xCB, 0x00], init={"r": 0x7F, "b": 0x80, "f": 0x00}, out={"b": 0x01, "f": C}, m1=2, writes_f=True)
    probe("r dd 21", [0xDD, 0x21, 0x34, 0x12], init={"r": 0xFE}, out={"ix": 0x1234}, m1=2)
    probe("r ed 5f", [0xED, 0x5F], init={"r": 0x7E, "iff2": 1, "f": 0x00}, out={"a": 0x00, "f": Z | P}, m1=2, writes_f=True)
    probe("r ed 5f", [0xED, 0x5F], init={"r": 0x80, "iff2": 0, "f": 0x01}, out={"a": 0x82, "f": S | C}, m1=2, writes_f=True)
    # LD R,A: R takes A after the two M1 increments (all 8 bits)
    probe("r ed 4f", [0xED, 0x4F], init={"a": 0x80, "r": 0x05}, out={"r": 0x80}, m1=2)
    # DDCB: two M1 cycles (DD, CB); the displacement and the opcode are not M1
    probe("r dd cb __ 06", [0xDD, 0xCB, 0x01, 0x06], init={"r": 0x7F, "ix": 0x2000, "f": 0x00}, ram={0x2001: 0x81},
          ram_out={0x2001: 0x03}, out={"f": sz53(0x03) | par(0x03) | C, "wz": 0x2001}, m1=2, writes_f=True)
    # HALT: one M1 (the vector convention leaves PC after the opcode)
    probe("r 76", [0x76], init={"r": 0x7F})


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "test/vectors/z80/analytic/probes"
    out.mkdir(parents=True, exist_ok=True)
    for f in (wz_loads, wz_arith, wz_jumps, wz_index, wz_bit_hl, wz_io, wz_block, r_rows):
        f()
    n = 0
    for key, tests in sorted(FILES.items()):
        (out / f"{key}.json").write_text(json.dumps(tests, separators=(",", ":")) + "\n")
        n += len(tests)
    print(f"wrote {len(FILES)} files, {n} tests to {out}")


if __name__ == "__main__":
    main()
