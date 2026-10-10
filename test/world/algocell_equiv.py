#!/usr/bin/env python3
"""Python half of test/world/algocell.mjs: run Algocell's exported executors and Zilion machines on the same random
pairs and compare outputs. Algocell's traced/op-traced executors are derived with Algocell's own code
(algocell_exp.gen_trace_shader.derive and algocell_exp.optrace.HUNKS), so nothing of Algocell is re-typed here.

Algocell executor layout (src/lib/gpu/shaders.ts createZ80TestShader, experiments/z80_ring_gpu.py): Params of
32 u32 [.., tape_length@2, pair_length@3, pair_count@4, .., z80_steps@6, batch_seed@7, suppress@8..31];
binding 1 = pair_data (A then B, each word-padded), binding 2 = regs: a f b c d e h l sp pc writes_a writes_b
(+ 8 words exec_mask for the traced executor, + 8 words op_mask for the op-traced one).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import wgpu

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_runner import Machine, adapter_summary, get_device  # noqa: E402

REGS = ["a", "f", "b", "c", "d", "e", "h", "l", "sp", "pc"]


def algocell_source(algocell: Path, case: dict) -> tuple[str, int]:
    shader_dir = algocell / "experiments/algocell_exp/shader"
    src = shader_dir / case["source"]
    if case["derive"] is None:
        return src.read_text(), 12
    sys.path.insert(0, str(algocell / "experiments"))
    from algocell_exp import gen_trace_shader  # noqa: E402
    text = gen_trace_shader.derive(src)
    if case["derive"] == "trace":
        return text, 20
    from algocell_exp import optrace  # noqa: E402
    for old, new in optrace.HUNKS:
        assert text.count(old) == 1, f"optrace anchor not unique: {old[:40]!r}"
        text = text.replace(old, new)
    return text, 28


def run_algocell(code: str, regs_words: int, pairs: np.ndarray, L: int, steps: int, seed: int, masks) -> tuple[np.ndarray, np.ndarray]:
    dev = get_device()
    module = dev.create_shader_module(code=code)
    storage = {"type": wgpu.BufferBindingType.storage}
    layout = dev.create_bind_group_layout(entries=[
        {"binding": 0, "visibility": wgpu.ShaderStage.COMPUTE, "buffer": {"type": wgpu.BufferBindingType.uniform}},
        {"binding": 1, "visibility": wgpu.ShaderStage.COMPUTE, "buffer": storage},
        {"binding": 2, "visibility": wgpu.ShaderStage.COMPUTE, "buffer": storage}])
    pipe = dev.create_compute_pipeline(layout=dev.create_pipeline_layout(bind_group_layouts=[layout]),
                                       compute={"module": module, "entry_point": "z80_test"})
    n = pairs.shape[0]
    wpc = (L + 3) // 4
    words = np.zeros((n, 2 * wpc * 4), dtype=np.uint8)
    words[:, :L] = pairs[:, :L]
    words[:, 4 * wpc: 4 * wpc + L] = pairs[:, L:]
    params = np.zeros(32, dtype=np.uint32)
    params[2], params[3], params[4], params[6], params[7] = L, 2 * L, n, steps, seed
    if masks is not None:
        params[8:] = masks
    B = wgpu.BufferUsage
    io = dev.create_buffer(size=words.nbytes, usage=B.STORAGE | B.COPY_SRC | B.COPY_DST)
    dev.queue.write_buffer(io, 0, np.ascontiguousarray(words).tobytes())
    regs = dev.create_buffer(size=n * regs_words * 4, usage=B.STORAGE | B.COPY_SRC)
    pb = dev.create_buffer(size=128, usage=B.UNIFORM | B.COPY_DST)
    dev.queue.write_buffer(pb, 0, params.tobytes())
    bg = dev.create_bind_group(layout=layout, entries=[
        {"binding": i, "resource": {"buffer": b, "offset": 0, "size": b.size}} for i, b in enumerate((pb, io, regs))])
    enc = dev.create_command_encoder()
    p = enc.begin_compute_pass()
    p.set_pipeline(pipe)
    p.set_bind_group(0, bg)
    p.dispatch_workgroups(-(-n // 64))
    p.end()
    dev.queue.submit([enc.finish()])
    out = np.frombuffer(dev.queue.read_buffer(io), dtype=np.uint8).reshape(n, 2 * wpc * 4)
    r = np.frombuffer(dev.queue.read_buffer(regs), dtype=np.uint32).reshape(n, regs_words).copy()
    mem = np.concatenate([out[:, :L], out[:, 4 * wpc: 4 * wpc + L]], axis=1)
    for b in (io, regs, pb):
        b.destroy()
    return mem, r


def bits(words: np.ndarray, P: int) -> np.ndarray:
    return np.unpackbits(np.ascontiguousarray(words).view(np.uint8), axis=1, bitorder="little")[:, :P].astype(bool)


def main(plan_path: str) -> int:
    plan = json.load(open(plan_path))
    algocell = Path(plan["algocell"])
    failed = 0
    for case in plan["cases"]:
        L, n = case["L"], case["n"]
        rng = np.random.default_rng(case["seed"])
        pairs = rng.integers(0, 256, size=(n, 2 * L), dtype=np.uint8)
        masks = None
        if case["masks"] == "random":
            # about 1 opcode in 6 ablated on each page (base, CB, ED), varying per case seed
            m = rng.random((24, 32)) < (1 / 6)
            masks = np.packbits(m, axis=1, bitorder="little").view(np.uint32).reshape(24)
        code, rw = algocell_source(algocell, case)
        a_mem, a_regs = run_algocell(code, rw, pairs, L, case["steps"], case["seed"], masks)
        manifest = json.load(open(case["manifest"]))
        mach = Machine(open(case["wgsl"]).read(), manifest)
        z_mem, z_rec = mach.run(pairs, seed=case["seed"], budget=case["steps"], ablation=masks)
        P = manifest["memory"]["ringBytes"]
        field = {f["name"]: f for f in manifest["record"]["fields"]}
        st = field["state"]
        names = st["items"]
        errs = []
        if not np.array_equal(a_mem, z_mem):
            errs.append(f"memory differs in {int(np.any(a_mem != z_mem, axis=1).sum())} of {n} pairs")
        for k, r in enumerate(REGS):
            z = z_rec[:, st["offset"] + names.index(r)]
            if not np.array_equal(a_regs[:, k], z):
                errs.append(f"{r} differs in {int((a_regs[:, k] != z).sum())} pairs")
        wc = field["writeCounts"]
        w = z_rec[:, wc["offset"]: wc["offset"] + wc["words"]]
        wb = w[:, 1] + (w[:, 2] if wc["words"] > 2 else 0)  # Algocell counts padding writes as B's
        if not np.array_equal(a_regs[:, 10], w[:, 0]):
            errs.append(f"writes into A differ in {int((a_regs[:, 10] != w[:, 0]).sum())} pairs")
        if not np.array_equal(a_regs[:, 11], wb):
            errs.append(f"writes into B (+ padding) differ in {int((a_regs[:, 11] != wb).sum())} pairs")
        maps = []
        if rw >= 20:
            f = field["fetchMap"]
            same = np.array_equal(bits(a_regs[:, 12:20], P), bits(z_rec[:, f["offset"]: f["offset"] + f["words"]], P))
            maps.append("fetch map")
            if not same:
                errs.append("fetch map differs")
        if rw >= 28:
            f = field["startMap"]
            same = np.array_equal(bits(a_regs[:, 20:28], P), bits(z_rec[:, f["offset"]: f["offset"] + f["words"]], P))
            maps.append("start map")
            if not same:
                errs.append("start map differs")
        steps = z_rec[:, field["steps"]["offset"]]
        halted = z_rec[:, field["haltReason"]["offset"]]
        info = f"{n} pairs, mean steps {steps.mean():.1f}, halted {np.mean(halted != 0):.3f}" + (f"; {', '.join(maps)}" if maps else "")
        if errs:
            failed += 1
            print(f"  FAIL  {case['name']}  [{info}]")
            for e in errs:
                print(f"          {e}")
        else:
            print(f"  ok    {case['name']}  [{info}]")
    print(f"{len(plan['cases']) - failed} passed, {failed} failed on {adapter_summary()}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
