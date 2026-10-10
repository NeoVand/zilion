"""Command-line entry for tools/zt.py."""

from __future__ import annotations

import argparse
from pathlib import Path

from . import artifacts
from .gpu import HarnessError

REPO = artifacts.REPO


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--wgsl-dir", type=Path, default=artifacts.DEFAULT_WGSL_DIR, help="emitted WGSL (default build/wgsl)")
    p.add_argument("--no-emit", action="store_true", help="reuse the emitted WGSL instead of running tools/build-wgsl.mjs")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="zt.py", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("conformance", help="run test/conformance.js headlessly")
    _common(c)
    c.add_argument("--out", type=Path, default=REPO / "build" / "test", help="results directory")

    v = sub.add_parser("vectors", help="run per-instruction vectors and write the divergence ledger")
    _common(v)
    v.add_argument("isa", choices=["z80"])
    v.add_argument("dirs", type=Path, nargs="+", help="vector directories (SingleStepTests layout, .json or .json.gz)")
    v.add_argument("--files", nargs="*", help="only these opcode keys (fnmatch patterns, e.g. 'ed b?' 'cb 4?')")
    v.add_argument("--test", nargs="*", help="only these test names (e.g. 'ed 70 0123')")
    v.add_argument("--limit-per-file", type=int, default=0, help="first N tests of each file (0 = all)")
    v.add_argument("--memory", choices=["sparse", "full"], default="sparse", help="memory model of the test host")
    v.add_argument("--mem-cap", type=int, default=32, help="memory-table slots per lane")
    v.add_argument("--port-cap", type=int, default=8, help="port-table slots per lane (reads and writes each)")
    v.add_argument("--lanes", type=int, help="lanes per dispatch (default 65536 sparse, 1024 full)")
    v.add_argument("--repeat", type=int, default=1, help="run every dispatch N times and require identical bytes")
    v.add_argument("--workers", type=int, help="parser processes (default min(8, cpus-1); 1 = in-process)")
    v.add_argument("--expected", type=Path, help="expected-divergence rules (default test/vectors/<isa>/expected-<version>.json)")
    v.add_argument("--json", type=Path, help="write the ledger JSON here (canonical; deterministic)")
    v.add_argument("--run-json", type=Path, help="write run information (adapter, timing) here")
    v.add_argument("--md", type=Path, help="write the Markdown report here")
    v.add_argument("--analysis", type=Path, help="Markdown included verbatim in the report (hand-written analysis)")
    v.add_argument("--show", type=int, default=20, help="unexpected classes to print")
    v.add_argument("--dump-wgsl", type=Path, help="write the composed test shader (host + glue + core) here")

    t = sub.add_parser("selftest", help="harness self-tests on the GPU")
    _common(t)
    t.add_argument("--vectors", type=Path, help="Z80 vector directory for the mutant, invariance and determinism tests")
    t.add_argument("--limit-per-file", type=int, default=50, help="tests per file for invariance and determinism")

    a = ap.parse_args(argv)
    try:
        if a.cmd == "selftest":
            from . import selftest

            art = artifacts.load(a.wgsl_dir, do_emit=not a.no_emit)
            return selftest.run(art, a.vectors, a.limit_per_file)
        if a.cmd == "conformance":
            from . import conformance

            art = artifacts.load(a.wgsl_dir, do_emit=not a.no_emit)
            return conformance.run(art, a.out)
        if a.cmd == "vectors":
            return _vectors(a)
    except HarnessError as e:
        print(f"zt: harness error: {e}")
        return 2
    return 0


def _vectors(a) -> int:
    from .vectors import report, session
    from .vectors.ledger import canonical_json

    art = artifacts.load(a.wgsl_dir, do_emit=not a.no_emit)
    ledger, info = session.run(
        art, a.isa, a.dirs, patterns=a.files, limit_per_file=a.limit_per_file, only_tests=a.test, mode=a.memory,
        mem_cap=a.mem_cap, port_cap=a.port_cap, lanes=a.lanes, repeat=a.repeat, rules_path=a.expected,
        workers=a.workers,
    )
    if a.dump_wgsl:
        a.dump_wgsl.parent.mkdir(parents=True, exist_ok=True)
        a.dump_wgsl.write_text(info["wgsl"], encoding="utf-8")
    doc = ledger.to_json(info["meta"])
    text = canonical_json(doc)
    digest = report.sha256(text)
    if a.json:
        a.json.parent.mkdir(parents=True, exist_ok=True)
        a.json.write_text(text, encoding="utf-8")
    if a.run_json:
        a.run_json.parent.mkdir(parents=True, exist_ok=True)
        a.run_json.write_text(canonical_json(info["run"] | {"ledger_sha256": digest}), encoding="utf-8")
    if a.md:
        a.md.parent.mkdir(parents=True, exist_ok=True)
        analysis = a.analysis.read_text(encoding="utf-8") if a.analysis else None
        a.md.write_text(report.markdown(doc, info["run"], digest, analysis), encoding="utf-8")
    print(report.console(doc, info["run"], digest, a.show))
    return 1 if doc["summary"]["totals"].get("unexpected", 0) else 0
