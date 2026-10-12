"""Batch execution of packed vector files on the GPU.

Tests from many files are concatenated into one dispatch (default 65,536 lanes in sparse mode, 1,024 in full mode),
and the outputs are split back per file. With `repeat` > 1 every dispatch runs that many times and the outputs must
be byte-identical, or the run fails (a determinism check).
"""

from __future__ import annotations

import hashlib
import os
import time

import numpy as np

from .. import gpu as G
from .host import FULL_STRIDE, STATUS_WORDS, HostLayout, build_host
from .model import FileBatch, LaneOutputs

DEFAULT_LANES = {"sparse": 65536, "full": 1024}
WEBGPU_DEFAULT_MAX_BINDING = 128 << 20  # maxStorageBufferBindingSize default


class Runner:
    def __init__(self, gpu: G.Gpu, adapter, core: str, *, mode: str = "sparse", mem_cap: int = 32,
                 port_cap: int = 8, steps: int = 1, lanes_per_dispatch: int | None = None, repeat: int = 1):
        self.gpu = gpu
        self.adapter = adapter
        self.steps = steps
        self.repeat = max(1, repeat)
        self.layout = HostLayout(state_words=len(adapter.fields), mem_cap=mem_cap, port_cap=port_cap,
                                 addr_bits=adapter.addr_bits, mode=mode, write_cap=getattr(adapter, "write_cap", 0))
        self.wgsl = build_host(self.layout, core, adapter.glue(core), adapter.step_call)
        self.pipeline, self.bgl = G.compile_pipeline(gpu.device, self.wgsl, self.layout.bindings,
                                                     label=f"{adapter.isa} vector host ({mode})")
        lanes = lanes_per_dispatch or DEFAULT_LANES[mode]
        if mode == "full":
            lanes = min(lanes, WEBGPU_DEFAULT_MAX_BINDING // (FULL_STRIDE * 4))
        # Sparse hosts with wide address spaces/string logs can exceed default
        # binding limits long before the workgroup-count limit.
        largest_stride = max(self.layout.mem_stride, self.layout.port_stride, self.layout.state_words, STATUS_WORDS)
        lanes = min(lanes, WEBGPU_DEFAULT_MAX_BINDING // (largest_stride * 4))
        self.lanes = min(lanes, G.MAX_LANES_PER_DISPATCH)
        self._full = None
        if mode == "full":
            self._full = gpu.device.create_buffer(
                size=self.lanes * FULL_STRIDE * 4,
                usage=G.wgpu.BufferUsage.STORAGE | G.wgpu.BufferUsage.COPY_DST,
            )
        self.dispatches = 0

    @property
    def wgsl_sha256(self) -> str:
        return hashlib.sha256(self.wgsl.encode()).hexdigest()

    def run(self, files: list[FileBatch]) -> list[LaneOutputs]:
        """Execute every test of `files`; returns one LaneOutputs per file, in order."""
        L = self.layout
        cat = lambda xs: np.concatenate(xs) if xs else np.zeros(0, np.uint32)  # noqa: E731
        state_in = cat([f.state_in for f in files]).reshape(-1, L.state_words)
        N = state_in.shape[0]
        mem = np.zeros((N, L.mem_stride), dtype=np.uint32)  # the table, then the bus-write log (zeroed), if any
        T = L.table_words
        mem[:, 0] = cat([f.mem_n for f in files])
        mem[:, 1:T:2] = cat([f.mem_addr for f in files]).reshape(N, L.mem_cap)
        mem[:, 2:T:2] = cat([f.mem_init for f in files]).reshape(N, L.mem_cap)
        ports = np.zeros((N, L.port_stride), dtype=np.uint32)
        ports[:, 0] = cat([f.port_in_n for f in files])
        ports[:, 2 : 2 + 2 * L.port_cap] = cat([f.port_in for f in files]).reshape(N, 2 * L.port_cap)

        outs = []
        for s in range(0, N, self.lanes):
            e = min(N, s + self.lanes)
            first = None
            for _ in range(self.repeat):
                got = self._dispatch(state_in[s:e], mem[s:e], ports[s:e])
                if first is None:
                    first = got
                elif any(not np.array_equal(a, b) for a, b in zip(first, got)):
                    raise G.HarnessError(f"non-deterministic GPU output in lanes {s}..{e - 1} across repeated dispatches")
            outs.append(first)
        st, mm, pp, ss = (np.concatenate([o[k] for o in outs]) if outs else None for k in range(4))

        result, row = [], 0
        P, W = L.port_cap, L.write_cap
        for f in files:
            sl = slice(row, row + f.n)
            row += f.n
            m, p = mm[sl], pp[sl]
            result.append(LaneOutputs(
                state=st[sl],
                mem_n=m[:, 0],
                mem_addr=m[:, 1:T:2],
                mem_word=m[:, 2:T:2],
                port_in_word=p[:, 3 : 2 + 2 * P : 2],
                port_out_n=p[:, 1],
                port_out=p[:, 2 + 2 * P : 2 + 4 * P].reshape(-1, P, 2),
                status=ss[sl],
                bus_n=m[:, T] if W else None,
                bus=m[:, T + 1 : T + 1 + 2 * W].reshape(-1, W, 2) if W else None,
            ))
        return result

    def _dispatch(self, state_in, mem, ports):
        dev = self.gpu.device
        n = state_in.shape[0]
        L = self.layout
        bufs = [
            G.uniform_buffer(dev, [n, self.steps, 0, 0]),
            G.storage_buffer(dev, state_in),
            G.storage_buffer(dev, n * L.state_words * 4, readback=True),
            G.storage_buffer(dev, mem, readback=True),
            G.storage_buffer(dev, ports, readback=True),
            G.storage_buffer(dev, n * STATUS_WORDS * 4, readback=True),
        ]
        if self._full is not None:
            bufs.append(self._full)
        dispatch_start = time.perf_counter()
        G.dispatch(dev, self.pipeline, self.bgl, bufs, n, clear=[self._full] if self._full is not None else [])
        self.dispatches += 1
        out = (
            G.read_u32(dev, bufs[2], n * L.state_words).reshape(n, L.state_words),
            G.read_u32(dev, bufs[3], n * L.mem_stride).reshape(n, L.mem_stride),
            G.read_u32(dev, bufs[4], n * L.port_stride).reshape(n, L.port_stride),
            G.read_u32(dev, bufs[5], n * STATUS_WORDS).reshape(n, STATUS_WORDS),
        )
        if os.environ.get("ZILION_GPU_DUTY") == "0.5":
            time.sleep(time.perf_counter() - dispatch_start)
        for b in bufs[:6]:
            b.destroy()
        return out
