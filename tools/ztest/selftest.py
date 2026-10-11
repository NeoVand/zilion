"""Harness self-tests on the GPU (`python -I tools/zt.py selftest`).

1. host-probe: a 20-line probe core drives every host path (listed / unlisted / final-only reads, writes, stray
   writes, port reads and writes, the bus-write log) through synthetic SingleStepTests-format vectors, in both memory
   models, and the ledger must report exactly the planted divergences. This covers io_read/io_write, which the 0.2.0
   Z80 never calls, and the bus-write comparison the 6502 adapter uses.
2. rule-cases: hand-derived IN A,(n) / IN B,(C) / INI / repeating LDIR results on the compat '0.2' core (the one
   whose rules have these model-checking predicates): the case the rule is for is explained, the control case (port
   value 0, or not repeating) matches exactly, and a planted extra error stays unexpected. This validates the
   predicates independently of SingleStepTests.
3. mutants: single-line mutations of the Z80 core (the default 0.3 core, and the zilog-nmos variant for the Q latch)
   must each produce unexpected divergences in the field they break (a harness that cannot fail would report a clean
   ledger here). They include the 0.2 behaviour of every 0.3 fix (wasted-prefix R, WZ, BIT n,(HL), IM, block-repeat
   flags, ports), so each fix is shown to be checked by the vectors. The 6502 core gets its own mutants, and the
   whole 6502 set also runs on its hooked core text (neutral hooks).
4. memory-model invariance: sparse and full memory give identical ledgers on real vectors (Z80 and 6502).
5. determinism: two sessions give byte-identical ledgers, and repeated dispatches give identical outputs.
Parts 3-5 need vector directories (--vectors for the Z80, --vectors-6502 for the 6502); parts 1-2 do not.
"""

from __future__ import annotations

import gzip
import json
import tempfile
from pathlib import Path

from . import gpu as G
from .artifacts import REPO, Artifacts, with_core
from .vectors import session, sst
from .vectors.ledger import Ledger, canonical_json
from .vectors.m6502 import M6502Adapter
from .vectors.model import Field, natural_key
from .vectors.runner import Runner

# ---------------------------------------------------------------------------------------------- 1. probe core
PROBE_CORE = """
var<private> pr_op: u32; var<private> pr_a0: u32; var<private> pr_a1: u32; var<private> pr_v: u32;
var<private> pr_r0: u32; var<private> pr_r1: u32;
fn probe_step() {
    if ((pr_op & 1u) != 0u) { pr_r0 = mem_read(pr_a0); }        // read a0
    if ((pr_op & 2u) != 0u) { mem_write(pr_a1, pr_v); }         // write v to a1
    if ((pr_op & 4u) != 0u) { pr_r1 = io_read(pr_a0); }         // in from port a0
    if ((pr_op & 8u) != 0u) { io_write(pr_a1, pr_v); }          // out v to port a1
    if ((pr_op & 16u) != 0u) { pr_r0 = mem_read(pr_a1); }       // read back a1
    if ((pr_op & 32u) != 0u) { mem_write(pr_a1, pr_v); mem_write(pr_a1 + 1u, pr_v); } // two writes
}
"""
PROBE_FIELDS = (Field("op", 8, "regs"), Field("a0", 16, "regs"), Field("a1", 16, "regs"), Field("v", 8, "regs"),
                Field("r0", 8, "regs"), Field("r1", 8, "regs"))


class ProbeAdapter:
    isa = "probe"
    addr_bits = 16
    fields = PROBE_FIELDS
    step_call = "probe_step();"
    columns = ("regs", "mem", "ports")
    group_order = ("base",)
    passthrough = ()

    def glue(self, core: str) -> str:
        names = [f.name for f in PROBE_FIELDS]
        ld = "".join(f"    pr_{n} = zt_state_in[b + {i}u];\n" for i, n in enumerate(names))
        st = "".join(f"    zt_state_out[b + {i}u] = pr_{n};\n" for i, n in enumerate(names))
        return f"fn zt_load_state(b: u32) {{\n{ld}}}\nfn zt_store_state(b: u32) {{\n{st}}}"

    def state_values(self, d):
        return [d[f.name] for f in PROBE_FIELDS]

    group = staticmethod(lambda key: "base")
    sort_key = staticmethod(lambda key: natural_key(key))
    postprocess = staticmethod(lambda fb, out: {})
    instruction_bytes = staticmethod(lambda t: "")
    compact_state = staticmethod(lambda d: {k: v for k, v in d.items() if k != "ram"})

    def predicate(self, name, fb, out):
        raise KeyError(name)


def _st(op=0, a0=0, a1=0, v=0, r0=0, r1=0, ram=()):
    return {"op": op, "a0": a0, "a1": a1, "v": v, "r0": r0, "r1": r1, "ram": [list(x) for x in ram]}


# (name, initial, final, ports, expected divergence {field: bits})
PROBE_CASES = [
    ("read listed", _st(1, 0x1234, ram=[(0x1234, 0x56)]), _st(1, 0x1234, r0=0x56, ram=[(0x1234, 0x56)]), [], {}),
    ("read unlisted", _st(1, 0x1234), _st(1, 0x1234, r0=0x99), [], {"r0": 0x99, "mem": 4}),
    ("write final-only", _st(2, a1=0x2000, v=7), _st(2, a1=0x2000, v=7, ram=[(0x2000, 7)]), [], {}),
    ("reference write missing", _st(0), _st(0, ram=[(0x2000, 0)]), [], {"mem": 1}),
    ("stray write", _st(2, a1=0x3000, v=9), _st(2, a1=0x3000, v=9), [], {"mem": 2}),
    ("wrong value", _st(2, a1=0x2000, v=8, ram=[(0x2000, 1)]), _st(2, a1=0x2000, v=8, ram=[(0x2000, 7)]), [], {"mem": 1}),
    ("read after own write", _st(18, a1=0x4000, v=5), _st(18, a1=0x4000, v=5, r0=5, ram=[(0x4000, 5)]), [], {}),
    ("two stray writes", _st(32, a1=0x5000, v=3), _st(32, a1=0x5000, v=3), [], {"mem": 2}),
    ("wrap at 0xffff", _st(32, a1=0xFFFF, v=3, ram=[(0xFFFF, 0), (0, 0)]),
     _st(32, a1=0xFFFF, v=3, ram=[(0xFFFF, 3), (0, 3)]), [], {}),
    ("port read", _st(4, 0x10FE), _st(4, 0x10FE, r1=0x42), [[0x10FE, 0x42, "r"]], {}),
    ("port read unlisted", _st(4, 0x10FE), _st(4, 0x10FE, r1=0xFF), [], {"ports": 4}),
    ("port read missing", _st(0), _st(0), [[0x10FE, 0x42, "r"]], {"ports": 2}),
    ("port write", _st(8, a1=0xFE, v=0x33), _st(8, a1=0xFE, v=0x33), [[0xFE, 0x33, "w"]], {}),
    ("port write wrong value", _st(8, a1=0xFE, v=0x34), _st(8, a1=0xFE, v=0x34), [[0xFE, 0x33, "w"]], {"ports": 1}),
    ("port write missing", _st(0), _st(0), [[0xFE, 0x33, "w"]], {"ports": 1}),
]


class ProbeBusAdapter(ProbeAdapter):
    """The probe with a bus-write log, compared against the `cycles` entries marked "write" (as for the 6502)."""

    write_cap = 8
    bus_writes = staticmethod(M6502Adapter.bus_writes)


def _w(*writes):
    return [[a, v, "write"] for a, v in writes]


# (name, initial, final, cycles, expected divergence {field: bits}); bus bits: 1 = count, 2 = sequence.
BUS_CASES = [
    ("bus: no writes", _st(1, 0x1234, ram=[(0x1234, 0x56)]), _st(1, 0x1234, r0=0x56, ram=[(0x1234, 0x56)]),
     [[0x1234, 0x56, "read"]], {}),
    ("bus: one write", _st(2, a1=0x2000, v=7), _st(2, a1=0x2000, v=7, ram=[(0x2000, 7)]), _w((0x2000, 7)), {}),
    ("bus: two writes in order", _st(32, a1=0x5000, v=3, ram=[(0x5000, 0), (0x5001, 0)]),
     _st(32, a1=0x5000, v=3, ram=[(0x5000, 3), (0x5001, 3)]), _w((0x5000, 3), (0x5001, 3)), {}),
    # an RMW without its old-value write: one write fewer, and the sequence shifts (old value expected first)
    ("bus: a write the core did not make (an RMW without its old-value write)", _st(2, a1=0x2000, v=7),
     _st(2, a1=0x2000, v=7, ram=[(0x2000, 7)]), _w((0x2000, 1), (0x2000, 7)), {"bus": 3}),
    ("bus: a write missing at the end", _st(2, a1=0x2000, v=7),
     _st(2, a1=0x2000, v=7, ram=[(0x2000, 7)]), _w((0x2000, 7), (0x2000, 7)), {"bus": 1}),
    ("bus: an extra write", _st(32, a1=0x5000, v=3, ram=[(0x5000, 0), (0x5001, 0)]),
     _st(32, a1=0x5000, v=3, ram=[(0x5000, 3), (0x5001, 3)]), _w((0x5000, 3)), {"bus": 1}),
    ("bus: same final memory, other value written", _st(2, a1=0x2000, v=7), _st(2, a1=0x2000, v=7, ram=[(0x2000, 7)]),
     _w((0x2000, 8)), {"bus": 2}),
    ("bus: order swapped", _st(32, a1=0x5000, v=3, ram=[(0x5000, 0), (0x5001, 0)]),
     _st(32, a1=0x5000, v=3, ram=[(0x5000, 3), (0x5001, 3)]), _w((0x5001, 3), (0x5000, 3)), {"bus": 2}),
]


def host_probe(gpu: G.Gpu, log) -> bool:
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "probe.json.gz"
        tests = [{"name": f"probe {k:04x}", "initial": i, "final": f, **({"ports": p} if p else {})}
                 for k, (_, i, f, p, _) in enumerate(PROBE_CASES)]
        path.write_bytes(gzip.compress(json.dumps(tests).encode()))
        ad = ProbeAdapter()
        for mode in ("sparse", "full"):
            fb = sst.parse_file(path, "probe", ad, 32, 8)
            runner = Runner(gpu, ad, PROBE_CORE, mode=mode, mem_cap=32, port_cap=8)
            out = runner.run([fb])[0]
            led = Ledger(ad, [], mem_cap=32, port_cap=8)
            D = led.divergence(fb, out)
            for k, (name, _, _, _, want) in enumerate(PROBE_CASES):
                got = {led.names[j]: int(D[k, j]) for j in range(D.shape[1]) if D[k, j]}
                if got != want:
                    ok = False
                    log(f"  FAIL host-probe [{mode}] {name}: divergence {got}, want {want}")
            # the stray writes are visible in the table, with their values
            k = [c[0] for c in PROBE_CASES].index("two stray writes")
            appended = {(int(out.mem_addr[k, j]), int(out.mem_word[k, j] & 0xFF)) for j in range(int(out.mem_n[k]))}
            if appended != {(0x5000, 3), (0x5001, 3)}:
                ok = False
                log(f"  FAIL host-probe [{mode}] stray-write table {sorted(appended)}")
    log(f"  {'ok  ' if ok else 'FAIL'} host-probe: {len(PROBE_CASES)} planted cases x 2 memory models")
    ok_bus = True
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "bus.json.gz"
        tests = [{"name": f"bus {k:04x}", "initial": i, "final": f, "cycles": c}
                 for k, (_, i, f, c, _) in enumerate(BUS_CASES)]
        path.write_bytes(gzip.compress(json.dumps(tests).encode()))
        ad = ProbeBusAdapter()
        for mode in ("sparse", "full"):
            fb = sst.parse_file(path, "probe", ad, 32, 8)
            out = Runner(gpu, ad, PROBE_CORE, mode=mode, mem_cap=32, port_cap=8).run([fb])[0]
            led = Ledger(ad, [], mem_cap=32, port_cap=8)
            D = led.divergence(fb, out)
            for k, (name, _, _, _, want) in enumerate(BUS_CASES):
                got = {led.names[j]: int(D[k, j]) for j in range(D.shape[1]) if D[k, j]}
                if got != want:
                    ok_bus = False
                    log(f"  FAIL host-probe [{mode}] {name}: divergence {got}, want {want}")
    log(f"  {'ok  ' if ok_bus else 'FAIL'} host-probe bus log: {len(BUS_CASES)} planted cases x 2 memory models")
    return ok and ok_bus


# ---------------------------------------------------------------------------------------------- 2. rule cases
def _z80(pc, **over):
    s = {"pc": pc, "sp": 0x8000, "a": 0, "b": 0, "c": 0, "d": 0, "e": 0, "f": 0, "h": 0, "l": 0, "i": 0, "r": 0,
         "ei": 0, "wz": 0, "ix": 0, "iy": 0, "af_": 0, "bc_": 0, "de_": 0, "hl_": 0, "im": 0, "p": 0, "q": 0,
         "iff1": 0, "iff2": 0}
    s.update(over)
    return s


def _io_case(name, ini, fin, ram0, ram1, ports):
    return {"name": name, "initial": ini | {"ram": ram0}, "final": fin | {"ram": ram1}, "ports": ports}


# Hardware results derived by hand from the Z80 documentation (IN A,(n): A <- port (A<<8|n), flags kept;
# IN r,(C): r <- port BC, S Z Y X P from the value, H = N = 0, C kept; INI: (HL) <- port BC, B - 1, HL + 1,
# N = bit 7 of the value, H = C = (value + ((C + 1) & 255) > 255), P/V = parity(((value + C + 1) & 7) ^ B), S Z Y X
# from B). Each file: [non-zero port value (explained), zero port value (must match), planted error (unexpected)].
IO_FILES = {
    "db": [
        _io_case("db 0000", _z80(0x100, a=0x12, f=0x01), _z80(0x102, a=0x56, f=0x01, r=1, wz=0x1235),
                 [[0x100, 0xDB], [0x101, 0x34]], [[0x100, 0xDB], [0x101, 0x34]], [[0x1234, 0x56, "r"]]),
        _io_case("db 0001", _z80(0x100, a=0x12, f=0x01), _z80(0x102, a=0x00, f=0x01, r=1, wz=0x1235),
                 [[0x100, 0xDB], [0x101, 0x34]], [[0x100, 0xDB], [0x101, 0x34]], [[0x1234, 0x00, "r"]]),
        _io_case("db 0002", _z80(0x100, a=0x12, f=0x01), _z80(0x102, a=0x56, f=0x00, r=1, wz=0x1235),  # F changed
                 [[0x100, 0xDB], [0x101, 0x34]], [[0x100, 0xDB], [0x101, 0x34]], [[0x1234, 0x56, "r"]]),
    ],
    "ed 40": [
        _io_case("ed 40 0000", _z80(0x200, b=0x12, c=0x34, f=0x01), _z80(0x202, b=0x80, c=0x34, f=0x81, r=2, wz=0x1235),
                 [[0x200, 0xED], [0x201, 0x40]], [[0x200, 0xED], [0x201, 0x40]], [[0x1234, 0x80, "r"]]),
        _io_case("ed 40 0001", _z80(0x200, b=0x12, c=0x34, f=0x01), _z80(0x202, b=0x00, c=0x34, f=0x45, r=2, wz=0x1235),
                 [[0x200, 0xED], [0x201, 0x40]], [[0x200, 0xED], [0x201, 0x40]], [[0x1234, 0x00, "r"]]),
        _io_case("ed 40 0002", _z80(0x200, b=0x12, c=0x34, f=0x01),  # D changed as well
                 _z80(0x202, b=0x80, c=0x34, d=0x99, f=0x81, r=2, wz=0x1235),
                 [[0x200, 0xED], [0x201, 0x40]], [[0x200, 0xED], [0x201, 0x40]], [[0x1234, 0x80, "r"]]),
    ],
    "ed a2": [
        _io_case("ed a2 0000", _z80(0x300, b=0x05, c=0x10, h=0x20, l=0x00),
                 _z80(0x302, b=0x04, c=0x10, h=0x20, l=0x01, f=0x06, r=2, wz=0x0511),
                 [[0x300, 0xED], [0x301, 0xA2], [0x2000, 0x77]], [[0x300, 0xED], [0x301, 0xA2], [0x2000, 0x81]],
                 [[0x0510, 0x81, "r"]]),
        _io_case("ed a2 0001", _z80(0x300, b=0x05, c=0x10, h=0x20, l=0x00),
                 _z80(0x302, b=0x04, c=0x10, h=0x20, l=0x01, f=0x04, r=2, wz=0x0511),
                 [[0x300, 0xED], [0x301, 0xA2], [0x2000, 0x77]], [[0x300, 0xED], [0x301, 0xA2], [0x2000, 0x00]],
                 [[0x0510, 0x00, "r"]]),
        _io_case("ed a2 0002", _z80(0x300, b=0x05, c=0x10, h=0x20, l=0x00),  # another address written too
                 _z80(0x302, b=0x04, c=0x10, h=0x20, l=0x01, f=0x06, r=2, wz=0x0511),
                 [[0x300, 0xED], [0x301, 0xA2], [0x2000, 0x77], [0x2001, 0x00]],
                 [[0x300, 0xED], [0x301, 0xA2], [0x2000, 0x81], [0x2001, 0x55]], [[0x0510, 0x81, "r"]]),
    ],
    # LDIR (ED B0) at PC 0x0100 copying 0x0A with A = 0: n = 0x0A, so the data formula gives X|Y = 0x28, while a
    # repeating Z80 takes them from PC: (0x01 & 0x28) = 0. P/V = (BC != 0). Not repeating: data formula on both.
    "ed b0": [
        _io_case("ed b0 0000", _z80(0x100, b=0x00, c=0x02, d=0x20, e=0x00, h=0x10, l=0x00),
                 _z80(0x100, b=0x00, c=0x01, d=0x20, e=0x01, h=0x10, l=0x01, f=0x04, r=2, wz=0x0101),
                 [[0x100, 0xED], [0x101, 0xB0], [0x1000, 0x0A], [0x2000, 0x00]],
                 [[0x100, 0xED], [0x101, 0xB0], [0x1000, 0x0A], [0x2000, 0x0A]], []),
        _io_case("ed b0 0001", _z80(0x100, b=0x00, c=0x01, d=0x20, e=0x00, h=0x10, l=0x00),
                 _z80(0x102, b=0x00, c=0x00, d=0x20, e=0x01, h=0x10, l=0x01, f=0x28, r=2),
                 [[0x100, 0xED], [0x101, 0xB0], [0x1000, 0x0A], [0x2000, 0x00]],
                 [[0x100, 0xED], [0x101, 0xB0], [0x1000, 0x0A], [0x2000, 0x0A]], []),
        _io_case("ed b0 0002", _z80(0x100, b=0x00, c=0x02, d=0x20, e=0x00, h=0x10, l=0x00),  # H set as well
                 _z80(0x100, b=0x00, c=0x01, d=0x20, e=0x01, h=0x10, l=0x01, f=0x14, r=2, wz=0x0101),
                 [[0x100, 0xED], [0x101, 0xB0], [0x1000, 0x0A], [0x2000, 0x00]],
                 [[0x100, 0xED], [0x101, 0xB0], [0x1000, 0x0A], [0x2000, 0x0A]], []),
    ],
}
IO_RULES = {"db": "IO-IN-A", "ed 40": "IO-IN-C", "ed a2": "IO-IN-BLOCK", "ed b0": "REP-XY"}


def rule_cases(art: Artifacts, log) -> bool:
    ok = True
    art = art.select("z80", compat="0.2")  # the rules with these predicates describe the 0.2 core
    with tempfile.TemporaryDirectory() as tmp:
        for key, tests in IO_FILES.items():
            (Path(tmp) / f"{key}.json").write_text(json.dumps(tests))
        led, _ = session.run(art, "z80", [Path(tmp)], workers=1, progress=None)
    for key, rule in IO_RULES.items():
        rec = led.files[key]
        hits = sum(e["rules"].get(rule, 0) for e in rec["fields"].values())
        planted = {ex["name"] for e in rec["fields"].values() for ex in e.get("examples", [])}
        good = rec["explained"] == 2 and rec["unexpected"] == 1 and hits >= 1 and planted == {f"{key} 0002"}
        ok &= good
        log(f"  {'ok  ' if good else 'FAIL'} rule-cases {key}: {rule} explains case 0, case 1 matches, only the planted "
            f"error is unexpected (explained {rec['explained']}/3, unexpected {sorted(planted)})")
    return ok


# ---------------------------------------------------------------------------------------------- 3. mutants
ANALYTIC = REPO / "test" / "vectors" / "z80" / "analytic"  # the wasted-prefix vectors (SingleStepTests has none)

# (id, exact text in the core, replacement, opcode files to run, field that must show unexpected divergences[,
# core selection]). The core is the default configuration (compat 0.3, classic) unless a selection is given.
MUTANTS = [
    ("drop-r-inc", "    var op = z80_fetch();\n    r_inc(); // M1: opcode (or prefix) fetch\n",
     "    var op = z80_fetch();\n", ["00", "3c"], "r"),
    ("push-low-byte", "    mem_write(cpu_sp, val & 0xffu);\n}", "    mem_write(cpu_sp, (val + 1u) & 0xffu);\n}",
     ["c5"], "mem"),
    ("inc-half-carry", "select(0u, HF, (r & 0x0fu) == 0u)", "select(0u, HF, (r & 0x0fu) == 1u)", ["3c"], "f"),
    ("inc-overflow-flag", "select(0u, PF, val == 0x7fu)", "select(0u, PF, val == 0x7eu)", ["3c", "04", "0c"], "f"),
    # SCF X/Y wrong in a way that is not the Q effect: the model-checked Q-XY rule must not absorb it.
    ("scf-xy-not-q", "| CF | (cpu_a & (F3 | F5));", "| CF | ((cpu_a ^ 0x08u) & (F3 | F5));", ["37"], "f"),
    ("djnz-no-branch", "if (cpu_b != 0u) { cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu; cpu_wz = cpu_pc; }", "", ["10"], "pc"),
    ("halt-not-halting", "                cpu_halted = Z80_HALT_INSN;\n", "", ["76"], "pc"),
    ("nop-reads", "                case 0u: {} // NOP", "                case 0u: { cpu_a = cpu_a | (mem_read(0x0005u) & 0u); } // NOP",
     ["00"], "mem"),
    ("nop-writes", "                case 0u: {} // NOP", "                case 0u: { mem_write(0x0005u, 0u); } // NOP",
     ["00"], "mem"),
    # The 0.2 behaviour of each 0.3 fix: no rule may absorb it.
    ("r-wasted-prefix-twice", "            cpu_pc = (cpu_pc - 1u) & 0xffffu;\n            return;\n",
     "            r_inc();\n            cpu_pc = (cpu_pc - 1u) & 0xffffu;\n            return;\n", ["dd fd", "fd ed"], "r"),
    ("bit-hl-xy-from-operand", "let xy = select(val, cpu_wz >> 8u, z == 6u);", "let xy = val;", ["cb 46", "cb 7e"], "f"),
    ("wz-ld-a-nn-off-by-one", "cpu_a = mem_read(nn); cpu_wz = (nn + 1u) & 0xffffu;", "cpu_a = mem_read(nn); cpu_wz = (nn + 2u) & 0xffffu;",
     ["3a"], "wz"),
    ("wz-jp-cc-only-if-taken", "let nn = z80_fetch_word(); cpu_wz = nn; if (check_cc(y)) { cpu_pc = nn; } }",
     "let nn = z80_fetch_word(); if (check_cc(y)) { cpu_pc = nn; cpu_wz = nn; } }", ["c2", "ca"], "wz"),
    ("wz-ix-d-missing", "            cpu_wz = (idx_reg16() + idx_disp) & 0xffffu;", "", ["dd 7e", "fd 34"], "wz"),
    ("im-ignored", "cpu_im = select(0u, m - 1u, m >= 2u);", "", ["ed 56", "ed 5e"], "im"),
    ("rep-xy-from-data", "    cpu_f = (cpu_f & ~(F3 | F5)) | ((cpu_pc >> 8u) & (F3 | F5));\n", "", ["ed b0", "ed b1"], "f"),
    ("rep-io-pv-not-adjusted", "        if (!parity(pb & 7u)) { f = f ^ PF; }\n", "", ["ed b2", "ed b3"], "f"),
    ("in-a-n-port-without-a", "let port = (cpu_a << 8u) | z80_fetch();", "let port = z80_fetch();", ["db"], "ports"),
    ("out-c-r-silent", "            z80_out(get_bc(), v);\n", "", ["ed 79"], "ports"),
    # zilog-nmos: the Q latch
    ("nmos-scf-ignores-q", "| CF | (((z80_qprev ^ cpu_f) | cpu_a) & (F3 | F5));", "| CF | (cpu_a & (F3 | F5));", ["37"], "f",
     {"variant": "zilog-nmos"}),
    ("nmos-q-kept-by-non-writers", "    cpu_q = 0u;        // 0 unless", "    cpu_q = cpu_q;     // 0 unless", ["00", "c5"], "q",
     {"variant": "zilog-nmos"}),
    ("nmos-q-kept-after-prefix",
     "        z80_qprev = 0u; // the prefix was an instruction cycle of its own that left F alone: SCF/CCF see Q = 0\n",
     "", ["dd 37", "fd 3f"], "f", {"variant": "zilog-nmos"}),
    # compat '0.2': errors next to a model-checked rule of the 0.2.0 ledger, which its predicate must not absorb
    ("c02-bit-hl-xy-not-wz", "                    (val & (F3 | F5));", "                    ((val ^ 0x20u) & (F3 | F5));",
     ["cb 46"], "f", {"compat": "0.2"}),
    ("c02-r-wasted-prefix-thrice", "        r_inc(); // M1: opcode after the prefix\n",
     "        r_inc(); // M1: opcode after the prefix\n        if (next == 0xfdu) { r_inc(); }\n", ["dd fd"], "r", {"compat": "0.2"}),
]


def mutants(art: Artifacts, gpu: G.Gpu, vectors: Path, log) -> bool:
    ok = True
    for mid, old, new, files, field, *rest in MUTANTS:
        sel = rest[0] if rest else {}
        base_art = art.select("z80", **sel)
        base = base_art.core("z80")
        if base.count(old) != 1:
            log(f"  FAIL mutant {mid}: anchor occurs {base.count(old)} times in the core")
            ok = False
            continue
        dirs = [vectors, ANALYTIC]
        present = session.list_files(session.ADAPTERS["z80"](), dirs, files)
        if not present:
            log(f"  skip mutant {mid}: vector files {', '.join(files)} absent")
            continue
        fake = with_core(base_art, "z80", base.replace(old, new), f"mutant {mid}")
        led, _ = session.run(fake, "z80", dirs, patterns=files, workers=1, progress=None,
                             rules_path=session.default_rules_path("z80", base_art))  # the base core's rules
        hit = sum(rec["fields"].get(field, {}).get("unexpected", 0) for rec in led.files.values())
        if hit == 0:
            ok = False
        where = f" ({', '.join(f'{k} {v}' for k, v in sel.items())})" if sel else ""
        log(f"  {'ok  ' if hit else 'FAIL'} mutant {mid}{where}: {hit} unexpected `{field}` divergences in {', '.join(files)}")
    return ok


# 6502 mutants: (id, exact text in the core, replacement, opcode files, field that must show unexpected divergences)
MUTANTS_6502 = [
    # NMOS decimal ADC sets Z from the binary sum; a core taking it from the BCD result (the 65C02 rule) is wrong.
    ("decimal-adc-z-from-result", "m6502_p = (m6502_p & 0x3cu) | n | ov | z | select(0u, 1u, t >= 0x100u);",
     "m6502_p = (m6502_p & 0x3cu) | n | ov | select(0u, 0x02u, (t & 0xffu) == 0u) | select(0u, 1u, t >= 0x100u);",
     ["69"], "p"),
    # Decimal ADC's V from the binary sum instead of the half-adjusted one.
    ("decimal-adc-v-binary", "let ov = select(0u, 0x40u, st < -128i || st > 127i);",
     "let ov = (~(a ^ v) & (a ^ sum) & 0x80u) >> 1u;", ["69"], "p"),
    # Decimal SBC without the high-nibble adjustment.
    ("decimal-sbc-no-high-adjust", "if (t < 0i) { t = t - 0x60i; }", "", ["e9"], "a"),
    # ARR in decimal mode without the high-nibble fix-up (and its carry).
    ("decimal-arr-no-high-fixup", "if (hi + (hi & 1u) > 5u) { c = 1u; r = (r + 0x60u) & 0xffu; }", "", ["6b"], "a"),
    # JMP ($xxFF) carrying into the high byte (the 65C02 fix) instead of wrapping within the page.
    ("jmp-indirect-no-page-wrap", "mem_read((base & 0xff00u) | ((base + 1u) & 0xffu))", "mem_read((base + 1u) & 0xffffu)",
     ["6c"], "pc"),
    # zp,X indexing carrying into page 1 instead of wrapping within page 0.
    ("zp-index-no-wrap", "let ea = (base + idx) & select(0xffffu, 0xffu, am >= 2u && am <= 4u);",
     "let ea = (base + idx) & 0xffffu;", ["b5", "95"], "mem"),
    # (zp),Y pointer high byte read from page 1 when the pointer is at $FF.
    ("zp-pointer-no-wrap", "fn m6502_zp16(z: u32) -> u32 { return mem_read(z) | (mem_read((z + 1u) & 0xffu) << 8u); }",
     "fn m6502_zp16(z: u32) -> u32 { return mem_read(z) | (mem_read(z + 1u) << 8u); }", ["b1"], "mem"),
    # A read-modify-write without the old-value write: the final memory is right, only the bus sequence shows it.
    ("rmw-no-dummy-write", "        mem_write(ea, v);\n        v = m6502_shift(sop, v);", "        v = m6502_shift(sop, v);",
     ["0e", "e6", "07"], "bus"),
    # The old-value write with a wrong value.
    ("rmw-dummy-write-new-value", "        mem_write(ea, v);\n        v = m6502_shift(sop, v);",
     "        v = m6502_shift(sop, v);\n        mem_write(ea, v);", ["ee"], "bus"),
    # The unstable constants.
    ("ane-magic-ff", "M6502_ANE_MAGIC: u32 = 0xeeu;", "M6502_ANE_MAGIC: u32 = 0xffu;", ["8b"], "a"),
    ("lxa-magic-00", "M6502_LXA_MAGIC: u32 = 0xeeu;", "M6502_LXA_MAGIC: u32 = 0x00u;", ["ab"], "a"),
    ("sh-without-h-plus-1", "w = r & (((base >> 8u) + 1u) & 0xffu);", "w = r & ((base >> 8u) & 0xffu);",
     ["9f", "9e"], "mem"),
    # The B flag: PHP must push it set; PLP must not load it.
    ("php-b-clear", "m6502_push(select(m6502_a, m6502_p | 0x30u, op == 0x08u));",
     "m6502_push(select(m6502_a, m6502_p | 0x20u, op == 0x08u));", ["08"], "mem"),
    ("plp-loads-b", "if (op == 0x28u) { m6502_p = (v & 0xcfu) | 0x20u; }", "if (op == 0x28u) { m6502_p = v | 0x20u; }",
     ["28"], "p"),
    # BRK through the reset vector instead of 0xFFFE.
    ("brk-wrong-vector", "m6502_pc = mem_read(0xfffeu) | (mem_read(0xffffu) << 8u);",
     "m6502_pc = mem_read(0xfffcu) | (mem_read(0xfffdu) << 8u);", ["00"], "pc"),
    # JAM that does not halt (the JAM-PC mapping must not hide it).
    ("jam-not-halting", "m6502_halted = ZIL_HALT_TRAP; m6502_trap = ZIL_TRAP_ILLEGAL; m6502_pc = pc0;", "", ["02", "f2"], "halted"),
    # An opcode that halts when it should not (NOP sent to the control phase, whose default is JAM).
    ("nop-halts", "    if (cls != 0u) { m6502_control(cls, op, d, base, b1, pc0); }",
     "    if (cls != 0u || op == 0xeau) { m6502_control(cls, op, d, base, b1, pc0); }", ["ea"], "halted"),
    # TXS setting N and Z (only TSX, the other transfer, does).
    ("txs-sets-flags", "if (dst != 3u) { m6502_nz(r); }", "m6502_nz(r);", ["9a"], "p"),
]


# Neutral hooks: the hooked core must then behave exactly as the hooks-off core the baseline tests.
NEUTRAL_HOOKS_6502 = """
fn on_fetch(addr: u32) {}
fn on_instruction_start(pc: u32, unit: u32) -> u32 { return ZIL_CONTINUE; }
fn zil_trap(cause: u32) -> u32 { return ZIL_TRAP_HALT; }
"""


def hooked_6502(art: Artifacts, vectors: Path, log) -> bool:
    """The full 6502 vector set on the core text with every hook on (neutral), against the hooks-off rules."""
    text = art.core("6502-hooks")
    calls = all(f"{h}(" in text for h in ("on_fetch", "on_instruction_start", "zil_trap"))
    fake = with_core(art, "6502", text + NEUTRAL_HOOKS_6502, "hooks on (fetch, instructionStart, trap), neutral")
    led, info = session.run(fake, "6502", [vectors], progress=None, rules_path=session.default_rules_path("6502", art))
    t = led.summary()["totals"]
    ok = calls and t.get("unexpected", 1) == 0 and t["pass_all"] == t["tests"]
    log(f"  {'ok  ' if ok else 'FAIL'} 6502 with every hook on (neutral): {t['tests']:,} tests, "
        f"{t.get('unexpected', 0)} unexpected, {t['tests'] - t['pass_all']} diverging")
    return ok


def decimal_6502(art: Artifacts, vectors: Path, log) -> bool:
    """The gate on decimal mode: Clark's Appendix A against the vectors, then exhaustively against the core; and a
    planted decimal bug (Z from the BCD result) must fail it, so the gate is live."""
    from . import decimal6502

    ok, _ = decimal6502.run(art, vectors, log=log)
    base = art.core("6502")
    old = "m6502_p = (m6502_p & 0x3cu) | n | ov | z | select(0u, 1u, t >= 0x100u);"
    new = "m6502_p = (m6502_p & 0x3cu) | n | ov | select(0u, 0x02u, (t & 0xffu) == 0u) | select(0u, 1u, t >= 0x100u);"
    if base.count(old) != 1:
        log("  FAIL decimal6502 control: the mutant's anchor is not in the core")
        return False
    bad, _ = decimal6502.run(art, vectors, core=base.replace(old, new), log=lambda m: None)
    log(f"  {'ok  ' if not bad else 'FAIL'} decimal6502 control: a core taking decimal ADC's Z from the BCD result fails the gate")
    return ok and not bad


def mutants_6502(art: Artifacts, vectors: Path, log) -> bool:
    ok = True
    base = art.core("6502")
    rules = session.default_rules_path("6502", art)
    for mid, old, new, files, field in MUTANTS_6502:
        if base.count(old) != 1:
            log(f"  FAIL mutant 6502 {mid}: anchor occurs {base.count(old)} times in the core")
            ok = False
            continue
        present = session.list_files(session.ADAPTERS["6502"](), [vectors], files)
        if not present:
            log(f"  skip mutant 6502 {mid}: vector files {', '.join(files)} absent")
            continue
        fake = with_core(art, "6502", base.replace(old, new), f"mutant {mid}")
        led, _ = session.run(fake, "6502", [vectors], patterns=files, workers=1, progress=None, rules_path=rules)
        hit = sum(rec["fields"].get(field, {}).get("unexpected", 0) for rec in led.files.values())
        if hit == 0:
            ok = False
        log(f"  {'ok  ' if hit else 'FAIL'} mutant 6502 {mid}: {hit} unexpected `{field}` divergences in {', '.join(files)}")
    return ok


# ---------------------------------------------------------------------------------------------- 4 + 5
def _ledger_files(led) -> dict:
    return {k: {kk: vv for kk, vv in rec.items() if kk != "gpu"} for k, rec in led.files.items()}


def invariance_and_determinism(art: Artifacts, vectors: Path, limit: int, log, isa: str = "z80") -> bool:
    ok = True
    kw = dict(limit_per_file=limit, progress=None)
    a, info_a = session.run(art, isa, [vectors], mode="sparse", repeat=2, **kw)
    b, _ = session.run(art, isa, [vectors], mode="sparse", **kw)
    c, _ = session.run(art, isa, [vectors], mode="full", **kw)
    ja = canonical_json(a.to_json(info_a["meta"]))
    jb = canonical_json(b.to_json(info_a["meta"]))
    same = ja == jb
    ok &= same
    n = info_a["meta"]["vectors"]["tests"]
    tag = "" if isa == "z80" else f" [{isa}]"
    log(f"  {'ok  ' if same else 'FAIL'} determinism{tag}: two sessions and repeated dispatches agree ({n:,} tests)")
    inv = _ledger_files(a) == _ledger_files(c)
    ok &= inv
    log(f"  {'ok  ' if inv else 'FAIL'} memory-model invariance{tag}: sparse and full ledgers identical ({n:,} tests)")
    return ok


def run(art: Artifacts, vectors: Path | None, limit: int, log=print, vectors_6502: Path | None = None) -> int:
    gpu = G.get_gpu()
    log(f"selftest on {gpu.summary()}")
    ok = host_probe(gpu, log)
    ok &= rule_cases(art, log)
    if vectors is None:
        log("  skip Z80 mutants, invariance, determinism (no --vectors)")
    else:
        ok &= mutants(art, gpu, vectors, log)
        ok &= invariance_and_determinism(art, vectors, limit, log)
    if vectors_6502 is None:
        log("  skip 6502 mutants, invariance, determinism (no --vectors-6502)")
    elif not vectors_6502.is_dir():
        log(f"  FAIL 6502 vector directory {vectors_6502} not found")
        ok = False
    else:
        ok &= hooked_6502(art, vectors_6502, log)
        ok &= decimal_6502(art, vectors_6502, log)
        ok &= mutants_6502(art, vectors_6502, log)
        ok &= invariance_and_determinism(art, vectors_6502, limit, log, isa="6502")
    log("selftest " + ("passed" if ok else "FAILED"))
    return 0 if ok else 1
