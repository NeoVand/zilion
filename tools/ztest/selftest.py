"""Harness self-tests on the GPU (`python -I tools/zt.py selftest`).

1. host-probe: a 20-line probe core drives every host path (listed / unlisted / final-only reads, writes, stray
   writes, port reads and writes) through synthetic SingleStepTests-format vectors, in both memory models, and the
   ledger must report exactly the planted divergences. This covers io_read/io_write, which the 0.2.0 Z80 never calls.
2. rule-cases: hand-derived IN A,(n) / IN B,(C) / INI / repeating LDIR results on the real core: the case the
   rule is for is explained, the control case (port value 0, or not repeating) matches exactly, and a planted extra
   error stays unexpected. This validates the model-checking predicates independently of SingleStepTests.
3. mutants: single-line mutations of the Z80 core must each produce unexpected divergences in the field they
   break (a harness that cannot fail would report a clean ledger here).
4. memory-model invariance: sparse and full memory give identical ledgers on real vectors.
5. determinism: two sessions give byte-identical ledgers, and repeated dispatches give identical outputs.
Parts 3-5 need a vector directory (--vectors); parts 1-2 do not.
"""

from __future__ import annotations

import gzip
import json
import tempfile
from pathlib import Path

from . import gpu as G
from .artifacts import Artifacts, with_core
from .vectors import session, sst
from .vectors.ledger import Ledger, canonical_json
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
    return ok


# ---------------------------------------------------------------------------------------------- 2. mutants
# (id, exact text in the core, replacement, opcode files to run, field that must show unexpected divergences)
MUTANTS = [
    ("drop-r-inc", "    var op = z80_fetch();\n    r_inc(); // M1: opcode (or prefix) fetch\n",
     "    var op = z80_fetch();\n", ["00", "3c"], "r"),
    ("push-low-byte", "    mem_write(cpu_sp, val & 0xffu);\n}", "    mem_write(cpu_sp, (val + 1u) & 0xffu);\n}",
     ["c5"], "mem"),
    ("inc-half-carry", "select(0u, HF, (r & 0x0fu) == 0u)", "select(0u, HF, (r & 0x0fu) == 1u)", ["3c"], "f"),
    ("inc-overflow-flag", "select(0u, PF, val == 0x7fu)", "select(0u, PF, val == 0x7eu)", ["3c", "04", "0c"], "f"),
    # SCF X/Y wrong in a way that is not the Q effect: the model-checked Q-XY rule must not absorb it.
    ("scf-xy-not-q", "| CF | (cpu_a & (F3 | F5));", "| CF | ((cpu_a ^ 0x08u) & (F3 | F5));", ["37"], "f"),
    # BIT n,(HL) X/Y wrong in a way that is not the WZ effect: the model-checked BIT-HL-XY rule must not absorb it.
    ("bit-hl-xy-not-wz", "                    (val & (F3 | F5));", "                    ((val ^ 0x20u) & (F3 | F5));",
     ["cb 46"], "f"),
    ("djnz-no-branch", "if (cpu_b != 0u) { cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu; }", "", ["10"], "pc"),
    ("halt-not-halting", "                cpu_halted = 1u;\n", "", ["76"], "pc"),
    ("nop-reads", "                case 0u: {} // NOP", "                case 0u: { cpu_a = cpu_a | (mem_read(0x0005u) & 0u); } // NOP",
     ["00"], "mem"),
    ("nop-writes", "                case 0u: {} // NOP", "                case 0u: { mem_write(0x0005u, 0u); } // NOP",
     ["00"], "mem"),
]


def mutants(art: Artifacts, gpu: G.Gpu, vectors: Path, log) -> bool:
    ok = True
    base = art.core("z80")
    for mid, old, new, files, field in MUTANTS:
        if base.count(old) != 1:
            log(f"  FAIL mutant {mid}: anchor occurs {base.count(old)} times in the core")
            ok = False
            continue
        present = session.list_files(session.ADAPTERS["z80"](), [vectors], files)
        if not present:
            log(f"  skip mutant {mid}: vector files {', '.join(files)} absent")
            continue
        fake = with_core(art, "z80", base.replace(old, new), f"mutant {mid}")
        led, _ = session.run(fake, "z80", [vectors], patterns=files, workers=1, progress=None)
        hit = sum(rec["fields"].get(field, {}).get("unexpected", 0) for rec in led.files.values())
        if hit == 0:
            ok = False
        log(f"  {'ok  ' if hit else 'FAIL'} mutant {mid}: {hit} unexpected `{field}` divergences in {', '.join(files)}")
    return ok


# ---------------------------------------------------------------------------------------------- 3 + 4
def _ledger_files(led) -> dict:
    return {k: {kk: vv for kk, vv in rec.items() if kk != "gpu"} for k, rec in led.files.items()}


def invariance_and_determinism(art: Artifacts, vectors: Path, limit: int, log) -> bool:
    ok = True
    kw = dict(limit_per_file=limit, progress=None)
    a, info_a = session.run(art, "z80", [vectors], mode="sparse", repeat=2, **kw)
    b, _ = session.run(art, "z80", [vectors], mode="sparse", **kw)
    c, _ = session.run(art, "z80", [vectors], mode="full", **kw)
    ja = canonical_json(a.to_json(info_a["meta"]))
    jb = canonical_json(b.to_json(info_a["meta"]))
    same = ja == jb
    ok &= same
    n = info_a["meta"]["vectors"]["tests"]
    log(f"  {'ok  ' if same else 'FAIL'} determinism: two sessions and repeated dispatches agree ({n:,} tests)")
    inv = _ledger_files(a) == _ledger_files(c)
    ok &= inv
    log(f"  {'ok  ' if inv else 'FAIL'} memory-model invariance: sparse and full ledgers identical ({n:,} tests)")
    return ok


def run(art: Artifacts, vectors: Path | None, limit: int, log=print) -> int:
    gpu = G.get_gpu()
    log(f"selftest on {gpu.summary()}")
    ok = host_probe(gpu, log)
    ok &= rule_cases(art, log)
    if vectors is None:
        log("  skip mutants, invariance, determinism (no --vectors)")
    else:
        ok &= mutants(art, gpu, vectors, log)
        ok &= invariance_and_determinism(art, vectors, limit, log)
    log("selftest " + ("passed" if ok else "FAILED"))
    return 0 if ok else 1
