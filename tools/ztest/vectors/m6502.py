"""6502 adapter: SingleStepTests/65x02 `6502/v1` vectors on the Zilion 6502 (NMOS) core.

State record (one u32 per field, vector JSON keys): pc s a x y p, plus `halted`. Every field loads into and stores
from the core's `m6502_*` variables; nothing is passed through.

One test = one call of m6502_step(): one instruction.

Comparisons beyond the state and the final RAM (both architectural):
  * `halted`: the vectors have no such field, so its expectation comes from the opcode: 3 (ZIL_HALT_TRAP) for the 12
    NMOS JAM opcodes, whose vectors show the chip locked (the bus parked on 0xFFFF/0xFFFE), and 0 for every other
    opcode. A JAM that does not halt, or any other opcode that halts, is a divergence;
  * `bus`: the reference's memory writes, in order (the `cycles` entries marked "write"), against every mem_write
    call the core makes. This is how the old-value write of a read-modify-write instruction is checked. The
    reference's dummy *reads* are not compared: a read has no effect in a Zilion world (only instruction-stream
    fetches are hooked), and the core does not make them. A read of an address the vector does not list is still
    caught (`mem` unlisted-read), because the vectors list every address the reference touched.

Convention mapping (JAM-PC): the core parks PC on a JAM opcode, as Zilion parks every halting instruction (the Z80's
HALT, a host halt); the vectors leave PC one past it. When the core reports the trap halt, the adapter reports
PC + 1. The ledger counts every test where it did (`mapped.jam_pc`), and the compared `halted` field keeps a
spurious halt or a missing one visible.
"""

from __future__ import annotations

import re

import numpy as np

from .model import Field, FileBatch, LaneOutputs, natural_key

FIELDS = (
    Field("pc", 16, "regs"),
    Field("s", 8, "regs"),
    Field("a", 8, "regs"),
    Field("x", 8, "regs"),
    Field("y", 8, "regs"),
    Field("p", 8, "p"),
    Field("halted", 8, "halt"),  # compared; its expectation is set per opcode in postprocess (see the docstring)
)
IDX = {f.name: i for i, f in enumerate(FIELDS)}
VARS = {"pc": "m6502_pc", "s": "m6502_s", "a": "m6502_a", "x": "m6502_x", "y": "m6502_y", "p": "m6502_p"}

JAM = frozenset(f"{op:02x}" for op in (0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xB2, 0xD2, 0xF2))
UNSTABLE = frozenset(("8b", "ab", "93", "9f", "9b", "9c", "9e", "bb"))  # ANE LXA SHA SHA TAS SHY SHX LAS
DOCUMENTED = frozenset(f"{op:02x}" for op in (
    0x00, 0x01, 0x05, 0x06, 0x08, 0x09, 0x0A, 0x0D, 0x0E, 0x10, 0x11, 0x15, 0x16, 0x18, 0x19, 0x1D, 0x1E,
    0x20, 0x21, 0x24, 0x25, 0x26, 0x28, 0x29, 0x2A, 0x2C, 0x2D, 0x2E, 0x30, 0x31, 0x35, 0x36, 0x38, 0x39, 0x3D, 0x3E,
    0x40, 0x41, 0x45, 0x46, 0x48, 0x49, 0x4A, 0x4C, 0x4D, 0x4E, 0x50, 0x51, 0x55, 0x56, 0x58, 0x59, 0x5D, 0x5E,
    0x60, 0x61, 0x65, 0x66, 0x68, 0x69, 0x6A, 0x6C, 0x6D, 0x6E, 0x70, 0x71, 0x75, 0x76, 0x78, 0x79, 0x7D, 0x7E,
    0x81, 0x84, 0x85, 0x86, 0x88, 0x8A, 0x8C, 0x8D, 0x8E, 0x90, 0x91, 0x94, 0x95, 0x96, 0x98, 0x99, 0x9A, 0x9D,
    0xA0, 0xA1, 0xA2, 0xA4, 0xA5, 0xA6, 0xA8, 0xA9, 0xAA, 0xAC, 0xAD, 0xAE,
    0xB0, 0xB1, 0xB4, 0xB5, 0xB6, 0xB8, 0xB9, 0xBA, 0xBC, 0xBD, 0xBE,
    0xC0, 0xC1, 0xC4, 0xC5, 0xC6, 0xC8, 0xC9, 0xCA, 0xCC, 0xCD, 0xCE, 0xD0, 0xD1, 0xD5, 0xD6, 0xD8, 0xD9, 0xDD, 0xDE,
    0xE0, 0xE1, 0xE4, 0xE5, 0xE6, 0xE8, 0xE9, 0xEA, 0xEC, 0xED, 0xEE, 0xF0, 0xF1, 0xF5, 0xF6, 0xF8, 0xF9, 0xFD, 0xFE,
))
GROUPS = ("documented", "undocumented", "unstable", "jam")


def code_only(wgsl: str) -> str:
    """WGSL without comments."""
    return re.sub(r"//[^\n]*", "", re.sub(r"/\*.*?\*/", "", wgsl, flags=re.S))


class M6502Adapter:
    isa = "6502"
    addr_bits = 16
    fields = FIELDS
    step_call = "m6502_step();"
    columns = ("regs", "p", "halt", "mem", "ports", "bus")
    group_order = GROUPS
    file_glob = "*.json*"
    write_cap = 8  # bus-write log slots per lane (the reference writes at most 3 bytes: BRK)

    def __init__(self) -> None:
        self.passthrough: tuple[str, ...] = ()
        self.halt_trap: int | None = None

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
        if key in JAM:
            return "jam"
        if key in UNSTABLE:
            return "unstable"
        return "documented" if key in DOCUMENTED else "undocumented"

    @staticmethod
    def reference_keys() -> list[str]:
        """The 256 opcode files of SingleStepTests/65x02 6502/v1: one per opcode, 00 to ff."""
        return [f"{i:02x}" for i in range(256)]

    @staticmethod
    def sort_key(key: str) -> tuple:
        return natural_key(key)

    # ---------------------------------------------------------------- state record
    def state_values(self, d: dict) -> list:
        """Vector state dict -> state-record row. `halted` is not in the vectors: 0 here, set per opcode later."""
        return [0 if f.name == "halted" else d[f.json_key] for f in FIELDS]

    @staticmethod
    def bus_writes(t: dict) -> list[tuple]:
        """The reference's memory writes, in order: the `cycles` entries [address, value, "write"]."""
        out = []
        cycles = t["cycles"]
        if not isinstance(cycles, list):
            raise TypeError("cycles is not a list")
        for e in cycles:
            if not isinstance(e, list) or len(e) != 3 or e[2] not in ("read", "write"):
                raise ValueError(f"bad cycle entry {e!r}")
            if e[2] == "write":
                out.append((e[0], e[1]))
        return out

    @staticmethod
    def compact_state(d: dict) -> dict:
        return {k: d[k] for k in ("pc", "s", "a", "x", "y", "p") if k in d}

    @staticmethod
    def instruction_bytes(t: dict) -> str:
        ram = {a: v for a, v in t["initial"]["ram"]}
        pc = t["initial"]["pc"]
        out = []
        for k in range(3):
            a = (pc + k) & 0xFFFF
            if a not in ram:
                break
            out.append(f"{ram[a]:02x}")
        return " ".join(out)

    # ---------------------------------------------------------------- WGSL glue
    def glue(self, core: str) -> str:
        code = code_only(core)
        m = re.search(r"const\s+ZIL_HALT_TRAP\s*:\s*u32\s*=\s*(\d+)u\s*;", code)
        if m is None:
            raise ValueError("the 6502 core text does not declare ZIL_HALT_TRAP (emit it with the host-contract prelude)")
        self.halt_trap = int(m.group(1))
        self.passthrough = ()
        L, S = [], []
        for name, var in VARS.items():
            i = IDX[name]
            mask = "0xffffu" if name == "pc" else "0xffu"
            L.append(f"    {var} = zt_state_in[b + {i}u] & {mask};")
            S.append(f"    zt_state_out[b + {i}u] = {var};")
        L.append("    m6502_halted = 0u;")
        S.append(f"    zt_state_out[b + {IDX['halted']}u] = m6502_halted; // compared with the per-opcode expectation")
        hooks = []
        calls = re.search(r"(?<!fn )\bon_decode\s*\(", code) is not None
        defines = re.search(r"\bfn\s+on_decode\s*\(", code) is not None
        if calls and not defines:
            hooks.append("fn on_decode(page: u32, key: u32) -> bool { return false; } // no ablation")
        return "\n".join(hooks + ["fn zt_load_state(b: u32) {", *L, "}", "fn zt_store_state(b: u32) {", *S, "}"])

    # ---------------------------------------------------------------- conventions and predicates
    def postprocess(self, fb: FileBatch, out: LaneOutputs) -> dict:
        """Set the `halted` expectation for this opcode, then map PC on halted lanes (JAM-PC)."""
        h, pc = IDX["halted"], IDX["pc"]
        fb.state_exp[:, h] = self.halt_trap if fb.key in JAM else 0
        halted = out.state[:, h] == self.halt_trap
        if halted.any():
            out.state[:, pc] = np.where(halted, (out.state[:, pc] + 1) & 0xFFFF, out.state[:, pc])
        return {"jam_pc": int(halted.sum())} if halted.any() else {}

    def predicate(self, name: str, fb: FileBatch, out: LaneOutputs) -> np.ndarray:
        raise KeyError(f"unknown predicate {name!r} (the 6502 rules use none)")
