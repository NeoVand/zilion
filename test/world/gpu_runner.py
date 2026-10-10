#!/usr/bin/env python3
"""Manifest-driven GPU host for Zilion machines (wgpu-py + numpy).

A test helper and a demonstration that the manifest (src/manifest.ts) is all a non-TypeScript host needs: this
file never names a register, a binding number or a params offset. (The Python runtime proper is a separate work
item; this is the minimal host the world tests run on.)

    python gpu_runner.py plan.json

plan.json: {"jobs": [{"id", "wgsl", "manifest", "lanes", "input", "seed", "budget", "ablation", "state", "budgets",
                      "chunk", "lane_base", "out_memory", "out_record"}]}
  input       host-layout lane memory, lanes x manifest.memory.hostBytesPerLane bytes (uint8)
  state       optional, lanes x stateIn wordsPerLane (uint32 LE)        (role stateIn)
  budgets     optional, lanes (uint32 LE)                                 (role budgetIn)
  ablation    optional list of u32 words                                  (param role ablation)
  chunk       optional max lanes per dispatch (lane_base advances per chunk, so hashes see global lanes)
  out_memory  host-layout final memory (uint8), out_record: lanes x record words (uint32 LE)

Adapter policy: never a CPU adapter unless ZILION_ALLOW_CPU_ADAPTER=1.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import wgpu

_DEV = None
_INFO: dict = {}


def get_device():
    global _DEV, _INFO
    if _DEV is None:
        adapters = list(wgpu.gpu.enumerate_adapters_sync())
        rank = {"DiscreteGPU": 0, "IntegratedGPU": 1, "VirtualGPU": 2, "CPU": 3, "Unknown": 4}
        adapters.sort(key=lambda a: rank.get(str(a.info.get("adapter_type", "Unknown")), 5))
        if not adapters:
            raise RuntimeError("no WebGPU adapter")
        a = adapters[0]
        if str(a.info.get("adapter_type")) in ("CPU", "Unknown") and os.environ.get("ZILION_ALLOW_CPU_ADAPTER") != "1":
            raise RuntimeError(f"best adapter is a CPU adapter ({a.info}); set ZILION_ALLOW_CPU_ADAPTER=1 to allow it")
        _INFO = dict(a.info)
        _DEV = a.request_device_sync()
    return _DEV


def adapter_summary() -> str:
    get_device()
    return f"{_INFO.get('device', '?')} ({_INFO.get('backend_type', '?')}, {_INFO.get('adapter_type', '?')})"


class Machine:
    """One compiled machine, driven by its manifest."""

    def __init__(self, wgsl: str, manifest: dict):
        self.m = manifest
        if manifest.get("entryPoint") is None:
            raise ValueError("library-mode manifests have no entry point; embed them in a host shader")
        dev = self.dev = get_device()
        self.module = dev.create_shader_module(code=wgsl)  # raises GPUValidationError with the compiler message
        btype = {
            "uniform": wgpu.BufferBindingType.uniform,
            "storage": wgpu.BufferBindingType.storage,
            "read-only-storage": wgpu.BufferBindingType.read_only_storage,
        }
        self.bindings = sorted(manifest["bindings"], key=lambda b: b["binding"])
        self.layout = dev.create_bind_group_layout(entries=[
            {"binding": b["binding"], "visibility": wgpu.ShaderStage.COMPUTE, "buffer": {"type": btype[b["type"]]}}
            for b in self.bindings])
        self.pipeline = dev.create_compute_pipeline(
            layout=dev.create_pipeline_layout(bind_group_layouts=[self.layout]),
            compute={"module": self.module, "entry_point": manifest["entryPoint"]})
        mem = manifest["memory"]
        self.host_bytes = mem["hostBytesPerLane"]
        self.storage_words = mem["storageWordsPerLane"]
        self.record_words = manifest["record"]["wordsPerLane"]

    def role(self, r: str):
        return next((b for b in self.bindings if b["role"] == r), None)

    # --- memory layout ----------------------------------------------------------------------------------------
    def pack(self, host: np.ndarray) -> np.ndarray:
        n = host.shape[0]
        st = np.zeros((n, self.storage_words * 4), dtype=np.uint8)
        for s in self.m["memory"]["segments"]:
            st[:, 4 * s["storageWord"]: 4 * s["storageWord"] + s["bytes"]] = host[:, s["hostOffset"]: s["hostOffset"] + s["bytes"]]
        return np.ascontiguousarray(st).view(np.uint32)

    def unpack(self, storage: np.ndarray) -> np.ndarray:
        n = storage.shape[0]
        st = np.ascontiguousarray(storage).view(np.uint8).reshape(n, self.storage_words * 4)
        host = np.zeros((n, self.host_bytes), dtype=np.uint8)
        for s in self.m["memory"]["segments"]:
            host[:, s["hostOffset"]: s["hostOffset"] + s["bytes"]] = st[:, 4 * s["storageWord"]: 4 * s["storageWord"] + s["bytes"]]
        return host

    def params(self, n: int, lane_base: int, seed: int, budget: int, ablation) -> bytes:
        p = np.zeros(max(self.m["params"]["bytes"], 16) // 4, dtype=np.uint32)
        for f in self.m["params"]["fields"]:
            o = f["offset"] // 4
            r = f["role"]
            if r == "laneCount":
                p[o] = n
            elif r == "laneBase":
                p[o] = lane_base
            elif r == "budget":
                p[o] = budget
            elif r == "seed":
                p[o] = seed & 0xFFFFFFFF
            elif r == "constant":
                p[o] = f["value"]
            elif r == "ablation" and ablation is not None:
                words = np.asarray(ablation, dtype=np.uint32)[: f["words"]]
                p[o: o + len(words)] = words
        return p.tobytes()

    # --- run --------------------------------------------------------------------------------------------------
    def run(self, host_mem: np.ndarray, seed=0, budget=None, ablation=None, state=None, budgets=None, lane_base=0, chunk=None):
        host_mem = np.ascontiguousarray(host_mem, dtype=np.uint8).reshape(-1, self.host_bytes)
        n = host_mem.shape[0]
        if budget is None:
            budget = self.m["budget"]["default"] if self.m["budget"]["default"] is not None else 0
        wg = self.m["workgroupSize"]
        lim = self.dev.limits.get("max-compute-workgroups-per-dimension", 65535) * wg
        chunk = min(chunk or n, lim)
        mem_out = np.zeros((n, self.host_bytes), dtype=np.uint8)
        rec_out = np.zeros((n, self.record_words), dtype=np.uint32)
        B = wgpu.BufferUsage
        for s0 in range(0, n, chunk):
            c = min(chunk, n - s0)
            storage = self.pack(host_mem[s0: s0 + c])
            bufs = {}
            res = []
            for b in self.bindings:
                r = b["role"]
                if r == "params":
                    data = self.params(c, lane_base + s0, seed, budget, ablation)
                    buf = self.dev.create_buffer(size=len(data), usage=B.UNIFORM | B.COPY_DST)
                elif r == "memory":
                    data = storage.tobytes()
                    buf = self.dev.create_buffer(size=max(len(data), 4), usage=B.STORAGE | B.COPY_SRC | B.COPY_DST)
                elif r == "record":
                    data = None
                    buf = self.dev.create_buffer(size=max(c * self.record_words * 4, 4), usage=B.STORAGE | B.COPY_SRC)
                elif r == "stateIn":
                    arr = np.ascontiguousarray(np.asarray(state, dtype=np.uint32).reshape(n, -1)[s0: s0 + c])
                    data = arr.tobytes()
                    buf = self.dev.create_buffer(size=max(len(data), 4), usage=B.STORAGE | B.COPY_DST)
                elif r == "budgetIn":
                    data = np.ascontiguousarray(np.asarray(budgets, dtype=np.uint32)[s0: s0 + c]).tobytes()
                    buf = self.dev.create_buffer(size=max(len(data), 4), usage=B.STORAGE | B.COPY_DST)
                else:
                    raise ValueError(f"unknown binding role {r}")
                if data:
                    self.dev.queue.write_buffer(buf, 0, data)
                bufs[r] = buf
                res.append({"binding": b["binding"], "resource": {"buffer": buf, "offset": 0, "size": buf.size}})
            bg = self.dev.create_bind_group(layout=self.layout, entries=res)
            enc = self.dev.create_command_encoder()
            p = enc.begin_compute_pass()
            p.set_pipeline(self.pipeline)
            p.set_bind_group(0, bg)
            p.dispatch_workgroups(-(-c // (wg * self.m.get("lanesPerInvocation", 1))))
            p.end()
            self.dev.queue.submit([enc.finish()])
            st = np.frombuffer(self.dev.queue.read_buffer(bufs["memory"]), dtype=np.uint32)[: c * self.storage_words]
            mem_out[s0: s0 + c] = self.unpack(st.reshape(c, self.storage_words))
            rec_out[s0: s0 + c] = np.frombuffer(self.dev.queue.read_buffer(bufs["record"]), dtype=np.uint32)[: c * self.record_words].reshape(c, self.record_words)
            for b in bufs.values():
                b.destroy()
        return mem_out, rec_out


def main(plan_path: str) -> int:
    plan = json.load(open(plan_path))
    base = os.path.dirname(os.path.abspath(plan_path))
    path = lambda p: p if os.path.isabs(p) else os.path.join(base, p)  # noqa: E731
    machines: dict = {}
    errors = 0
    for job in plan["jobs"]:
        key = (job["wgsl"], job["manifest"])
        try:
            if key not in machines:
                machines[key] = Machine(open(path(job["wgsl"])).read(), json.load(open(path(job["manifest"]))))
            m = machines[key]
            lanes = job["lanes"]
            host = np.fromfile(path(job["input"]), dtype=np.uint8).reshape(lanes, m.host_bytes)
            state = np.fromfile(path(job["state"]), dtype="<u4") if job.get("state") else None
            budgets = np.fromfile(path(job["budgets"]), dtype="<u4") if job.get("budgets") else None
            mem, rec = m.run(host, seed=job.get("seed", 0), budget=job.get("budget"), ablation=job.get("ablation"),
                             state=state, budgets=budgets, lane_base=job.get("lane_base", 0), chunk=job.get("chunk"))
            mem.tofile(path(job["out_memory"]))
            rec.astype("<u4").tofile(path(job["out_record"]))
        except Exception as e:  # report and continue: the driver marks the job failed
            errors += 1
            with open(path(job["out_record"]) + ".error", "w") as f:
                f.write(f"{type(e).__name__}: {e}")
    print(f"[gpu_runner] {len(plan['jobs'])} jobs, {len(machines)} machines, {errors} errors on {adapter_summary()}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
