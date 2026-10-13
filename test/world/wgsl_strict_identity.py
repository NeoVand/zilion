#!/usr/bin/env python3
"""Bitwise old/new proof, including all memory and every record word.

Uses the manifest-driven world host. All dispatches are bounded to 4096 lanes,
with an equal-duration pause (minimum 10 ms). Fail if any burst reaches 60 s.
"""
from __future__ import annotations
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import wgpu

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu_runner import Machine, adapter_summary, get_device


def pause(start):
    elapsed = time.perf_counter() - start
    if elapsed >= 60:
        raise RuntimeError(f'GPU burst exceeded limit: {elapsed:.3f} s')
    time.sleep(max(elapsed, 0.01))
    return elapsed


def precedence_probe():
    # Exhaustive op (8-bit) and FLAGS (16-bit) values. Alternative groupings
    # differ (e.g. op=140, flags=0), so agreement identifies the actual parse.
    expressions = [
        'op == 140u || op == 141u || op == 142u || op == 143u || op >= 196u && op <= 199u',
        'op == 140u || op == 141u || op == 142u || op == 143u || (op >= 196u && op <= 199u)',
        '(op == 140u || op == 141u || op == 142u || op == 143u || op >= 196u) && op <= 199u',
        'flags & 213u | 2u', '(flags & 213u) | 2u', 'flags & (213u | 2u)',
    ]
    # The logical alternative above is equal over op's domain; use a separate
    # discriminating truth table to independently establish && over ||.
    expressions += ['a || b && c', 'a || (b && c)', '(a || b) && c']
    body = '\n'.join(f'out[i * 9u + {k}u] = ' + (f'u32({e})' if k < 3 or k >= 6 else e) + ';' for k, e in enumerate(expressions))
    code = '''@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
let i = id.x; let op = i & 255u; let flags = i;
let a = (i & 1u) != 0u; let b = (i & 2u) != 0u; let c = (i & 4u) != 0u;
''' + body + '\n}'
    dev = get_device()
    module = dev.create_shader_module(code=code)
    pipeline = dev.create_compute_pipeline(layout='auto', compute={'module': module, 'entry_point': 'main'})
    buf = dev.create_buffer(size=65536 * 9 * 4, usage=wgpu.BufferUsage.STORAGE | wgpu.BufferUsage.COPY_SRC)
    bg = dev.create_bind_group(layout=pipeline.get_bind_group_layout(0), entries=[{'binding': 0, 'resource': {'buffer': buf}}])
    enc = dev.create_command_encoder()
    p = enc.begin_compute_pass(); p.set_pipeline(pipeline); p.set_bind_group(0, bg); p.dispatch_workgroups(1024); p.end()
    start = time.perf_counter(); dev.queue.submit([enc.finish()])
    out = np.frombuffer(dev.queue.read_buffer(buf), dtype=np.uint32).reshape(65536, 9).copy()
    burst = pause(start); buf.destroy()
    for a, b in [(0, 1), (3, 4), (6, 7)]:
        assert np.array_equal(out[:, a], out[:, b]), (a, b)
    assert np.any(out[:, 3] != out[:, 5]), 'bitwise alternative must differ'
    assert np.any(out[:, 6] != out[:, 8]), 'logical alternative must differ'
    return {'lanes': 65536, 'expressions': expressions, 'allEqualToNagaGrouping': True,
            'alternativeBitwiseDifferences': int(np.count_nonzero(out[:, 3] != out[:, 5])),
            'alternativeLogicalDifferences': int(np.count_nonzero(out[:, 6] != out[:, 8])), 'burstSeconds': burst}


def main(path):
    base = path.parent
    plan = json.loads(path.read_text())
    report = {k: plan[k] for k in ['reference', 'cores', 'matrix', 'coreTextHashChanges']}
    report.update(adapter=adapter_summary(), wgpu=wgpu.__version__, numpy=np.__version__, precedence=precedence_probe(), jobs=[])
    from wgpu.backends.wgpu_native import _ffi
    report['nagaNative'] = '.'.join(map(str, _ffi.lib_version_info))
    totals = {}
    max_burst = report['precedence']['burstSeconds']
    for job in plan['jobs']:
        pair = [Machine((base / job[k]['wgsl']).read_text(), json.loads((base / job[k]['manifest']).read_text())) for k in ['old', 'new']]
        rng = np.random.default_rng(job['seed'])
        digest = hashlib.sha256()
        record_fields = [f['name'] for f in pair[0].m['record']['fields']]
        assert all(f in record_fields for f in ['steps', 'haltReason', 'trapCause', 'state']), record_fields
        for start_lane in range(0, job['lanes'], 4096):
            n = min(4096, job['lanes'] - start_lane)
            mem = rng.integers(0, 256, (n, pair[0].host_bytes), dtype=np.uint8)
            # Cover every first opcode, in addition to uniformly random streams.
            mem[:, 0] = np.arange(start_lane, start_lane + n, dtype=np.uint32) & 255
            state = None
            if pair[0].role('stateIn'):
                state = rng.integers(0, 2**32, (n, pair[0].role('stateIn')['wordsPerLane']), dtype=np.uint32)
                for f in pair[0].m['state']:
                    if f['name'] in ['halted', 'trap'] or f['name'].startswith('rep'):
                        state[:, f['offset']] = 0
                    elif job['core'].startswith('bff@'):
                        # BFF's instruction pointer is a tape position. An
                        # arbitrary 32-bit IP could scan billions of positions
                        # backwards on ']', which defeats the burst limit.
                        state[:, f['offset']] %= pair[0].m['memory']['ringBytes']
            budgets = rng.integers(1, 129, n, dtype=np.uint32) if pair[0].role('budgetIn') else None
            # Uniform ablation mask skips a representative set of decode keys.
            ablation = [0x08040201] * 512 if job['world'] == 'ablation' else None
            result = []
            for m in pair:
                started = time.perf_counter()
                result.append(m.run(mem, state=state, budgets=budgets, ablation=ablation,
                                    lane_base=start_lane, seed=job['seed'], step_base=2**32 - 64))
                max_burst = max(max_burst, pause(started))
            for name, old, new in zip(['memory', 'record'], result[0], result[1]):
                if not np.array_equal(old, new):
                    where = np.argwhere(old != new)[0].tolist()
                    raise AssertionError(f"{job['core']}/{job['world']}/{name}: first difference at {where}, base={start_lane}")
                digest.update(old.tobytes())
        totals[job['core']] = totals.get(job['core'], 0) + job['lanes']
        outcome = {'core': job['core'], 'world': job['world'], 'lanes': job['lanes'],
                   'sha256': digest.hexdigest(), 'recordFields': record_fields, 'equal': True}
        report['jobs'].append(outcome)
        print(f"PASS {job['core']}/{job['world']}: {job['lanes']:,} lanes", flush=True)
        time.sleep(0.1)
    report.update(totals=totals, lanes=sum(totals.values()), maxBurstSeconds=max_burst, equal=True)
    (base / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f"PASS {report['lanes']:,} paired lanes; max GPU burst {max_burst:.3f} s on {report['adapter']}", flush=True)


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve())
