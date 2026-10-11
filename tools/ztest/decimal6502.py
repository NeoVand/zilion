"""The 6502's decimal mode against Bruce Clark's published NMOS algorithm, exhaustively (`zt.py decimal6502`).

Reference: Bruce Clark, "Decimal Mode", 6502.org Tutorials (http://www.6502.org/tutorials/decimal_mode.html),
Appendix A, "What about invalid BCD values and invalid flags?". It is a human-written specification, verified on
hardware by its author, of ADC and SBC in decimal mode for every input, valid BCD or not. For the 6502 (NMOS) its
tables say:

    ADC B: A = A+B+C     accumulator: Seq. 1   C: Seq. 1   N: Seq. 2   V: Seq. 2   Z: bin
    SBC B: A = A-B+C-1   accumulator: Seq. 3   C: bin      N: bin      V: bin      Z: bin

"bin" means "the same as in binary mode". The appendix's notes: all calculations use unlimited precision, all
arithmetic is binary and unsigned unless noted, `&` is bitwise AND. The functions below transcribe the sequences
step by step; each line carries the step's label.

Two points the appendix leaves open, and how they are read here (both readings are then checked against every
decimal-mode test of SingleStepTests 6502/v1, step 1 below, before anything is compared with the core):
  * Step 2c says "using signed (twos complement) arithmetic" without a width. A and B are bytes, so A & $F0 and
    B & $F0 are read as 8-bit two's-complement values (bit 7 the sign); AL (0 to $1F after step 2b) is
    non-negative under any reading. Step 2f (V = 1 if A < -128 or A > 127) is vacuous unless the operands are
    signed, which supports this reading, and so do the vectors: with this reading the transcription agrees with all
    154,975 decimal-mode tests of step 1; with the operands read unsigned it agrees with only 107,375.
  * Step 3b applies `& $0F` to AL - 6, which is negative there. With unlimited precision, `&` on a negative number
    is read as on its infinite two's-complement representation (Python's `&`). This point is not really open:
    `x & $0F` is x mod 16 under any two's-complement reading, whatever the width.
  (Step 2d does not exist in the document; the numbering goes from 2c to 2e.)

"bin" flags are the binary-mode results: ADC computes A + B + C, SBC computes A - B + C - 1; C is the carry out
(SBC: 1 when there is no borrow), Z is 1 when the 8-bit result is 0, N is its bit 7, V is 1 when the result as a
signed number is outside -128..127 (A and B read as signed bytes).

The check has two steps; both must pass:
  1. the transcription agrees with every test of SingleStepTests 6502/v1 for ADC, SBC (E9 and the undocumented EB),
     RRA and ISC, in every addressing mode and in both modes (D = 1 is the point; D = 0 checks the "bin" flags);
     the operand and carry-in are taken from the test's bus cycles (the last read; for RRA and ISC the new value
     written, and for RRA the carry out of ROR);
  2. the core, on the GPU through the vector host, agrees with the transcription on all 131,072 inputs
     (A, operand, carry) for ADC #, SBC # (E9, EB), RRA zp and ISC zp (RRA's ADC sees every input as M runs
     over 0..255 and C over 0, 1; ISC's SBC likewise), with D = 1 and with D = 0, and with the other flags of P
     varied, so the flags each instruction must leave alone are checked too.
ARR's decimal mode is not covered: it is undocumented and the appendix does not describe it (the vectors check it).
"""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path

import numpy as np

from . import gpu as G
from .vectors.ledger import Ledger
from .vectors.m6502 import FIELDS, M6502Adapter
from .vectors.model import READABLE, FileBatch
from .vectors.runner import Runner

SOURCE = 'Bruce Clark, "Decimal Mode", 6502.org Tutorials, Appendix A (http://www.6502.org/tutorials/decimal_mode.html)'


def signed8(x: int) -> int:
    """A byte as a two's-complement number (bit 7 the sign)."""
    return x - 0x100 if x & 0x80 else x


# ------------------------------------------------------------------------------------------- the transcription
def adc_seq1(a: int, b: int, c: int) -> tuple[int, int]:
    """ADC, Seq. 1 (the 6502's accumulator and C). Returns (accumulator, carry)."""
    al = (a & 0x0F) + (b & 0x0F) + c  # 1a
    if al >= 0x0A:  # 1b
        al = ((al + 0x06) & 0x0F) + 0x10
    a = (a & 0xF0) + (b & 0xF0) + al  # 1c (1d: A can be >= $100 here)
    if a >= 0xA0:  # 1e
        a = a + 0x60
    return a & 0xFF, 1 if a >= 0x100 else 0  # 1f, 1g


def adc_seq2(a: int, b: int, c: int) -> tuple[int, int]:
    """ADC, Seq. 2 (the 6502's N and V). Returns (n, v)."""
    al = (a & 0x0F) + (b & 0x0F) + c  # 2a
    if al >= 0x0A:  # 2b
        al = ((al + 0x06) & 0x0F) + 0x10
    a = signed8(a & 0xF0) + signed8(b & 0xF0) + al  # 2c, signed (the operands read as signed bytes; see above)
    n = 1 if a & 0x80 else 0  # 2e: bit 7 of A
    v = 1 if a < -128 or a > 127 else 0  # 2f
    return n, v


def sbc_seq3(a: int, b: int, c: int) -> int:
    """SBC, Seq. 3 (the 6502's accumulator). Returns the accumulator."""
    al = (a & 0x0F) - (b & 0x0F) + c - 1  # 3a
    if al < 0:  # 3b (& on a negative number: unlimited-precision two's complement; see above)
        al = ((al - 0x06) & 0x0F) - 0x10
    a = (a & 0xF0) - (b & 0xF0) + al  # 3c
    if a < 0:  # 3d
        a = a - 0x60
    return a & 0xFF  # 3e


def adc_bin(a: int, b: int, c: int) -> tuple[int, int, int, int, int]:
    """Binary-mode ADC: (result, n, v, z, c)."""
    s = a + b + c
    r = s & 0xFF
    sv = signed8(a) + signed8(b) + c
    return r, r >> 7, 1 if sv < -128 or sv > 127 else 0, 1 if r == 0 else 0, 1 if s >= 0x100 else 0


def sbc_bin(a: int, b: int, c: int) -> tuple[int, int, int, int, int]:
    """Binary-mode SBC: (result, n, v, z, c); C = 1 when there is no borrow."""
    d = a - b + c - 1
    r = d & 0xFF
    sv = signed8(a) - signed8(b) + c - 1
    return r, r >> 7, 1 if sv < -128 or sv > 127 else 0, 1 if r == 0 else 0, 1 if d >= 0 else 0


def adc(a: int, b: int, c: int, decimal: bool) -> tuple[int, int, int, int, int]:
    """The 6502's ADC per the appendix's table: (accumulator, n, v, z, c)."""
    r, n, v, z, cy = adc_bin(a, b, c)
    if not decimal:
        return r, n, v, z, cy
    acc, cy = adc_seq1(a, b, c)  # A: Seq. 1; C: Seq. 1
    n, v = adc_seq2(a, b, c)  # N: Seq. 2; V: Seq. 2
    return acc, n, v, z, cy  # Z: bin


def sbc(a: int, b: int, c: int, decimal: bool) -> tuple[int, int, int, int, int]:
    """The 6502's SBC per the appendix's table: (accumulator, n, v, z, c)."""
    r, n, v, z, cy = sbc_bin(a, b, c)  # C, N, V, Z: bin
    return (sbc_seq3(a, b, c) if decimal else r), n, v, z, cy  # A: Seq. 3


def flags(p_in: int, n: int, v: int, z: int, c: int) -> int:
    """P after the instruction: N V Z C replaced, every other bit kept."""
    return (p_in & 0x3C) | (n << 7) | (v << 6) | (z << 1) | c


# ------------------------------------------------------------------------------------- 1. against the vectors
ADC_FILES = ("61", "65", "69", "6d", "71", "75", "79", "7d")
SBC_FILES = ("e1", "e5", "e9", "ed", "f1", "f5", "f9", "fd", "eb")
RRA_FILES = ("63", "67", "6f", "73", "77", "7b", "7f")
ISC_FILES = ("e3", "e7", "ef", "f3", "f7", "fb", "ff")


def _operand(op: str, t: dict) -> tuple[int, int, int] | None:
    """(operation, operand, carry-in) of the ADC or SBC inside the test, from its bus cycles: 0 = ADC, 1 = SBC."""
    i = t["initial"]
    reads = [(a, v) for a, v, k in t["cycles"] if k == "read"]
    writes = [(a, v) for a, v, k in t["cycles"] if k == "write"]
    c = i["p"] & 1
    if op in ADC_FILES:
        return 0, reads[-1][1], c
    if op in SBC_FILES:
        return 1, reads[-1][1], c
    m = reads[-1][1]
    b = writes[-1][1]
    if op in RRA_FILES:  # ROR, then ADC with the carry ROR shifted out
        if b != ((m >> 1) | (c << 7)):
            return None
        return 0, b, m & 1
    if b != ((m + 1) & 0xFF):  # ISC: INC, then SBC with the carry as it was
        return None
    return 1, b, c


def check_vectors(vec_dir: Path) -> dict:
    """Step 1: the transcription against every ADC/SBC/RRA/ISC test of the vectors."""
    out = {}
    for op in ADC_FILES + SBC_FILES + RRA_FILES + ISC_FILES:
        path = vec_dir / f"{op}.json.gz"
        if not path.is_file():
            path = vec_dir / f"{op}.json"
        if not path.is_file():
            raise G.HarnessError(f"decimal6502: vector file {op} not found in {vec_dir}")
        raw = path.read_bytes()
        tests = json.loads(gzip.decompress(raw) if path.name.endswith(".gz") else raw)
        rec = {"sha256": hashlib.sha256(raw).hexdigest(), "tests": 0, "decimal": 0, "agree": 0, "agree_decimal": 0,
               "inputs_decimal": 0, "disagree": []}
        seen = set()
        for t in tests:
            i, f = t["initial"], t["final"]
            got = _operand(op, t)
            rec["tests"] += 1
            dec = bool(i["p"] & 0x08)
            rec["decimal"] += dec
            if got is None:
                rec["disagree"].append({"name": t["name"], "why": "the bus cycles are not the expected RMW"})
                continue
            kind, b, c = got
            acc, n, v, z, cy = (adc if kind == 0 else sbc)(i["a"], b, c, dec)
            if acc == f["a"] and flags(i["p"], n, v, z, cy) == f["p"]:
                rec["agree"] += 1
                rec["agree_decimal"] += dec
            elif len(rec["disagree"]) < 5:
                rec["disagree"].append({"name": t["name"], "a": i["a"], "operand": b, "c": c, "decimal": dec,
                                        "expected": [f["a"], f["p"]], "clark": [acc, flags(i["p"], n, v, z, cy)]})
            if dec:
                seen.add((kind, i["a"], b, c))
        rec["inputs_decimal"] = len(seen)
        out[op] = rec
    return out


# ------------------------------------------------------------------------------- 2. exhaustive, on the core
# (opcode, kind, rmw): ADC #, SBC # (E9 and the undocumented EB), RRA zp, ISC zp.
SWEEP = (("69", 0x69, "adc", False), ("e9", 0xE9, "sbc", False), ("eb", 0xEB, "sbc", False),
         ("67", 0x67, "adc", True), ("e7", 0xE7, "sbc", True))
PC, ZP, S = 0x0200, 0x0080, 0xFD
IDX = {f.name: k for k, f in enumerate(FIELDS)}


def _batch(key: str, opcode: int, kind: str, rmw: bool, decimal: bool, mem_cap: int, write_cap: int) -> tuple[FileBatch, list]:
    """All 131,072 inputs of one opcode in one mode as a packed batch, with the transcription's expectations."""
    n = 256 * 256 * 2
    k = np.arange(n, dtype=np.int64)
    a, x, c = k >> 9, (k >> 1) & 0xFF, k & 1  # x: the immediate operand, or the memory byte M of RRA/ISC
    other = ((k * 0x9E3779B1) >> 7) & 0xD6  # N V B I Z varied (bits 7 6 4 2 1), deterministic
    p_in = 0x20 | (0x08 if decimal else 0) | other | c
    if rmw:  # the operand the ADC/SBC sees, and its carry-in
        b = ((x >> 1) | (c << 7)) if kind == "adc" else ((x + 1) & 0xFF)
        cin = (x & 1) if kind == "adc" else c
    else:
        b, cin = x, c
    fn = adc if kind == "adc" else sbc
    exp_a = np.empty(n, dtype=np.int64)
    exp_p = np.empty(n, dtype=np.int64)
    for i in range(n):  # the transcription itself, one input at a time (no vectorised rewrite of it)
        acc, fn_n, fn_v, fn_z, fn_c = fn(int(a[i]), int(b[i]), int(cin[i]), decimal)
        exp_a[i] = acc
        exp_p[i] = flags(int(p_in[i]), fn_n, fn_v, fn_z, fn_c)
    F = len(FIELDS)
    state_in = np.zeros((n, F), dtype=np.uint32)
    state_in[:, IDX["pc"]] = PC
    state_in[:, IDX["s"]] = S
    state_in[:, IDX["a"]] = a
    state_in[:, IDX["p"]] = p_in
    state_exp = state_in.copy()
    state_exp[:, IDX["pc"]] = PC + 2
    state_exp[:, IDX["a"]] = exp_a
    state_exp[:, IDX["p"]] = exp_p
    # memory table (sorted addresses): zero page byte (RMW only), opcode, operand
    addrs = ([ZP] if rmw else []) + [PC, PC + 1]
    init = ([x] if rmw else []) + [np.full(n, opcode), (np.full(n, ZP) if rmw else x)]
    final = ([b] if rmw else []) + [np.full(n, opcode), (np.full(n, ZP) if rmw else x)]
    E = len(addrs)
    mem_n = np.full(n, E, dtype=np.uint32)
    mem_addr = np.zeros((n, mem_cap), dtype=np.uint32)
    mem_init = np.zeros((n, mem_cap), dtype=np.uint32)
    mem_exp = np.zeros((n, mem_cap), dtype=np.uint32)
    for j in range(E):
        mem_addr[:, j] = addrs[j]
        mem_init[:, j] = np.asarray(init[j], dtype=np.uint32) | READABLE
        mem_exp[:, j] = final[j]
    bus_n = np.full(n, 2 if rmw else 0, dtype=np.uint32)
    bus = np.zeros((n, write_cap, 2), dtype=np.uint32)
    if rmw:  # the read-modify-write's two writes: old value, then new
        bus[:, 0, 0] = ZP
        bus[:, 0, 1] = x
        bus[:, 1, 0] = ZP
        bus[:, 1, 1] = b
    mode = "dec" if decimal else "bin"
    names = [f"{key} {mode} a={int(a[i]):02x} m={int(x[i]):02x} c={int(c[i])}" for i in range(n)]
    digest = hashlib.sha256(state_exp.tobytes() + mem_exp.tobytes() + bus.tobytes()).hexdigest()
    z = lambda *s: np.zeros(s, dtype=np.uint32)  # noqa: E731
    fb = FileBatch(key=f"{key} {mode}", path=Path(f"<clark {key} {mode}>"), sha256=digest, names=names,
                   state_in=state_in, state_exp=state_exp, mem_n=mem_n, mem_addr=mem_addr, mem_init=mem_init,
                   mem_exp=mem_exp, mem_final_only=np.zeros((n, mem_cap), dtype=bool), port_in_n=z(n),
                   port_in=z(n, 8, 2), port_out_n=z(n), port_out=z(n, 8, 2), orig=np.arange(n), bus_n=bus_n, bus=bus)

    def tests() -> list:  # the JSON form of each test, built only when the ledger needs an example
        out = []
        for i in range(n):
            st = lambda arr, ram: {f.name: int(arr[i, IDX[f.name]]) for f in FIELDS if f.name not in ("halted", "trap")} | {"ram": ram}  # noqa: E731
            out.append({"name": names[i], "initial": st(state_in, [[addrs[j], int(np.asarray(init[j])[i] if np.ndim(init[j]) else init[j])] for j in range(E)]),
                        "final": st(state_exp, [[addrs[j], int(np.asarray(final[j])[i] if np.ndim(final[j]) else final[j])] for j in range(E)])})
        return out

    fb.tests_loader = tests
    return fb, names


def exhaustive(core: str, mem_cap: int = 16) -> dict:
    """Step 2: the core against the transcription on every input. Returns per-batch results and the ledger summary."""
    adapter = M6502Adapter()
    gpu = G.get_gpu()
    runner = Runner(gpu, adapter, core, mode="sparse", mem_cap=mem_cap, port_cap=8)
    ledger = Ledger(adapter, [], mem_cap=mem_cap, port_cap=8)
    results = {}
    for key, opcode, kind, rmw in SWEEP:
        for decimal in (True, False):
            fb, _ = _batch(key, opcode, kind, rmw, decimal, mem_cap, adapter.write_cap)
            out = runner.run([fb])[0]
            ledger.add(fb, out)
            rec = ledger.files[fb.key]
            results[fb.key] = {"tests": rec["tests"], "pass_all": rec["pass_all"], "unexpected": rec["unexpected"],
                               "fields": {f: e["diverging"] for f, e in rec["fields"].items()},
                               "examples": [ex for e in rec["fields"].values() for ex in e.get("examples", [])][:3],
                               "expectations_sha256": fb.sha256}
    return {"results": results, "host_wgsl_sha256": runner.wgsl_sha256}


# ------------------------------------------------------------------------------------------------- the check
def run(art, vec_dir: Path, *, core: str | None = None, log=print) -> tuple[bool, dict]:
    """Both steps. `core` overrides the emitted 6502 core text (mutants). Returns (passed, document)."""
    step1 = check_vectors(vec_dir)
    v_tests = sum(r["tests"] for r in step1.values())
    v_agree = sum(r["agree"] for r in step1.values())
    v_dec = sum(r["decimal"] for r in step1.values())
    v_agree_dec = sum(r["agree_decimal"] for r in step1.values())
    ok1 = v_agree == v_tests
    text = core if core is not None else art.core("6502")
    step2 = exhaustive(text)
    e_tests = sum(r["tests"] for r in step2["results"].values())
    e_bad = sum(r["tests"] - r["pass_all"] for r in step2["results"].values())
    ok2 = e_bad == 0
    doc = {
        "source": SOURCE,
        "core_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "vectors": {"tests": v_tests, "agree": v_agree, "decimal": v_dec, "agree_decimal": v_agree_dec, "files": step1},
        "exhaustive": {"tests": e_tests, "diverging": e_bad, **step2},
        "passed": ok1 and ok2,
    }
    log(f"  {'ok  ' if ok1 else 'FAIL'} decimal6502 step 1: Clark's Appendix A agrees with {v_agree:,} of {v_tests:,} "
        f"ADC/SBC/RRA/ISC vector tests ({v_agree_dec:,} of {v_dec:,} in decimal mode)")
    log(f"  {'ok  ' if ok2 else 'FAIL'} decimal6502 step 2: the core agrees with it on {e_tests - e_bad:,} of {e_tests:,} "
        f"exhaustive inputs (ADC #, SBC # E9/EB, RRA zp, ISC zp; D = 1 and 0)")
    return ok1 and ok2, doc


def markdown(doc: dict) -> str:
    """The generated report (test/baselines/6502-decimal-clark.md)."""
    L = []
    w = L.append
    v, e = doc["vectors"], doc["exhaustive"]
    w("# 6502 decimal mode against Clark's NMOS algorithm")
    w("")
    w("Generated by `python -I tools/zt.py decimal6502 <6502 vectors>` (module `tools/ztest/decimal6502.py`, whose "
      "docstring has the transcription and how two open points of the document are read). A gate of "
      "`npm run test:harness`.")
    w("")
    w(f"Reference: {doc['source']}. 6502 (NMOS) table: ADC accumulator and C from Seq. 1, N and V from Seq. 2, Z "
      "binary; SBC accumulator from Seq. 3, C, N, V and Z binary.")
    w("")
    w("Open points of the document and their readings: step 2c (\"signed (twos complement) arithmetic\") does not "
      "say the width; A & $F0 and B & $F0 are read as signed bytes. With that reading step 1 agrees with every "
      "decimal-mode test; read unsigned it would agree with 107,375 of 154,975. Step 3b's `& $0F` of a negative "
      "number is the value mod 16 under any reading. ARR's decimal mode (undocumented) is not in the document and "
      "is checked by the vectors only.")
    w("")
    w(f"Result: **{'passed' if doc['passed'] else 'FAILED'}**. Core SHA-256 `{doc['core_sha256']}`.")
    w("")
    w("## Step 1: the transcription against SingleStepTests 6502/v1")
    w("")
    w(f"{v['agree']:,} of {v['tests']:,} tests agree ({v['agree_decimal']:,} of {v['decimal']:,} in decimal mode). "
      "Distinct decimal-mode inputs (operation, A, operand, carry) per file show how thin the vectors are; step 2 "
      "covers every input.")
    w("")
    w("| File | Tests | Agree | Decimal-mode tests | Agree | Distinct decimal inputs | File SHA-256 |")
    w("|---|---:|---:|---:|---:|---:|---|")
    for op, r in v["files"].items():
        w(f"| `{op}` | {r['tests']:,} | {r['agree']:,} | {r['decimal']:,} | {r['agree_decimal']:,} | "
          f"{r['inputs_decimal']:,} | `{r['sha256'][:16]}…` |")
    bad = [(op, d) for op, r in v["files"].items() for d in r["disagree"]]
    if bad:
        w("")
        w("Disagreements (first per file):")
        for op, d in bad:
            w(f"- `{op}`: `{json.dumps(d)}`")
    w("")
    w("## Step 2: the core against the transcription, every input")
    w("")
    w(f"{e['tests'] - e['diverging']:,} of {e['tests']:,} tests agree. Each row is one opcode in one mode over all "
      "256 × 256 × 2 inputs (A, operand or memory byte, carry), the other flags of P varied; compared: PC, S, A, X, "
      "Y, P, halted, memory and the bus writes (the read-modify-write's old and new value). Test host WGSL "
      f"`{e['host_wgsl_sha256'][:16]}…`.")
    w("")
    w("| Batch | Tests | Agree | Diverging fields | Expectations SHA-256 |")
    w("|---|---:|---:|---|---|")
    for key, r in e["results"].items():
        fields = ", ".join(f"{f} {c}" for f, c in r["fields"].items()) or "—"
        w(f"| `{key}` | {r['tests']:,} | {r['pass_all']:,} | {fields} | `{r['expectations_sha256'][:16]}…` |")
    ex = [x for r in e["results"].values() for x in r["examples"]]
    if ex:
        w("")
        w("Examples of divergences:")
        for x in ex[:5]:
            w(f"- `{x['name']}`: `{json.dumps(x['diff'])}`")
    w("")
    return "\n".join(L)
