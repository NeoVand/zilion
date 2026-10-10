// The lane runner: everything the engine does to a kernel, driven by its manifest (the same contract the Python
// host uses). Buffers live in slabs (one bind group each, at most one chunk of lanes) that are reused across runs;
// a read copies memory and records into one staging buffer and maps it once.

import type { ShaderManifest } from "../manifest.js";
import type { ChunkLimits } from "./chunks.js";

export interface SlabBuffers {
  readonly params: GPUBuffer;
  readonly memory: GPUBuffer;
  readonly record: GPUBuffer;
  readonly stateIn?: GPUBuffer;
  readonly budgetIn?: GPUBuffer;
}

export interface Slab {
  /** Global index of the slab's first lane within its batch. */
  readonly laneStart: number;
  /** Capacity in lanes. */
  readonly lanes: number;
  readonly buffers: SlabBuffers;
  readonly bindGroup: GPUBindGroup;
  /** Staging buffer for reads (grow-only, created on first read). */
  staging: GPUBuffer | null;
}

export interface DispatchParams {
  readonly laneCount: number;
  readonly laneBase: number;
  readonly budget: number;
  readonly seed: number;
  readonly ablation?: Uint32Array | null;
}

const words = (n: number) => Math.max(n, 1) * 4; // buffers are never empty
/** writeBuffer accepts any typed array (shared buffers included); TS 5.7+ types only ArrayBuffer-backed views. */
const src = (v: Uint32Array) => v as Uint32Array<ArrayBuffer>;

export function deviceLimits(device: GPUDevice): ChunkLimits {
  return {
    maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
    maxBufferSize: device.limits.maxBufferSize,
    maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
  };
}

/** Host layout (segments back to back) → storage layout (each segment word-padded). */
export function packMemory(m: ShaderManifest, host: Uint8Array, lanes: number): Uint32Array {
  const H = m.memory.hostBytesPerLane;
  const W = m.memory.storageWordsPerLane;
  const out = new Uint32Array(lanes * W);
  const bytes = new Uint8Array(out.buffer);
  const segs = m.memory.segments;
  if (segs.length === 1 && segs[0].bytes === W * 4 && segs[0].hostOffset === 0) {
    bytes.set(host.subarray(0, lanes * H));
    return out;
  }
  for (let i = 0; i < lanes; i++) {
    for (const s of segs) {
      bytes.set(host.subarray(i * H + s.hostOffset, i * H + s.hostOffset + s.bytes), (i * W + s.storageWord) * 4);
    }
  }
  return out;
}

/** Storage layout → host layout. */
export function unpackMemory(m: ShaderManifest, storage: Uint32Array, lanes: number): Uint8Array {
  const H = m.memory.hostBytesPerLane;
  const W = m.memory.storageWordsPerLane;
  const bytes = new Uint8Array(storage.buffer, storage.byteOffset, lanes * W * 4);
  const out = new Uint8Array(lanes * H);
  const segs = m.memory.segments;
  if (segs.length === 1 && segs[0].bytes === W * 4 && segs[0].hostOffset === 0) {
    out.set(bytes);
    return out;
  }
  for (let i = 0; i < lanes; i++) {
    for (const s of segs) {
      const from = (i * W + s.storageWord) * 4;
      out.set(bytes.subarray(from, from + s.bytes), i * H + s.hostOffset);
    }
  }
  return out;
}

export class LaneRunner {
  readonly memWords: number;
  readonly recWords: number;
  readonly stateWords: number;
  readonly hasState: boolean;
  readonly hasBudgets: boolean;
  private readonly paramsBytes: number;

  constructor(
    readonly device: GPUDevice,
    readonly pipeline: GPUComputePipeline,
    readonly layout: GPUBindGroupLayout,
    readonly manifest: ShaderManifest,
  ) {
    const by = (r: string) => manifest.bindings.find((b) => b.role === r);
    this.memWords = by("memory")?.wordsPerLane ?? 0;
    this.recWords = by("record")?.wordsPerLane ?? 0;
    this.stateWords = by("stateIn")?.wordsPerLane ?? 0;
    this.hasState = !!by("stateIn");
    this.hasBudgets = !!by("budgetIn");
    this.paramsBytes = Math.max(16, Math.ceil(manifest.params.bytes / 16) * 16);
  }

  /** Bytes per lane of every per-lane binding (for chunk planning). */
  bytesPerLane(): number[] {
    return this.manifest.bindings.filter((b) => b.wordsPerLane).map((b) => b.wordsPerLane! * 4);
  }

  createSlab(laneStart: number, lanes: number, label: string): Slab {
    const d = this.device;
    const U = GPUBufferUsage;
    const buffers: SlabBuffers = {
      params: d.createBuffer({ label: `${label}:params`, size: this.paramsBytes, usage: U.UNIFORM | U.COPY_DST }),
      memory: d.createBuffer({ label: `${label}:memory`, size: words(lanes * this.memWords), usage: U.STORAGE | U.COPY_SRC | U.COPY_DST }),
      record: d.createBuffer({ label: `${label}:record`, size: words(lanes * this.recWords), usage: U.STORAGE | U.COPY_SRC | U.COPY_DST }),
      ...(this.hasState ? { stateIn: d.createBuffer({ label: `${label}:stateIn`, size: words(lanes * this.stateWords), usage: U.STORAGE | U.COPY_DST }) } : {}),
      ...(this.hasBudgets ? { budgetIn: d.createBuffer({ label: `${label}:budgetIn`, size: words(lanes), usage: U.STORAGE | U.COPY_DST }) } : {}),
    };
    const byRole: Record<string, GPUBuffer | undefined> = {
      params: buffers.params, memory: buffers.memory, record: buffers.record, stateIn: buffers.stateIn, budgetIn: buffers.budgetIn,
    };
    const bindGroup = d.createBindGroup({
      label,
      layout: this.layout,
      entries: this.manifest.bindings.map((b) => ({ binding: b.binding, resource: { buffer: byRole[b.role]! } })),
    });
    return { laneStart, lanes, buffers, bindGroup, staging: null };
  }

  destroySlab(s: Slab): void {
    for (const b of Object.values(s.buffers)) b?.destroy();
    s.staging?.destroy();
    s.staging = null;
  }

  writeParams(s: Slab, p: DispatchParams): void {
    const out = new Uint32Array(this.paramsBytes / 4);
    for (const f of this.manifest.params.fields) {
      const o = f.offset / 4;
      switch (f.role) {
        case "laneCount": out[o] = p.laneCount; break;
        case "laneBase": out[o] = p.laneBase >>> 0; break;
        case "budget": out[o] = p.budget >>> 0; break;
        case "seed": out[o] = p.seed >>> 0; break;
        case "constant": out[o] = (f.value ?? 0) >>> 0; break;
        case "ablation":
          if (p.ablation) {
            if (p.ablation.length > f.words) throw new Error(`zilion: ablation table has ${p.ablation.length} words; the machine takes ${f.words}`);
            out.set(p.ablation, o);
          }
          break;
        default: break;
      }
    }
    this.device.queue.writeBuffer(s.buffers.params, 0, out);
  }

  /** Storage-layout words for `lanes` lanes starting at slab lane `at`. */
  writeMemory(s: Slab, storage: Uint32Array, at = 0): void {
    this.device.queue.writeBuffer(s.buffers.memory, at * this.memWords * 4, src(storage));
  }

  writeState(s: Slab, state: Uint32Array, at = 0): void {
    if (!s.buffers.stateIn) throw new Error("zilion: this machine takes no per-lane state (init.state is not 'perLane')");
    this.device.queue.writeBuffer(s.buffers.stateIn, at * this.stateWords * 4, src(state));
  }

  writeBudgets(s: Slab, budgets: Uint32Array, at = 0): void {
    if (!s.buffers.budgetIn) throw new Error("zilion: this machine takes no per-lane budgets (budget.value is not 'perLane')");
    this.device.queue.writeBuffer(s.buffers.budgetIn, at * 4, src(budgets));
  }

  /** Record the dispatch of `laneCount` lanes of the slab into an open compute pass. */
  dispatch(pass: GPUComputePassEncoder, s: Slab, laneCount: number): void {
    if (laneCount === 0) return;
    const per = this.manifest.workgroupSize * (this.manifest.lanesPerInvocation ?? 1);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, s.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(laneCount / per));
  }

  /** Copy the first `laneCount` lanes' memory and records out of the slab with one staging buffer and one map. */
  async read(s: Slab, laneCount: number, wantMemory: boolean): Promise<{ memory: Uint32Array | null; record: Uint32Array }> {
    const memBytes = wantMemory ? laneCount * this.memWords * 4 : 0;
    const recBytes = laneCount * this.recWords * 4;
    const total = words((memBytes + recBytes) / 4);
    if (!s.staging || s.staging.size < total) {
      s.staging?.destroy();
      s.staging = this.device.createBuffer({ label: "zilion:staging", size: Math.max(total, words(s.lanes * (this.memWords + this.recWords))), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    const enc = this.device.createCommandEncoder({ label: "zilion:read" });
    if (memBytes) enc.copyBufferToBuffer(s.buffers.memory, 0, s.staging, 0, memBytes);
    if (recBytes) enc.copyBufferToBuffer(s.buffers.record, 0, s.staging, memBytes, recBytes);
    this.device.queue.submit([enc.finish()]);
    await s.staging.mapAsync(GPUMapMode.READ, 0, total);
    const all = new Uint32Array(s.staging.getMappedRange(0, total).slice(0));
    s.staging.unmap();
    return {
      memory: memBytes ? all.subarray(0, memBytes / 4) : null,
      record: all.subarray(memBytes / 4, (memBytes + recBytes) / 4),
    };
  }
}
