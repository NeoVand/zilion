"""wgpu-py device selection, shader compilation and dispatch helpers.

Adapter policy (docs/TESTING.md, "Adapters"):
  * a real GPU is preferred (discrete, then integrated, then virtual), Metal/Vulkan before D3D12 before GL;
  * a CPU adapter (lavapipe, llvmpipe, SwiftShader, WARP) is used only when ZILION_ALLOW_CPU_ADAPTER=1.
    The cores are integer-only, so a CPU adapter must agree bit for bit with a GPU; it is how Linux CI runs;
  * ZILION_ADAPTER=<substring> restricts the choice to adapters whose device name or backend contains it.

The device is requested with the WebGPU default limits, so anything that runs here also runs on lavapipe.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import wgpu

WORKGROUP_SIZE = 64
MAX_WORKGROUPS = 65535  # WebGPU default maxComputeWorkgroupsPerDimension
MAX_LANES_PER_DISPATCH = WORKGROUP_SIZE * MAX_WORKGROUPS

_TYPE_RANK = {"DiscreteGPU": 0, "IntegratedGPU": 1, "VirtualGPU": 2, "CPU": 3, "Unknown": 4}
_BACKEND_RANK = {"Metal": 0, "Vulkan": 0, "D3D12": 1, "OpenGL": 2}


class HarnessError(RuntimeError):
    """A harness failure (no adapter, WGSL that does not compile, capacity exceeded), not a test result."""


@dataclass(frozen=True)
class Gpu:
    device: wgpu.GPUDevice
    adapter_info: dict

    def summary(self) -> str:
        i = self.adapter_info
        return f"{i.get('device', '?')} ({i.get('backend_type', '?')}, {i.get('adapter_type', '?')})"


_GPU: Gpu | None = None


def get_gpu() -> Gpu:
    """The process-wide device, chosen by the adapter policy above."""
    global _GPU
    if _GPU is None:
        adapters = list(wgpu.gpu.enumerate_adapters_sync())
        want = os.environ.get("ZILION_ADAPTER", "").strip().lower()
        if want:
            adapters = [
                a for a in adapters
                if want in str(a.info.get("device", "")).lower() or want in str(a.info.get("backend_type", "")).lower()
            ]
        allow_cpu = os.environ.get("ZILION_ALLOW_CPU_ADAPTER") == "1"
        if not allow_cpu:
            adapters = [a for a in adapters if str(a.info.get("adapter_type")) not in ("CPU", "Unknown")]
        adapters.sort(
            key=lambda a: (
                _TYPE_RANK.get(str(a.info.get("adapter_type")), 5),
                _BACKEND_RANK.get(str(a.info.get("backend_type")), 3),
            )
        )
        if not adapters:
            raise HarnessError(
                "no usable WebGPU adapter"
                + (f" matching ZILION_ADAPTER={want!r}" if want else "")
                + ("" if allow_cpu else " (CPU adapters need ZILION_ALLOW_CPU_ADAPTER=1)")
            )
        adapter = adapters[0]
        _GPU = Gpu(device=adapter.request_device_sync(), adapter_info=dict(adapter.info))
    return _GPU


def compile_pipeline(
    device: wgpu.GPUDevice,
    code: str,
    bindings: list[str],
    *,
    entry_point: str = "main",
    label: str = "zilion-test",
) -> tuple[wgpu.GPUComputePipeline, wgpu.GPUBindGroupLayout]:
    """Compile `code` with an explicit bind-group layout.

    `bindings[i]` is the type of @binding(i) in group 0: "uniform", "storage" (read_write) or "read-only-storage".
    An explicit layout (not layout="auto") keeps bindings that the shader declares but a given core never reaches,
    such as the port tables under a core without I/O hooks. Compilation errors are raised as HarnessError with the
    compiler's message.
    """
    kinds = {
        "uniform": wgpu.BufferBindingType.uniform,
        "storage": wgpu.BufferBindingType.storage,
        "read-only-storage": wgpu.BufferBindingType.read_only_storage,
    }
    try:
        module = device.create_shader_module(label=label, code=code)
        layout = device.create_bind_group_layout(
            entries=[
                {"binding": i, "visibility": wgpu.ShaderStage.COMPUTE, "buffer": {"type": kinds[k]}}
                for i, k in enumerate(bindings)
            ]
        )
        pipeline = device.create_compute_pipeline(
            label=label,
            layout=device.create_pipeline_layout(bind_group_layouts=[layout]),
            compute={"module": module, "entry_point": entry_point},
        )
    except Exception as e:  # wgpu raises GPUValidationError carrying the WGSL compiler's diagnostics
        raise HarnessError(f"WGSL for {label!r} failed to compile:\n{e}") from None
    return pipeline, layout


def storage_buffer(device: wgpu.GPUDevice, data: np.ndarray | int, *, readback: bool = False) -> wgpu.GPUBuffer:
    """A storage buffer initialised from `data` (u32 array) or zero-filled with `data` bytes."""
    usage = wgpu.BufferUsage.STORAGE | wgpu.BufferUsage.COPY_DST
    if readback:
        usage |= wgpu.BufferUsage.COPY_SRC
    if isinstance(data, int):
        return device.create_buffer(size=max(4, (data + 3) // 4 * 4), usage=usage)
    arr = np.ascontiguousarray(data, dtype=np.uint32)
    if arr.nbytes == 0:
        arr = np.zeros(1, dtype=np.uint32)
    return device.create_buffer_with_data(data=arr, usage=usage)


def uniform_buffer(device: wgpu.GPUDevice, words: list[int]) -> wgpu.GPUBuffer:
    arr = np.zeros(max(4, (len(words) + 3) // 4 * 4), dtype=np.uint32)
    arr[: len(words)] = words
    return device.create_buffer_with_data(data=arr, usage=wgpu.BufferUsage.UNIFORM | wgpu.BufferUsage.COPY_DST)


def dispatch(
    device: wgpu.GPUDevice,
    pipeline: wgpu.GPUComputePipeline,
    layout: wgpu.GPUBindGroupLayout,
    buffers: list[wgpu.GPUBuffer],
    lanes: int,
    *,
    clear: list[wgpu.GPUBuffer] = (),
) -> None:
    """One compute pass over `lanes` invocations (workgroup size 64), with buffers bound at 0..n-1.

    Buffers in `clear` are zeroed in the same command buffer before the pass.
    """
    if lanes <= 0:
        return
    if lanes > MAX_LANES_PER_DISPATCH:
        raise HarnessError(f"{lanes} lanes exceed one dispatch ({MAX_LANES_PER_DISPATCH}); chunk the batch")
    bind_group = device.create_bind_group(
        layout=layout,
        entries=[{"binding": i, "resource": {"buffer": b, "offset": 0, "size": b.size}} for i, b in enumerate(buffers)],
    )
    enc = device.create_command_encoder()
    for b in clear:
        enc.clear_buffer(b)
    p = enc.begin_compute_pass()
    p.set_pipeline(pipeline)
    p.set_bind_group(0, bind_group)
    p.dispatch_workgroups(-(-lanes // WORKGROUP_SIZE))
    p.end()
    device.queue.submit([enc.finish()])


def read_u32(device: wgpu.GPUDevice, buf: wgpu.GPUBuffer, count: int | None = None) -> np.ndarray:
    out = np.frombuffer(device.queue.read_buffer(buf), dtype=np.uint32)
    return (out if count is None else out[:count]).copy()
