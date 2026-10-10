"""One vector run: list files, parse (in worker processes), batch onto the GPU, build the ledger."""

from __future__ import annotations

import fnmatch
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .. import HARNESS_VERSION
from .. import gpu as G
from ..artifacts import REPO, Artifacts
from . import sst
from .ledger import Ledger
from .model import Rule
from .runner import Runner
from .z80 import Z80Adapter

ADAPTERS = {"z80": Z80Adapter}


def default_rules_path(isa: str, version: str) -> Path:
    return REPO / "test" / "vectors" / isa / f"expected-{version}.json"


def load_rules(path: Path) -> tuple[list[Rule], dict]:
    d = json.loads(path.read_text(encoding="utf-8"))
    return [Rule.from_json(r) for r in d["rules"]], d


def list_files(adapter, dirs: list[Path], patterns: list[str] | None) -> list[tuple[str, Path]]:
    seen: dict[str, Path] = {}
    for d in dirs:
        if not d.is_dir():
            raise G.HarnessError(f"vector directory {d} not found")
        for p in sorted(d.glob(adapter.file_glob)):
            if not p.is_file():
                continue
            key = adapter.key_of(p)
            if patterns and not any(fnmatch.fnmatchcase(key, pat) for pat in patterns):
                continue
            if key in seen:
                raise G.HarnessError(f"opcode key {key!r} appears twice: {seen[key]} and {p}")
            seen[key] = p
    return sorted(seen.items(), key=lambda kv: adapter.sort_key(kv[0]))


def _parse(args):
    key, path, isa, mem_cap, port_cap, limit, only = args
    fb = sst.parse_file(path, key, ADAPTERS[isa](), mem_cap, port_cap)
    if only or limit:
        idx = [i for i, n in enumerate(fb.names) if (not only or n in only)][: limit or None]
        fb = fb.subset(idx)
    fb.tests = []  # dropped here; the ledger reloads a file's tests only when it needs examples
    return fb


def run(art: Artifacts, isa: str, dirs: list[Path], *, patterns=None, limit_per_file=0, only_tests=None,
        mode="sparse", mem_cap=32, port_cap=8, lanes=None, repeat=1, rules_path: Path | None = None,
        workers: int | None = None, progress=print) -> tuple[Ledger, dict]:
    t_start = time.perf_counter()
    adapter = ADAPTERS[isa]()
    core = art.core(isa)
    gpu = G.get_gpu()
    runner = Runner(gpu, adapter, core, mode=mode, mem_cap=mem_cap, port_cap=port_cap, lanes_per_dispatch=lanes,
                    repeat=repeat)
    rules_path = rules_path or default_rules_path(isa, art.version)
    rules, rules_doc = load_rules(rules_path)
    declared = sorted(rules_doc.get("passthrough", []))
    if declared != sorted(adapter.passthrough):
        raise G.HarnessError(
            f"{rules_path.name} declares passed-through fields {declared}, but this core passes through "
            f"{sorted(adapter.passthrough)}: the expected rules do not describe this core"
        )
    ledger = Ledger(adapter, rules, mem_cap=mem_cap, port_cap=port_cap)
    files = list_files(adapter, dirs, patterns)
    if not files:
        raise G.HarnessError("no vector files matched")

    t_gpu = t_ledger = 0.0
    jobs = [(k, p, isa, mem_cap, port_cap, limit_per_file, set(only_tests or ())) for k, p in files]
    workers = workers if workers is not None else max(1, min(8, (os.cpu_count() or 2) - 1))
    pending = []

    def flush():
        nonlocal t_gpu, t_ledger
        if not pending:
            return
        t0 = time.perf_counter()
        outs = runner.run(pending)
        t1 = time.perf_counter()
        for fb, out in zip(pending, outs):
            fb.tests_loader = lambda path=fb.path, digest=fb.sha256: _reload(path, digest)
            ledger.add(fb, out)
        t2 = time.perf_counter()
        t_gpu += t1 - t0
        t_ledger += t2 - t1
        pending.clear()

    tests = 0
    pool = ProcessPoolExecutor(max_workers=workers) if workers > 1 else None
    try:
        it = pool.map(_parse, jobs, chunksize=4) if pool else map(_parse, jobs)
        queued = 0
        for k, fb in enumerate(it):
            if fb.n == 0:  # every test filtered out (--test)
                continue
            if pending and queued + fb.n > runner.lanes:
                flush()
                queued = 0
            pending.append(fb)
            queued += fb.n
            tests += fb.n
            if progress and (k + 1) % 200 == 0:
                progress(f"  {k + 1}/{len(files)} files, {tests:,} tests")
        flush()
    finally:
        if pool:
            pool.shutdown()
    t_total = time.perf_counter() - t_start
    t_parse = t_total - t_gpu - t_ledger
    meta = {
        "isa": isa,
        "harness": {"version": HARNESS_VERSION, "memory": mode, "mem_cap": mem_cap, "port_cap": port_cap,
                    "steps": 1, "host_wgsl_sha256": runner.wgsl_sha256, "passthrough": sorted(adapter.passthrough)},
        "provenance": art.provenance(isa),
        "vectors": {
            "dirs": [str(d) for d in dirs],
            "files": len(ledger.files),
            "tests": tests,
            "files_sha256": _files_digest(ledger),
            "filters": {"patterns": patterns or [], "limit_per_file": limit_per_file, "tests": sorted(only_tests or [])},
        },
        "coverage": _coverage(adapter, list(ledger.files)),
        "expected_rules": {"file": str(rules_path.relative_to(REPO)) if rules_path.is_relative_to(REPO) else str(rules_path)},
    }
    run_info = {
        "source": art.source(),
        "adapter": gpu.adapter_info,
        "dispatches": runner.dispatches,
        "lanes_per_dispatch": runner.lanes,
        "repeat": repeat,
        "workers": workers,
        "seconds": {"total": round(t_total, 2), "parse+other": round(t_parse, 2), "gpu": round(t_gpu, 2),
                    "ledger": round(t_ledger, 2)},
    }
    return ledger, {"meta": meta, "run": run_info, "wgsl": runner.wgsl}


def _files_digest(ledger: Ledger) -> str:
    import hashlib

    h = hashlib.sha256()
    for k in ledger.ordered_keys():
        h.update(f"{k}:{ledger.files[k]['sha256']}\n".encode())
    return h.hexdigest()


def _reload(path: Path, digest: str) -> list:
    tests, d = sst.load_tests(path)
    if d != digest:
        raise G.HarnessError(f"{path} changed during the run")
    return tests


def _coverage(adapter, keys: list[str]) -> dict:
    """Which reference files ran and which are absent, per group (when the adapter knows the reference set)."""
    ref = getattr(adapter, "reference_keys", None)
    if ref is None:
        return {}
    ref = ref()
    present = set(keys)
    out = {"reference_files": len(ref), "present": sum(k in present for k in ref),
           "extra": sorted((k for k in keys if k not in set(ref)), key=adapter.sort_key), "missing_by_group": {}}
    for k in ref:
        if k not in present:
            out["missing_by_group"].setdefault(adapter.group(k), []).append(k)
    return out
