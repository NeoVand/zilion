// L2: the batch engine. Compiled machines, resident batches, chunking against device limits, typed results.

import type { ShaderManifest } from "../manifest.js";
import { buildMachine, type BuiltMachine } from "../world/build.js";
import type { MachineSpec } from "../world/spec.js";
import { maxLanesPerChunk, planChunks } from "./chunks.js";
import { createKernel } from "./gpu.js";
import { Lock } from "./lock.js";
import { decodeResult, type MachineResult } from "./result.js";
import { deviceLimits, LaneRunner, packMemory, unpackMemory, type Slab } from "./runner.js";

export interface EngineOptions {
  /** Use this device (the engine will not destroy it). */
  readonly device?: GPUDevice;
  /** A GPU object, e.g. `create([])` from Node's `webgpu` package. Default: navigator.gpu. */
  readonly gpu?: GPU;
  readonly adapter?: GPURequestAdapterOptions;
  /**
   * Limits to request. By default the engine asks for the adapter's maxStorageBufferBindingSize and maxBufferSize,
   * so chunks can be as large as the hardware allows.
   */
  readonly requiredLimits?: Record<string, number>;
}

export async function createEngine(o: EngineOptions = {}): Promise<Engine> {
  if (o.device) return new Engine(o.device, false, undefined);
  const gpu = o.gpu ?? (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
  if (!gpu) throw new Error("zilion: WebGPU is not available (pass { gpu } in Node, e.g. from the 'webgpu' package)");
  const adapter = await gpu.requestAdapter(o.adapter);
  if (!adapter) throw new Error("zilion: no WebGPU adapter available");
  const requiredLimits = {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    ...(o.requiredLimits ?? {}),
  };
  const device = await adapter.requestDevice({ requiredLimits });
  return new Engine(device, true, (adapter as { info?: GPUAdapterInfo }).info);
}

export class Engine {
  constructor(
    readonly device: GPUDevice,
    private readonly ownsDevice: boolean,
    /** Recorded in provenance (vendor, architecture, …) when the engine created the device. */
    readonly adapterInfo: GPUAdapterInfo | undefined,
  ) {}

  /** Build (if given a spec) and compile a machine. Compile errors are thrown with the offending source lines. */
  async machine(spec: MachineSpec | BuiltMachine, o: { label?: string } = {}): Promise<Machine> {
    const built = "wgsl" in spec ? spec : buildMachine(spec);
    const label = o.label ?? `zilion:${built.manifest.core.id}`;
    const { pipeline, layout } = await createKernel(this.device, built.wgsl, built.manifest, label);
    return new Machine(this.device, built, new LaneRunner(this.device, pipeline, layout, built.manifest), label);
  }

  destroy(): void {
    if (this.ownsDevice) this.device.destroy();
  }
}

export interface MachineRunOptions {
  /** Run seed (random initial state, dials). Default 0. */
  readonly seed?: number;
  /** Steps (or fetched bytes) per lane: a number, or one per lane when the world's budget is 'perLane'. */
  readonly budget?: number | Uint32Array;
  /** Ablation bitset for `ablation: { table: 'uniform' }` worlds (manifest.ablation.words u32). */
  readonly ablation?: Uint32Array;
  /** Initial state records, lanes × state fields, for `init.state: 'perLane'` worlds. */
  readonly state?: Uint32Array;
  /** Global index of the first lane (hashes see laneBase + i). Default 0. */
  readonly laneBase?: number;
  /** Cap on lanes per dispatch (default: as many as the device limits allow). */
  readonly maxLanesPerChunk?: number;
}

/** Lane memories as one host-layout byte array (lanes × hostBytesPerLane) or one array per lane (padded/truncated). */
export type LaneInput = Uint8Array | readonly ArrayLike<number>[];

function hostBytes(manifest: ShaderManifest, input: LaneInput): { bytes: Uint8Array; lanes: number } {
  const H = manifest.memory.hostBytesPerLane;
  if (input instanceof Uint8Array) {
    if (input.length % H !== 0) throw new Error(`zilion: input is ${input.length} bytes, not a whole number of ${H}-byte lanes`);
    return { bytes: input, lanes: input.length / H };
  }
  const bytes = new Uint8Array(input.length * H);
  input.forEach((p, i) => {
    const n = Math.min(p.length, H);
    for (let k = 0; k < n; k++) bytes[i * H + k] = p[k] & 0xff;
  });
  return { bytes, lanes: input.length };
}

interface Resolved {
  budget: number;
  budgets: Uint32Array | null;
  seed: number;
  ablation: Uint32Array | null;
  state: Uint32Array | null;
}

function resolveOptions(runner: LaneRunner, lanes: number, o: MachineRunOptions): Resolved {
  const m = runner.manifest;
  let budget = 0;
  let budgets: Uint32Array | null = null;
  if (m.budget.perLane) {
    if (typeof o.budget === "number") budgets = new Uint32Array(lanes).fill(o.budget);
    else if (o.budget instanceof Uint32Array && o.budget.length >= lanes) budgets = o.budget;
    else throw new Error(`zilion: this machine needs a per-lane budget (Uint32Array of ${lanes})`);
  } else {
    const b = typeof o.budget === "number" ? o.budget : m.budget.default;
    if (b === null || b === undefined) throw new Error("zilion: no budget (pass { budget } or set world.budget.value)");
    if (o.budget instanceof Uint32Array) throw new Error("zilion: per-lane budgets need world.budget.value = 'perLane'");
    budget = b;
  }
  if (runner.hasState) {
    if (!o.state || o.state.length < lanes * runner.stateWords) throw new Error(`zilion: this machine needs { state } with ${lanes} x ${runner.stateWords} words`);
  } else if (o.state) throw new Error("zilion: { state } needs init.state = 'perLane'");
  if (o.ablation && m.ablation.kind !== "uniform") throw new Error("zilion: { ablation } needs ablation: { table: 'uniform' }");
  return { budget, budgets, seed: o.seed ?? 0, ablation: o.ablation ?? null, state: runner.hasState ? o.state! : null };
}

export class Machine {
  readonly manifest: ShaderManifest;
  readonly wgsl: string;
  private slab: Slab | null = null;
  private destroyed = false;
  private readonly lock = new Lock();

  constructor(
    readonly device: GPUDevice,
    built: BuiltMachine,
    private readonly runner: LaneRunner,
    private readonly label: string,
  ) {
    this.manifest = built.manifest;
    this.wgsl = built.wgsl;
  }

  /** Lanes one dispatch can cover on this device. */
  lanesPerChunk(cap?: number): number {
    return maxLanesPerChunk({
      workgroupSize: this.manifest.workgroupSize,
      lanesPerInvocation: this.manifest.lanesPerInvocation,
      bytesPerLane: this.runner.bytesPerLane(),
      limits: deviceLimits(this.device),
      maxLanes: cap,
    });
  }

  /**
   * Upload, run and read back any number of lanes (processed in chunks; buffers are reused between calls, and
   * concurrent calls on one machine run one after the other).
   */
  run(input: LaneInput, o: MachineRunOptions = {}): Promise<MachineResult> {
    return this.lock.run(() => this.runNow(input, o));
  }

  private async runNow(input: LaneInput, o: MachineRunOptions): Promise<MachineResult> {
    if (this.destroyed) throw new Error("zilion: machine destroyed");
    const m = this.manifest;
    const { bytes, lanes } = hostBytes(m, input);
    const r = resolveOptions(this.runner, lanes, o);
    const H = m.memory.hostBytesPerLane;
    const R = m.record.wordsPerLane;
    const memory = m.memory.stored ? new Uint8Array(lanes * H) : null;
    const record = new Uint32Array(lanes * R);
    if (lanes === 0) return decodeResult(m, 0, memory, record);
    const per = this.lanesPerChunk(o.maxLanesPerChunk);
    const cap = Math.min(lanes, per);
    if (!this.slab || this.slab.lanes < cap) {
      if (this.slab) this.runner.destroySlab(this.slab);
      this.slab = this.runner.createSlab(0, cap, this.label);
    }
    const slab = this.slab;
    for (const { start, count } of planChunks(lanes, per)) {
      this.runner.writeMemory(slab, packMemory(m, bytes.subarray(start * H, (start + count) * H), count));
      if (r.state) this.runner.writeState(slab, r.state.subarray(start * this.runner.stateWords, (start + count) * this.runner.stateWords));
      if (r.budgets) this.runner.writeBudgets(slab, r.budgets.subarray(start, start + count));
      this.runner.writeParams(slab, { laneCount: count, laneBase: (o.laneBase ?? 0) + start, budget: r.budget, seed: r.seed, ablation: r.ablation });
      const enc = this.device.createCommandEncoder({ label: this.label });
      const pass = enc.beginComputePass({ label: this.label });
      this.runner.dispatch(pass, slab, count);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      const out = await this.runner.read(slab, count, !!memory);
      if (memory && out.memory) memory.set(unpackMemory(m, out.memory, count), start * H);
      record.set(out.record, start * R);
    }
    return decodeResult(m, lanes, memory, record);
  }

  /** A resident batch of `capacity` lanes (several slabs when it exceeds one chunk). */
  batch(capacity: number, o: { maxLanesPerSlab?: number } = {}): Batch {
    if (this.destroyed) throw new Error("zilion: machine destroyed");
    return new Batch(this.device, this.runner, capacity, this.lanesPerChunk(o.maxLanesPerSlab), this.label);
  }

  destroy(): void {
    if (this.slab) this.runner.destroySlab(this.slab);
    this.slab = null;
    this.destroyed = true;
  }
}

/**
 * Lanes resident on the GPU: upload once, encode into your own command encoders (e.g. between soup kernels),
 * read when needed. Params are written with queue.writeBuffer at encode time, so submit an encode before the
 * next encode with different options.
 */
export class Batch {
  readonly slabs: readonly Slab[];
  private readonly lock = new Lock();

  constructor(
    readonly device: GPUDevice,
    private readonly runner: LaneRunner,
    readonly capacity: number,
    perSlab: number,
    label: string,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`zilion: batch capacity must be a positive integer (got ${capacity})`);
    this.slabs = planChunks(capacity, perSlab).map((c, i) => runner.createSlab(c.start, c.count, `${label}:slab${i}`));
  }

  get manifest(): ShaderManifest {
    return this.runner.manifest;
  }

  private each(lane: number, lanes: number, fn: (s: Slab, at: number, from: number, n: number) => void): void {
    if (lane < 0 || lane + lanes > this.capacity) throw new Error(`zilion: lanes ${lane}..${lane + lanes} exceed the batch capacity ${this.capacity}`);
    for (const s of this.slabs) {
      const a = Math.max(lane, s.laneStart);
      const b = Math.min(lane + lanes, s.laneStart + s.lanes);
      if (a < b) fn(s, a - s.laneStart, a - lane, b - a);
    }
  }

  /** Upload lane memories (host layout) starting at batch lane `lane`. */
  upload(input: LaneInput, o: { lane?: number } = {}): void {
    const m = this.manifest;
    const { bytes, lanes } = hostBytes(m, input);
    const H = m.memory.hostBytesPerLane;
    this.each(o.lane ?? 0, lanes, (s, at, from, n) => this.runner.writeMemory(s, packMemory(m, bytes.subarray(from * H, (from + n) * H), n), at));
  }

  uploadState(state: Uint32Array, o: { lane?: number } = {}): void {
    const S = this.runner.stateWords;
    this.each(o.lane ?? 0, state.length / S, (s, at, from, n) => this.runner.writeState(s, state.subarray(from * S, (from + n) * S), at));
  }

  uploadBudgets(budgets: Uint32Array, o: { lane?: number } = {}): void {
    this.each(o.lane ?? 0, budgets.length, (s, at, from, n) => this.runner.writeBudgets(s, budgets.subarray(from, from + n), at));
  }

  /** Record a run of the first `lanes` lanes (default: all) into `enc`. */
  encode(enc: GPUCommandEncoder, o: { seed?: number; budget?: number; ablation?: Uint32Array; lanes?: number; laneBase?: number } = {}): void {
    const lanes = o.lanes ?? this.capacity;
    const m = this.manifest;
    const budget = o.budget ?? m.budget.default ?? (m.budget.perLane ? 0 : null);
    if (budget === null) throw new Error("zilion: no budget (pass { budget } or set world.budget.value)");
    if (o.ablation && m.ablation.kind !== "uniform") throw new Error("zilion: { ablation } needs ablation: { table: 'uniform' }");
    const pass = enc.beginComputePass({ label: "zilion:batch" });
    this.each(0, lanes, (s, _at, _from, n) => {
      this.runner.writeParams(s, { laneCount: n, laneBase: (o.laneBase ?? 0) + s.laneStart, budget, seed: o.seed ?? 0, ablation: o.ablation ?? null });
      this.runner.dispatch(pass, s, n);
    });
    pass.end();
  }

  /** Read the first `lanes` lanes (default: all). Concurrent reads of one batch run one after the other. */
  read(o: { lanes?: number } = {}): Promise<MachineResult> {
    return this.lock.run(() => this.readNow(o));
  }

  private async readNow(o: { lanes?: number }): Promise<MachineResult> {
    const m = this.manifest;
    const lanes = o.lanes ?? this.capacity;
    const H = m.memory.hostBytesPerLane;
    const R = m.record.wordsPerLane;
    const memory = m.memory.stored ? new Uint8Array(lanes * H) : null;
    const record = new Uint32Array(lanes * R);
    const reads: Promise<void>[] = [];
    this.each(0, lanes, (s, _at, from, n) => {
      reads.push(this.runner.read(s, n, !!memory).then((out) => {
        if (memory && out.memory) memory.set(unpackMemory(m, out.memory, n), from * H);
        record.set(out.record, from * R);
      }));
    });
    await Promise.all(reads);
    return decodeResult(m, lanes, memory, record);
  }

  /** encode + submit + read. */
  async run(o: { seed?: number; budget?: number; ablation?: Uint32Array; lanes?: number; laneBase?: number } = {}): Promise<MachineResult> {
    const enc = this.device.createCommandEncoder({ label: "zilion:batch" });
    this.encode(enc, o);
    this.device.queue.submit([enc.finish()]);
    return this.read({ lanes: o.lanes });
  }

  destroy(): void {
    for (const s of this.slabs) this.runner.destroySlab(s);
  }
}
