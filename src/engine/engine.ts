// L2: the batch engine. Compiled machines, resident batches, chunking against device limits, typed results.

import type { ShaderManifest } from "../manifest.js";
import { buildMachine, type BuiltMachine } from "../world/build.js";
import type { MachineSpec } from "../world/spec.js";
import { maxLanesPerChunk, planChunks } from "./chunks.js";
import { createKernel } from "./gpu.js";
import { Lock } from "./lock.js";
import { decodeResult, type MachineResult } from "./result.js";
import { deviceLimits, LaneRunner, packMemory, stepBaseWords, unpackMemory, type Slab } from "./runner.js";

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
    if (built.manifest.mode === "legacy-0.2") {
      throw new Error("zilion: the 0.2 kernel (legacyMachine) has no typed results; run it through Zilion, or build a world");
    }
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
  /**
   * The dial index of every lane's first step in this run (a 64-bit integer; default 0). To split a run into
   * dispatches, pass the steps already run: with a `steps` budget every lane still running has run exactly that many.
   */
  readonly stepBase?: number | bigint;
  /**
   * Continue lanes instead of beginning them: their previous records (lanes × manifest.record.wordsPerLane, e.g.
   * the `record` of the previous result), with their previous memory as the input. Needs `manifest.resumable`.
   * The state, steps, write counts, maps and padding carry over; the raw on_reset hook does not run again.
   */
  readonly resume?: Uint32Array;
  /** Cap on lanes per dispatch (default: as many as the device limits allow). */
  readonly maxLanesPerChunk?: number;
}

/** Options of `Batch.encode` and `Batch.run`. */
export interface BatchRunOptions {
  readonly seed?: number;
  readonly budget?: number;
  readonly ablation?: Uint32Array;
  readonly lanes?: number;
  readonly laneBase?: number;
  /** The dial index of every lane's first step in this run (64-bit; default 0). */
  readonly stepBase?: number | bigint;
  /** Continue the lanes from the records and memory resident in the batch (needs manifest.resumable). */
  readonly resume?: boolean;
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
  if (o.resume !== undefined) {
    if (!m.resumable) throw new Error("zilion: this machine cannot resume lanes (manifest.resumable is false: it needs a steps budget and outputs.state and outputs.memory)");
    if (!(o.resume instanceof Uint32Array) || o.resume.length !== lanes * m.record.wordsPerLane) {
      throw new Error(`zilion: { resume } must be the previous records, a Uint32Array of ${lanes} x ${m.record.wordsPerLane} words`);
    }
  }
  stepBaseWords(o.stepBase); // validates
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
  if (runner.hasState && o.resume === undefined) {
    if (!o.state || o.state.length < lanes * runner.stateWords) throw new Error(`zilion: this machine needs { state } with ${lanes} x ${runner.stateWords} words`);
  } else if (o.state && !runner.hasState) throw new Error("zilion: { state } needs init.state = 'perLane'");
  else if (o.state && o.resume !== undefined) throw new Error("zilion: a resumed run continues from its records; pass { resume } or { state }, not both");
  if (o.ablation && m.ablation.kind !== "uniform") throw new Error("zilion: { ablation } needs ablation: { table: 'uniform' }");
  return { budget, budgets, seed: o.seed ?? 0, ablation: o.ablation ?? null, state: runner.hasState && o.state ? o.state : null };
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
      stagingBytesPerLane: this.runner.stagingBytesPerLane(),
      limits: deviceLimits(this.device),
      maxLanes: cap,
    });
  }

  /**
   * Upload, run and read back any number of lanes (processed in chunks; buffers are reused between calls, and
   * concurrent calls on one machine run one after the other). A run called before destroy() completes.
   */
  run(input: LaneInput, o: MachineRunOptions = {}): Promise<MachineResult> {
    if (this.destroyed) return Promise.reject(new Error("zilion: machine destroyed"));
    return this.lock.run(() => this.runNow(input, o));
  }

  private async runNow(input: LaneInput, o: MachineRunOptions): Promise<MachineResult> {
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
      if (o.resume) this.runner.writeRecord(slab, o.resume.subarray(start * R, (start + count) * R));
      this.runner.writeParams(slab, {
        laneCount: count, laneBase: (o.laneBase ?? 0) + start, budget: r.budget, seed: r.seed, ablation: r.ablation,
        stepBase: o.stepBase, resume: o.resume !== undefined,
      });
      const enc = this.device.createCommandEncoder({ label: this.label });
      const pass = enc.beginComputePass({ label: this.label });
      this.runner.dispatch(pass, slab, count);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      const out = await this.runner.snapshot(slab, count, !!memory);
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

  /** Later runs reject at once; runs already called complete, then the buffers are released. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.lock.run(async () => {
      if (this.slab) this.runner.destroySlab(this.slab);
      this.slab = null;
    });
  }
}

/**
 * Lanes resident on the GPU: upload once, encode into your own command encoders (e.g. between soup kernels),
 * read when needed. Params are written with queue.writeBuffer at encode time, so submit an encode before the
 * next encode with different options.
 */
export class Batch {
  readonly slabs: readonly Slab[];
  private destroyed = false;

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
    if (this.destroyed) throw new Error("zilion: batch destroyed");
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

  /** Upload lane records (manifest.record layout) for a resumed encode, e.g. the `record` of an earlier result. */
  uploadRecords(records: Uint32Array, o: { lane?: number } = {}): void {
    const R = this.manifest.record.wordsPerLane;
    if (records.length % R !== 0) throw new Error(`zilion: records are ${records.length} words, not a whole number of ${R}-word lanes`);
    this.each(o.lane ?? 0, records.length / R, (s, at, from, n) => this.runner.writeRecord(s, records.subarray(from * R, (from + n) * R), at));
  }

  /**
   * Record a run of the first `lanes` lanes (default: all) into `enc`. `resume: true` continues the lanes from the
   * records and memory resident in the batch (the outputs of the previous encode, or uploaded ones) instead of
   * beginning them; `stepBase` is the dial index of their first step in this run (the steps already run).
   */
  encode(enc: GPUCommandEncoder, o: BatchRunOptions = {}): void {
    const lanes = o.lanes ?? this.capacity;
    const m = this.manifest;
    const budget = o.budget ?? m.budget.default ?? (m.budget.perLane ? 0 : null);
    if (budget === null) throw new Error("zilion: no budget (pass { budget } or set world.budget.value)");
    if (o.ablation && m.ablation.kind !== "uniform") throw new Error("zilion: { ablation } needs ablation: { table: 'uniform' }");
    if (o.resume && !m.resumable) throw new Error("zilion: this machine cannot resume lanes (manifest.resumable is false)");
    stepBaseWords(o.stepBase);
    const pass = enc.beginComputePass({ label: "zilion:batch" });
    this.each(0, lanes, (s, _at, _from, n) => {
      this.runner.writeParams(s, {
        laneCount: n, laneBase: (o.laneBase ?? 0) + s.laneStart, budget, seed: o.seed ?? 0, ablation: o.ablation ?? null,
        stepBase: o.stepBase, resume: !!o.resume,
      });
      this.runner.dispatch(pass, s, n);
    });
    pass.end();
  }

  /**
   * Read the first `lanes` lanes (default: all) as they are after the work submitted so far: the copy is submitted
   * when read() is called, so uploads, encodes and submits that follow do not affect the result.
   */
  read(o: { lanes?: number } = {}): Promise<MachineResult> {
    if (this.destroyed) return Promise.reject(new Error("zilion: batch destroyed"));
    const m = this.manifest;
    const lanes = o.lanes ?? this.capacity;
    const H = m.memory.hostBytesPerLane;
    const R = m.record.wordsPerLane;
    const memory = m.memory.stored ? new Uint8Array(lanes * H) : null;
    const record = new Uint32Array(lanes * R);
    const reads: Promise<void>[] = [];
    this.each(0, lanes, (s, _at, from, n) => {
      reads.push(this.runner.snapshot(s, n, !!memory).then((out) => {
        if (memory && out.memory) memory.set(unpackMemory(m, out.memory, n), from * H);
        record.set(out.record, from * R);
      }));
    });
    return Promise.all(reads).then(() => decodeResult(m, lanes, memory, record));
  }

  /** encode + submit + read (all submitted before this returns). */
  run(o: BatchRunOptions = {}): Promise<MachineResult> {
    if (this.destroyed) return Promise.reject(new Error("zilion: batch destroyed"));
    const enc = this.device.createCommandEncoder({ label: "zilion:batch" });
    this.encode(enc, o);
    this.device.queue.submit([enc.finish()]);
    return this.read({ lanes: o.lanes });
  }

  /** Release the buffers. Work and reads already submitted complete. */
  destroy(): void {
    this.destroyed = true;
    for (const s of this.slabs) this.runner.destroySlab(s);
  }
}
