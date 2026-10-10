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

    a = ap.parse_args(argv)
    try:
        if a.cmd == "conformance":
            from . import conformance

            art = artifacts.load(a.wgsl_dir, do_emit=not a.no_emit)
            return conformance.run(art, a.out)
    except HarnessError as e:
        print(f"zt: harness error: {e}")
        return 2
    return 0

