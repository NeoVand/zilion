"""Timing host for test/bench/bench-cores.mjs (wgpu-py). Reads a plan of compiled machines and prints, per
configuration, the time per dispatch, lanes per second and executed steps per second. See bench-cores.mjs."""

from __future__ import annotations

import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "world"))
import gpu_runner as G  # noqa: E402

wgpu = G.wgpu


def bench(m: G.Machine, host: np.ndarray, budget: int, reps: int) -> dict:
    dev = m.dev
    n = host.shape[0]
    B = wgpu.BufferUsage
    storage = m.pack(host)
    pristine = dev.create_buffer_with_data(data=storage.tobytes(), usage=B.STORAGE | B.COPY_SRC)
    work = dev.create_buffer(size=pristine.size, usage=B.STORAGE | B.COPY_SRC | B.COPY_DST)
    record = dev.create_buffer(size=n * m.record_words * 4, usage=B.STORAGE | B.COPY_SRC)
    params = dev.create_buffer_with_data(data=m.params(n, 0, 1, budget, None), usage=B.UNIFORM | B.COPY_DST | B.COPY_SRC)
    res = {"params": params, "memory": work, "record": record}
    entries = [{"binding": b["binding"], "resource": {"buffer": res[b["role"]], "offset": 0, "size": res[b["role"]].size}}
               for b in m.bindings]
    bg = dev.create_bind_group(layout=m.layout, entries=entries)
    wg = m.m["workgroupSize"]

    def once() -> float:
        enc = dev.create_command_encoder()
        enc.copy_buffer_to_buffer(pristine, 0, work, 0, pristine.size)
        p = enc.begin_compute_pass()
        p.set_pipeline(m.pipeline)
        p.set_bind_group(0, bg)
        p.dispatch_workgroups(-(-n // wg))
        p.end()
        t0 = time.perf_counter()
        dev.queue.submit([enc.finish()])
        dev.queue.read_buffer(params)  # waits for the queue (a 16-byte readback)
        return time.perf_counter() - t0

    once()  # warm-up (pipeline, residency)
    times = [once() for _ in range(reps)]
    rec = np.frombuffer(dev.queue.read_buffer(record), dtype=np.uint32).reshape(n, m.record_words)
    off = {f["name"]: f["offset"] for f in m.m["record"]["fields"]}
    steps = rec[:, off["steps"]].astype(np.int64)
    halted = rec[:, off["haltReason"]] != 0
    for b in (pristine, work, record, params):
        b.destroy()
    t = float(np.median(times))
    return {"seconds_median": t, "seconds_min": float(min(times)), "lanes_per_s": n / t,
            "steps_per_s": float(steps.sum()) / t, "mean_steps": float(steps.mean()), "halted_share": float(halted.mean())}


def main(plan_path: str, out_path: str | None) -> int:
    plan = json.load(open(plan_path))
    base = os.path.dirname(os.path.abspath(plan_path))
    n = plan["lanes"]
    rng = np.random.default_rng(plan["seed"])
    host = rng.integers(0, 256, size=(n, 32), dtype=np.uint8)  # the same random programs for every configuration
    rows = []
    print(f"bench: {n:,} lanes of random 32-byte rings (pair [16,16]), median of {plan['reps']} dispatches, on {G.adapter_summary()}")
    print(f"{'configuration':<24} {'ms/dispatch':>11} {'Mlanes/s':>9} {'Msteps/s':>9} {'mean steps':>10} {'halted':>7}  note")
    for c in plan["configs"]:
        m = G.Machine(open(os.path.join(base, c["wgsl"])).read(), json.load(open(os.path.join(base, c["manifest"]))))
        r = bench(m, host, c["budget"], plan["reps"])
        rows.append(c | r)
        print(f"{c['name']:<24} {1e3 * r['seconds_median']:>11.2f} {r['lanes_per_s'] / 1e6:>9.2f} {r['steps_per_s'] / 1e6:>9.1f} "
              f"{r['mean_steps']:>10.1f} {r['halted_share']:>7.3f}  {c['note']}")
    if out_path:
        with open(out_path, "w") as f:
            json.dump({"adapter": G.adapter_summary(), "lanes": n, "reps": plan["reps"], "rows": rows}, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
