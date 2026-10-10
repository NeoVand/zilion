"""Z80 adapter: SingleStepTests/z80 vectors on the Zilion Z80 core.

State record (one u32 per field, vector JSON keys): pc sp a b c d e f h l i r ix iy af_ bc_ de_ hl_ iff1 iff2 im
ei p wz q, plus the host-only `halted`.

Mapping into the core (WGSL `var<private>` names of src/z80-core.wgsl.ts):
  * registers, I, R, IFF1/IFF2 load into and store from the core's variables;
  * af_ bc_ de_ hl_ are split into cpu_a2/cpu_f2 ...;
  * wz, im, q are mapped to cpu_wz, cpu_im, cpu_q when the core declares them; otherwise (0.2.0) they are
    passed through unchanged and reported in their own ledger columns as "not modelled";
  * ei and p (the EI-delay and LD A,I/R latches of interrupt acceptance) are always passed through;
  * per-instruction state (cpu_halted, idx_mode, idx_disp, idx_uses_mem) is cleared before the step.

One test = one call of z80_step(), the core's step: one instruction including its prefixes, one iteration of a
block instruction, or one wasted DD/FD prefix.

Convention mapping (design Appendix B, HALT-PC): Zilion parks PC on the HALT opcode, a Z80 leaves PC after it
(the vectors' convention). When the core reports halted after the step, the adapter reports PC + 1. The ledger
counts every test where this mapping was applied (`mapped.halt_pc`), so a spurious halt cannot hide.
"""

from __future__ import annotations

import re

import numpy as np

from .model import Field, FileBatch, LaneOutputs, natural_key

R8 = ("a", "b", "c", "d", "e", "h", "l")
FIELDS = (
    Field("pc", 16, "regs"),
    Field("sp", 16, "regs"),
    *(Field(n, 8, "regs") for n in R8[:5]),
    Field("f", 8, "f"),
    Field("h", 8, "regs"),
    Field("l", 8, "regs"),
    Field("i", 8, "regs"),
    Field("r", 8, "r"),
    Field("ix", 16, "regs"),
    Field("iy", 16, "regs"),
    Field("af_", 16, "regs"),
    Field("bc_", 16, "regs"),
    Field("de_", 16, "regs"),
    Field("hl_", 16, "regs"),
    Field("iff1", 1, "iff"),
    Field("iff2", 1, "iff"),
    Field("im", 2, "im"),
    Field("ei", 1, "ei/p", architectural=False),
    Field("p", 1, "ei/p", architectural=False),
    Field("wz", 16, "wz", architectural=False),
    Field("q", 8, "q", architectural=False),
    Field("halted", 1, "host", compare=False),
)
IDX = {f.name: i for i, f in enumerate(FIELDS)}

# Fields the core may model under these variable names; passed through when the core does not declare them.
OPTIONAL_VARS = {"wz": "cpu_wz", "im": "cpu_im", "q": "cpu_q"}
ALWAYS_PASSTHROUGH = ("ei", "p")
GROUPS = ("base", "CB", "ED", "DD", "FD", "DDCB", "FDCB", "wasted-prefix")


def code_only(wgsl: str) -> str:
    """WGSL without comments (the core's header documents hooks as `fn ...` in comments)."""
    return re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", wgsl, flags=re.S))


def declares(core: str, var: str) -> bool:
    return re.search(rf"var<private>\s+{re.escape(var)}\s*:", code_only(core)) is not None


def defines_fn(core: str, fn: str) -> bool:
    return re.search(rf"\bfn\s+{re.escape(fn)}\s*\(", code_only(core)) is not None


def calls_fn(core: str, fn: str) -> bool:
    code = code_only(core)
    return re.search(rf"(?<!fn )\b{re.escape(fn)}\s*\(", code) is not None


class Z80Adapter:
    isa = "z80"
    addr_bits = 16
    fields = FIELDS
    step_call = "z80_step();"
    columns = ("regs", "f", "r", "iff", "im", "mem", "ports", "ei/p", "wz", "q")
    group_order = GROUPS
    file_glob = "*.json*"

    def __init__(self) -> None:
        self.passthrough: tuple[str, ...] = ()

    # ---------------------------------------------------------------- files and names
    @staticmethod
    def key_of(path) -> str:
        name = path.name
        for suffix in (".json.gz", ".json"):
            if name.endswith(suffix):
                return name[: -len(suffix)].lower()
        return name.lower()

    @staticmethod
    def group(key: str) -> str:
        t = key.split()
        if len(t) == 2 and t[0] in ("dd", "fd") and t[1] in ("dd", "fd", "ed"):
            return "wasted-prefix"  # analytic vectors (tools/z80-analytic-vectors.py)
        if len(t) >= 2 and t[0] in ("dd", "fd") and t[1] == "cb":
            return t[0].upper() + "CB"
        if len(t) >= 2 and t[0] in ("cb", "ed", "dd", "fd"):
            return t[0].upper()
        return "base"

    @staticmethod
    def reference_keys() -> list[str]:
        """The 1,604 opcode files of SingleStepTests/z80 v1: every opcode except the prefix bytes themselves,
        on the base, CB, DD, FD, DDCB and FDCB pages, and the 80 defined ED opcodes (40-7F and the block group)."""
        hx = [f"{i:02x}" for i in range(256)]
        plain = [h for h in hx if h not in ("cb", "dd", "ed", "fd")]
        ed = [f"{i:02x}" for i in range(0x40, 0x80)] + [f"{b + i:02x}" for b in (0xA0, 0xA8, 0xB0, 0xB8) for i in range(4)]
        keys = plain + [f"cb {h}" for h in hx] + [f"ed {h}" for h in ed]
        for p in ("dd", "fd"):
            keys += [f"{p} {h}" for h in plain] + [f"{p} cb __ {h}" for h in hx]
        return keys

    def sort_key(self, key: str) -> tuple:
        return (GROUPS.index(self.group(key)), natural_key(key))

    # ---------------------------------------------------------------- state record
    def state_values(self, d: dict) -> list:
        """Vector state dict -> state-record row (host-only fields are 0). Raises KeyError on a missing field."""
        return [d[f.json_key] if f.compare else 0 for f in FIELDS]

    @staticmethod
    def compact_state(d: dict) -> dict:
        return {k: d[k] for k in ("pc", "sp", "a", "f", "b", "c", "d", "e", "h", "l", "ix", "iy", "i", "r", "wz",
                                  "q", "iff1", "iff2", "im", "ei", "p", "af_", "bc_", "de_", "hl_") if k in d}

    @staticmethod
    def instruction_bytes(t: dict) -> str:
        ram = {a: v for a, v in t["initial"]["ram"]}
        pc = t["initial"]["pc"]
        out = []
        for k in range(4):
            a = (pc + k) & 0xFFFF
            if a not in ram:
                break
            out.append(f"{ram[a]:02x}")
        return " ".join(out)

    # ---------------------------------------------------------------- WGSL glue
    def glue(self, core: str) -> str:
        self.passthrough = tuple(n for n, v in OPTIONAL_VARS.items() if not declares(core, v)) + ALWAYS_PASSTHROUGH
        L, S = [], []

        def ld(stmt: str) -> None:
            L.append("    " + stmt)

        def st(i: int, expr: str, note: str = "") -> None:
            S.append(f"    zt_state_out[b + {i}u] = {expr};" + (f" // {note}" if note else ""))

        w = lambda name: f"zt_state_in[b + {IDX[name]}u]"  # noqa: E731
        for n in ("pc", "sp", "ix", "iy"):
            ld(f"cpu_{n} = {w(n)} & 0xffffu;")
            st(IDX[n], f"cpu_{n}")
        for n in ("a", "b", "c", "d", "e", "f", "h", "l", "i", "r"):
            ld(f"cpu_{n} = {w(n)} & 0xffu;")
            st(IDX[n], f"cpu_{n}")
        for n in ("af_", "bc_", "de_", "hl_"):
            hi, lo = n[0], n[1]
            ld(f"cpu_{hi}2 = ({w(n)} >> 8u) & 0xffu; cpu_{lo}2 = {w(n)} & 0xffu;")
            st(IDX[n], f"(cpu_{hi}2 << 8u) | cpu_{lo}2")
        for n in ("iff1", "iff2"):
            ld(f"cpu_{n} = {w(n)} & 1u;")
            st(IDX[n], f"cpu_{n}")
        for n, var in OPTIONAL_VARS.items():
            if n in self.passthrough:
                st(IDX[n], w(n), f"{n}: not modelled by this core, passed through")
            else:
                ld(f"{var} = {w(n)};")
                st(IDX[n], var)
        for n in ALWAYS_PASSTHROUGH:
            st(IDX[n], w(n), f"{n}: interrupt-acceptance latch, not modelled, passed through")
        for var in ("cpu_halted", "idx_mode", "idx_disp", "idx_uses_mem"):
            if declares(core, var):
                ld(f"{var} = 0u;")
        st(IDX["halted"], "cpu_halted", "host-only: drives the HALT-PC mapping")
        hooks = []
        if calls_fn(core, "on_fetch_opcode") and not defines_fn(core, "on_fetch_opcode"):
            hooks.append("fn on_fetch_opcode(prefix: u32, op: u32) -> bool { return false; } // no ablation")
        return "\n".join(
            hooks
            + ["fn zt_load_state(b: u32) {", *L, "}", "fn zt_store_state(b: u32) {", *S, "}"]
        )

    # ---------------------------------------------------------------- conventions and predicates
    def postprocess(self, fb: FileBatch, out: LaneOutputs) -> dict:
        halted = out.state[:, IDX["halted"]] != 0
        if halted.any():
            pc = IDX["pc"]
            out.state[:, pc] = np.where(halted, (out.state[:, pc] + 1) & 0xFFFF, out.state[:, pc])
        return {"halt_pc": int(halted.sum())} if halted.any() else {}

    @staticmethod
    def initial_byte(fb: FileBatch, addr: np.ndarray) -> np.ndarray:
        """Per row, the initial RAM byte at `addr` (or -1 when the vector does not list it)."""
        hit = (fb.mem_addr == addr[:, None]) & ((fb.mem_init & 0x100) != 0)
        val = (fb.mem_init & 0xFF).astype(np.int64)
        return np.where(hit.any(1), val[np.arange(fb.n), hit.argmax(1)], -1)

    def _in_model(self, name: str, fb: FileBatch, out: LaneOutputs) -> np.ndarray:
        """IN with a non-zero port value: the vector's result follows the value; Zilion 0.2.0 follows a read of 0
        (its documented behaviour), with its own flag formula; nothing else differs. Tests whose port value is 0
        are excluded: there the core must match the vector exactly."""
        s0, s1, act = fb.state_in, fb.state_exp, out.state
        v = np.where(fb.port_in_n > 0, fb.port_in[:, 0, 1].astype(np.int64), 0)
        cond = v != 0
        regs = ("b", "c", "d", "e", "h", "l", None, "a")
        if name == "in_a_n_model":  # IN A,(n): A <- port; flags unaffected
            return cond & (s1[:, IDX["a"]] == v) & (act[:, IDX["a"]] == 0)
        op = int(fb.key.split()[-1], 16)
        if name == "in_r_c_model":  # IN r,(C): r <- port (IN (C): flags only); F = S Z Y X P from the value, C kept
            target = regs[(op >> 3) & 7]
            f0 = (s0[:, IDX["f"]] & 0x01) | 0x44  # flags of a 0 read: Z and P/V (even parity), H = N = 0
            cond &= act[:, IDX["f"]] == f0
            for r in ("a", "b", "c", "d", "e", "h", "l"):
                if r == target:
                    cond &= (s1[:, IDX[r]] == v) & (act[:, IDX[r]] == 0)
                else:
                    cond &= s1[:, IDX[r]] == act[:, IDX[r]]
            return cond
        # INI/IND/INIR/INDR: (HL) <- port; B - 1; HL +/- 1; flags from the value, B and C +/- 1 (0.2.0 formula)
        dec = (op & 0x08) != 0
        hl = (s0[:, IDX["h"]] << 8) | s0[:, IDX["l"]]
        b1 = (s0[:, IDX["b"]] - 1) & 0xFF
        k = (s0[:, IDX["c"]].astype(np.int64) + (-1 if dec else 1)) & 0xFF  # 0 + (C +/- 1)
        par = np.array([bin(x).count("1") % 2 == 0 for x in range(256)])
        f0 = (b1 & 0xA8) | np.where(b1 == 0, 0x40, 0) | np.where(par[(k & 7) ^ b1], 0x04, 0)
        cond &= act[:, IDX["f"]] == f0
        at = fb.mem_addr == hl[:, None]
        slot = np.arange(fb.mem_addr.shape[1])[None, :] < fb.mem_n[:, None]
        val = (out.mem_word[:, : fb.mem_addr.shape[1]] & 0xFF).astype(np.int64)
        others_ok = ~(slot & ~at & (val != fb.mem_exp)).any(1)
        hl_ok = (at & slot & (val == 0) & (fb.mem_exp == v[:, None])).any(1)
        return cond & others_ok & hl_ok

    def _rep_model(self, name: str, fb: FileBatch, out: LaneOutputs) -> np.ndarray:
        """A repeating block instruction. Vector side: YF = PC.13 and XF = PC.11, PC being the address of the ED byte
        (redcode Z80 Block Flags Test). Core side: Zilion's non-repeating X/Y formula, unchanged by the repeat."""
        s0, s1, act = fb.state_in, fb.state_exp, out.state
        pc = s0[:, IDX["pc"]]
        cond = (s1[:, IDX["pc"]] == pc) & ((s1[:, IDX["f"]] & 0x28) == ((pc >> 8) & 0x28))
        xy = lambda n: (n & 0x08) | ((n & 0x02) << 4)  # noqa: E731  (LDI/CPI: X = bit 3, Y = bit 1 of n)
        op = int(fb.key.split()[-1], 16)
        if name == "rep_io_model":  # INIR/INDR/OTIR/OTDR: Zilion's X/Y come from B after the decrement
            return cond & ((act[:, IDX["f"]] & 0x28) == (((s0[:, IDX["b"]] - 1) & 0xFF) & 0x28))
        a = s0[:, IDX["a"]].astype(np.int64)
        val = self.initial_byte(fb, (s0[:, IDX["h"]] << 8) | s0[:, IDX["l"]])
        if op & 0x01:  # CPIR/CPDR: n = A - (HL) - HF
            r = (a - val) & 0xFF
            n = (r - np.where(((a ^ val ^ r) & 0x10) != 0, 1, 0)) & 0xFF
        else:  # LDIR/LDDR: n = (HL) + A
            n = (val + a) & 0xFF
        return cond & (val >= 0) & ((act[:, IDX["f"]] & 0x28) == xy(n))

    def predicate(self, name: str, fb: FileBatch, out: LaneOutputs) -> np.ndarray:
        """Named conditions for expected rules. The *_model predicates check both sides against the documented
        formulas: the vector must follow the hardware rule and the core its known 0.2.0 rule, so the rule cannot
        absorb an unrelated error in the same bits."""
        pc = IDX["pc"]
        s0, s1, act = fb.state_in, fb.state_exp, out.state
        if name == "q_xy_model":  # SCF/CCF: Zilog NMOS X/Y = ((Q ^ F) | A) & 0x28; Zilion 0.2.0: A & 0x28
            q, f, a = s0[:, IDX["q"]], s0[:, IDX["f"]], s0[:, IDX["a"]]
            return (((s1[:, IDX["f"]] & 0x28) == (((q ^ f) | a) & 0x28))
                    & ((act[:, IDX["f"]] & 0x28) == (a & 0x28)))
        if name == "bit_hl_model":  # BIT n,(HL): Z80 X/Y = WZ bits 13/11; Zilion 0.2.0: operand bits 5/3
            hl = (s0[:, IDX["h"]] << 8) | s0[:, IDX["l"]]
            val = self.initial_byte(fb, hl)
            return ((val >= 0)
                    & ((s1[:, IDX["f"]] & 0x28) == ((s0[:, IDX["wz"]] >> 8) & 0x28))
                    & ((act[:, IDX["f"]] & 0x28) == (val & 0x28)))
        if name == "r_wasted_model":  # a wasted prefix: Z80 R + 1 (7-bit, bit 7 kept); Zilion 0.2.0: R + 2
            r = s0[:, IDX["r"]]
            step = lambda k: (r & 0x80) | ((r + k) & 0x7F)  # noqa: E731
            return (s1[:, IDX["r"]] == step(1)) & (act[:, IDX["r"]] == step(2))
        if name in ("in_a_n_model", "in_r_c_model", "in_block_model"):
            return self._in_model(name, fb, out)
        if name in ("rep_xy_model", "rep_io_model"):
            return self._rep_model(name, fb, out)
        if name == "repeats":  # a block instruction that loops: the reference leaves PC on the instruction
            return fb.state_exp[:, pc] == fb.state_in[:, pc]
        if name == "not_repeats":
            return fb.state_exp[:, pc] != fb.state_in[:, pc]
        if name == "port_read_nonzero":  # some listed port read returns a non-zero value
            slot = np.arange(fb.port_in.shape[1])[None, :] < fb.port_in_n[:, None]
            return (slot & (fb.port_in[:, :, 1] != 0)).any(1)
        if name == "port_read_zero_or_none":
            return ~self.predicate("port_read_nonzero", fb, out)
        raise KeyError(f"unknown predicate {name!r}")
