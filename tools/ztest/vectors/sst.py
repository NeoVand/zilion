"""Parser for the SingleStepTests per-instruction JSON layout (z80, 65x02, 8086/8088, ...).

A file is a JSON array of tests: {name, initial: {<fields>, ram: [[addr, value], ...]}, final: {...},
ports?: [[port, value, "r" | "w"], ...], cycles: [...]}. Files are untrusted data: they are parsed only as JSON
(gzip-decompressed when the name ends in .gz), every value is checked to be an integer inside its field's width,
and nothing in them is ever executed or used as a path. `cycles` is not used (the cores are not cycle-accurate).

Adapters whose layout differs (nested register blocks, for example) override `state_values`.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path

import numpy as np

from ..gpu import HarnessError
from .model import READABLE, FileBatch


def _int_matrix(rows: list, width: int, what: str, path: Path) -> np.ndarray:
    """rows -> int64 [n, width] array; raises unless every element is a JSON integer."""
    if not rows:
        return np.zeros((0, width), dtype=np.int64)
    try:
        arr = np.array(rows)  # floats, strings, null or huge integers give a non-integer dtype
    except ValueError:
        arr = np.zeros(0)
    if arr.dtype.kind not in "iu" or arr.shape != (len(rows), width):
        raise HarnessError(f"{path.name}: {what} is not an integer matrix of width {width}")
    return arr.astype(np.int64)


def load_tests(path: Path) -> tuple[list, str]:
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    try:
        text = gzip.decompress(raw) if path.name.endswith(".gz") else raw
        tests = json.loads(text)
    except (OSError, ValueError) as e:
        raise HarnessError(f"{path.name}: not a (gzipped) JSON file: {e}") from None
    if not isinstance(tests, list) or not all(isinstance(t, dict) for t in tests):
        raise HarnessError(f"{path.name}: expected a JSON array of test objects")
    return tests, digest


def parse_file(path: Path, key: str, adapter, mem_cap: int, port_cap: int) -> FileBatch:
    tests, digest = load_tests(path)
    fields = adapter.fields
    n, F = len(tests), len(fields)
    try:
        names = [t["name"] for t in tests]
        rows_in = [adapter.state_values(t["initial"]) for t in tests]
        rows_exp = [adapter.state_values(t["final"]) for t in tests]
    except (KeyError, TypeError) as e:
        raise HarnessError(f"{path.name}: missing or malformed state field: {e!r}") from None
    if not all(isinstance(x, str) for x in names):
        raise HarnessError(f"{path.name}: a test name is not a string")
    state_in = _int_matrix(rows_in, F, "initial state", path)
    state_exp = _int_matrix(rows_exp, F, "final state", path)
    masks = np.array([f.mask for f in fields], dtype=np.int64)
    for arr, what in ((state_in, "initial"), (state_exp, "final")):
        if n and ((arr < 0) | (arr > masks)).any():
            i, j = np.argwhere((arr < 0) | (arr > masks))[0]
            raise HarnessError(f"{path.name}: {names[i]}: {what} {fields[j].name}={arr[i, j]} exceeds {fields[j].bits} bits")

    addr_mask = (1 << adapter.addr_bits) - 1
    mem_n = np.zeros(n, dtype=np.uint32)
    mem_addr = np.zeros((n, mem_cap), dtype=np.uint32)
    mem_init = np.zeros((n, mem_cap), dtype=np.uint32)
    mem_exp = np.zeros((n, mem_cap), dtype=np.uint32)
    mem_final_only = np.zeros((n, mem_cap), dtype=bool)
    port_in_n = np.zeros(n, dtype=np.uint32)
    port_in = np.zeros((n, port_cap, 2), dtype=np.uint32)
    port_out_n = np.zeros(n, dtype=np.uint32)
    port_out = np.zeros((n, port_cap, 2), dtype=np.uint32)
    for i, t in enumerate(tests):
        try:
            ram0 = t["initial"]["ram"]
            ram1 = t["final"]["ram"]
            ports = t.get("ports", [])
            init = {}
            for a, v in ram0:
                init[a] = v
            fin = {}
            for a, v in ram1:
                fin[a] = v
        except (KeyError, TypeError, ValueError) as e:
            raise HarnessError(f"{path.name}: {names[i]}: malformed ram: {e!r}") from None
        for d in (init, fin):
            for a, v in d.items():
                if type(a) is not int or type(v) is not int or not (0 <= a <= addr_mask) or not (0 <= v <= 0xFF):
                    raise HarnessError(f"{path.name}: {names[i]}: bad ram entry [{a!r}, {v!r}]")
        union = sorted(set(init) | set(fin))
        # Leave at least 8 free slots per lane for stray writes.
        if len(union) > mem_cap - 8:
            raise HarnessError(f"{path.name}: {names[i]}: {len(union)} RAM addresses exceed the table (cap {mem_cap})")
        mem_n[i] = len(union)
        for k, a in enumerate(union):
            mem_addr[i, k] = a
            if a in init:
                mem_init[i, k] = init[a] | READABLE
            mem_exp[i, k] = fin.get(a, init.get(a, 0))
            mem_final_only[i, k] = a not in init
        if not isinstance(ports, list):
            raise HarnessError(f"{path.name}: {names[i]}: ports is not a list")
        for e in ports:
            if (not isinstance(e, list) or len(e) != 3 or type(e[0]) is not int or type(e[1]) is not int
                    or e[2] not in ("r", "w") or not (0 <= e[0] <= 0xFFFFFFFF) or not (0 <= e[1] <= 0xFF)):
                raise HarnessError(f"{path.name}: {names[i]}: bad ports entry {e!r}")
            if e[2] == "r":
                if port_in_n[i] >= port_cap:
                    raise HarnessError(f"{path.name}: {names[i]}: more than {port_cap} port reads")
                port_in[i, port_in_n[i]] = e[:2]
                port_in_n[i] += 1
            else:
                if port_out_n[i] >= port_cap:
                    raise HarnessError(f"{path.name}: {names[i]}: more than {port_cap} port writes")
                port_out[i, port_out_n[i]] = e[:2]
                port_out_n[i] += 1
    return FileBatch(
        key=key, path=path, sha256=digest, names=names,
        state_in=state_in.astype(np.uint32), state_exp=state_exp.astype(np.uint32),
        mem_n=mem_n, mem_addr=mem_addr, mem_init=mem_init, mem_exp=mem_exp, mem_final_only=mem_final_only,
        port_in_n=port_in_n, port_in=port_in, port_out_n=port_out_n, port_out=port_out,
        orig=np.arange(n), tests=tests,
    )
