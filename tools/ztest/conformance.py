"""Headless port of test/conformance.js.

The vectors and their check functions stay in test/conformance.js (single source of truth). This module:
  1. compiles the shaders tools/build-wgsl.mjs emitted with the public `buildComputeShader(256, {fetchHook})`;
  2. runs every vector through `run_batch`, a Python twin of `Zilion.run` (src/zilion.ts): same memory packing,
     same register defaults (all 0, SP = 0xFFFF), same Params {count, mem_bytes, steps, 0}, same bindings and
     workgroup count. Like the browser page, each vector is its own one-program batch;
  3. runs the 8192-program parallel batch;
  4. hands the raw registers and memory to tools/conformance-check.mjs, which applies the original checks.

What the port does not cover: Zilion.run's own TypeScript buffer handling, which only a WebGPU host
(the browser page, or Node + Dawn later) exercises.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from . import gpu as G
from .artifacts import Artifacts, run_node

REGS_PER_PROGRAM = 12
SP_INDEX = 6  # REG_FIELDS order: af bc de hl ix iy sp pc af' bc' de' hl'
BINDINGS = ["uniform", "storage", "storage", "read-only-storage"]  # params, mem_io, regs_out, regs_in


def run_batch(device, pipeline, layout, programs: list[list[int]], steps: int, mem_bytes: int):
    """Twin of Zilion.run(programs, {steps}) without `init`: returns (regs [N,12] u32, memory [N,mem_bytes] u8)."""
    n = len(programs)
    mem = np.zeros((n, mem_bytes), dtype=np.uint8)
    for i, p in enumerate(programs):
        m = min(len(p), mem_bytes)
        mem[i, :m] = np.asarray(p[:m], dtype=np.uint32) & 0xFF
    regs = np.zeros((n, REGS_PER_PROGRAM), dtype=np.uint32)
    regs[:, SP_INDEX] = 0xFFFF
    mem_buf = G.storage_buffer(device, mem.reshape(-1).view(np.uint32), readback=True)
    regs_out = G.storage_buffer(device, regs.nbytes, readback=True)
    regs_in = G.storage_buffer(device, regs)
    params = G.uniform_buffer(device, [n, mem_bytes, steps, 0])
    G.dispatch(device, pipeline, layout, [params, mem_buf, regs_out, regs_in], n)
    out_mem = G.read_u32(device, mem_buf).view(np.uint8)[: n * mem_bytes].reshape(n, mem_bytes)
    out_regs = G.read_u32(device, regs_out, n * REGS_PER_PROGRAM).reshape(n, REGS_PER_PROGRAM)
    for b in (mem_buf, regs_out, regs_in, params):
        b.destroy()
    return out_regs, out_mem


def run(art: Artifacts, out_dir: Path) -> int:
    gpu = G.get_gpu()
    plan = art.json(art.manifest["conformance"]["plan"])
    mem_bytes = plan["memBytes"]
    pipes = [
        G.compile_pipeline(gpu.device, art.text(s), BINDINGS, label=f"conformance shader-{i}")
        for i, s in enumerate(plan["shaders"])
    ]
    vectors = []
    for v in plan["vectors"]:
        pipe, layout = pipes[v["shader"]]
        regs, mem = run_batch(gpu.device, pipe, layout, [v["program"]], v["steps"], mem_bytes)
        vectors.append({"index": v["index"], "regs": regs[0].tolist(), "mem": mem[0].tolist()})
    par = plan["parallel"]
    pipe, layout = pipes[par["shader"]]
    t0 = time.perf_counter()
    regs, _ = run_batch(gpu.device, pipe, layout, [par["program"]] * par["count"], par["steps"], mem_bytes)
    ms = (time.perf_counter() - t0) * 1e3

    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "conformance-results.json"
    results_path.write_text(json.dumps({"vectors": vectors, "parallel": {"regs": regs.tolist(), "ms": ms}}))
    r = run_node("conformance-check.mjs", str(art.root / art.manifest["conformance"]["plan"]), str(results_path))
    if r.returncode not in (0, 1) or not r.stdout.strip():
        raise G.HarnessError(f"tools/conformance-check.mjs failed:\n{r.stderr}")
    report = json.loads(r.stdout)
    for x in report["results"]:
        print(f"{'PASS' if x['ok'] else 'FAIL'}  {x['name']} — {x['detail']}")
    p = report["parallel"]
    print(f"\n{'PASS' if p['ok'] else 'FAIL'}  {p['count']:,} parallel in {p['ms']:.1f} ms")
    print(f"\n{report['passed']}/{report['total']} vectors passed on {gpu.summary()}"
          f" (zilion {art.version}, z80 core {art.manifest['cores']['z80']['sha256'][:12]})")
    return r.returncode
