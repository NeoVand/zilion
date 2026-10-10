#!/usr/bin/env python3
"""Zilion headless test harness (wgpu-py). Run with `python -I tools/zt.py <command>`; see docs/TESTING.md.

Commands:
  conformance           test/conformance.js, headless
  vectors <isa> <dir>   per-instruction vectors (SingleStepTests format) -> divergence ledger
  selftest              harness self-tests on the GPU (memory-model invariance, synthetic vectors, determinism)
"""

from __future__ import annotations

import sys
from pathlib import Path

# -I (isolated mode) keeps the script directory off sys.path; add this trusted directory explicitly.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ztest.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
