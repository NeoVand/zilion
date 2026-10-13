#!/usr/bin/env python3
"""Write analytic Z80 vectors (SingleStepTests format) for behaviour SingleStepTests/z80 does not exercise.

Wasted prefixes: a DD or FD prefix immediately followed by DD, FD or ED. One step consumes only the first prefix:
it is one M1 cycle, so R gains 1 in its low 7 bits (bit 7 kept) and PC moves past the prefix; nothing else
changes. The following byte starts the next step. Sources: Sean Young, "The Undocumented Z80 Documented"
(prefix sequences; R counts M1 cycles); design 2026-10-10 §5.2 (Zilion's step = a wasted prefix).

The interrupt latches and Q are set to 0 before and after, so the vectors make no claim about them; WZ, IFF and
IM are unchanged by a prefix. Values come from a fixed-seed Mersenne Twister, so the files are reproducible.

Usage: python -I tools/z80-analytic-vectors.py [out_dir]     (default test/vectors/z80/analytic)
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

PAIRS = [(0xDD, 0xDD), (0xDD, 0xFD), (0xDD, 0xED), (0xFD, 0xDD), (0xFD, 0xFD), (0xFD, 0xED)]
TESTS_PER_FILE = 64
SEED = 0x5A80


def state(rng: random.Random, pc: int, r: int) -> dict:
    s = {"pc": pc, "sp": rng.getrandbits(16)}
    for k in ("a", "b", "c", "d", "e", "f", "h", "l", "i"):
        s[k] = rng.getrandbits(8)
    s["r"] = r
    s |= {"ei": 0, "wz": rng.getrandbits(16), "ix": rng.getrandbits(16), "iy": rng.getrandbits(16)}
    for k in ("af_", "bc_", "de_", "hl_"):
        s[k] = rng.getrandbits(16)
    iff = rng.getrandbits(1)
    s |= {"im": rng.randrange(3), "p": 0, "q": 0, "iff1": iff, "iff2": iff}
    return s


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "test/vectors/z80/analytic"
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    for p1, p2 in PAIRS:
        tests = []
        for k in range(TESTS_PER_FILE):
            pc = 0xFFFF if k == 0 else rng.getrandbits(16)  # test 0 straddles the top of memory
            r = [0x7F, 0xFF][k] if k < 2 else rng.getrandbits(8)  # tests 0 and 1 wrap the 7-bit counter
            ini = state(rng, pc, r)
            ram = [[pc, p1], [(pc + 1) & 0xFFFF, p2]]
            fin = {k2: v for k2, v in ini.items()}
            fin["pc"] = (pc + 1) & 0xFFFF
            fin["r"] = (r & 0x80) | ((r + 1) & 0x7F)
            tests.append({"name": f"{p1:02x} {p2:02x} {k:04x}", "initial": ini | {"ram": ram},
                          "final": fin | {"ram": ram}})
        path = out / f"{p1:02x} {p2:02x}.json"
        path.write_text(json.dumps(tests, separators=(",", ":")) + "\n")
        print(f"wrote {path} ({len(tests)} tests)")


if __name__ == "__main__":
    main()
