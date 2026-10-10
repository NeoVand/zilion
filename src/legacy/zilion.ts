import { maxLanesPerChunk, planChunks } from "../engine/chunks.js";
import { createKernel } from "../engine/gpu.js";
import { deviceLimits, LaneRunner } from "../engine/runner.js";
import { legacyMachine } from "./manifest.js";
import { REG_FIELDS, REGS_PER_PROGRAM } from "./shader.js";

/** Register state of one Z80 (16-bit register pairs). */
export interface Z80Registers {
  af: number;
  bc: number;
  de: number;
  hl: number;
  ix: number;
  iy: number;
  sp: number;
  pc: number;
  afPrime: number;
  bcPrime: number;
  dePrime: number;
  hlPrime: number;
}

/** Per-program starting register state. All fields optional; unset = 0, except sp defaults to 0xFFFF. */
export type Z80RegisterInit = Partial<Z80Registers>;

export interface RunOptions {
  /** Z80 instructions to execute per program (stops early on HALT). */
  steps: number;
  /** Optional per-program initial registers (index-aligned with `programs`). */
  init?: Z80RegisterInit[];
}

export interface RunResult {
  /** Number of programs run. */
  count: number;
  /** Bytes of memory per program. */
  memBytes: number;
  /** Final memory: flat Uint8Array of length count*memBytes. Use `memoryOf(i)`. */
  memory: Uint8Array;
  /** Final registers, one entry per program. */
  registers: Z80Registers[];
  /** Final memory of program `i` as a fresh Uint8Array view slice. */
  memoryOf(i: number): Uint8Array;
}

export interface ZilionOptions {
  /**
   * Bytes of memory per program. Must be a power of two (the 16-bit Z80 address
   * space wraps onto it). Default 256. Larger sizes reduce GPU occupancy.
   */
  memBytes?: number;
  /** Provide your own GPUDevice. If omitted, Zilion requests one. */
  device?: GPUDevice;
  /**
   * Instruction ablation: a WGSL boolean expression over `prefix` and `op`
   * (see `ShaderOptions.fetchHook`). Instructions for which it is true are
   * skipped as NOPs. Default: none.
   */
  fetchHook?: string;
}

const WORKGROUP_SIZE = 64;

/**
 * A batch Z80 executor. Runs many independent Z80 CPUs in parallel on the GPU.
 * Create once, call `run` as many times as you like, then `destroy`.
 *
 * Since 0.3 this is a facade over the engine's lane runner. The kernel is still buildComputeShader's
 * (byte-identical to 0.2) and the lifecycle is 0.2's: every run owns its GPU buffers and releases them before it
 * resolves, runs may overlap, and destroy() only marks the instance (and destroys a device Zilion created). What
 * changed: a batch is chunked against the device limits (0.2 failed above 4,194,240 programs or 128 MiB of
 * memory), the buffers are reused across the chunks of one run, each chunk is read back with one map, and an
 * invalid `fetchHook` makes `create` reject with the compiler's message instead of failing later.
 */
export class Zilion {
  readonly memBytes: number;
  readonly device: GPUDevice;
  private readonly runner: LaneRunner;
  private ownsDevice: boolean;
  private destroyed = false;

  private constructor(device: GPUDevice, memBytes: number, ownsDevice: boolean, runner: LaneRunner) {
    this.device = device;
    this.memBytes = memBytes;
    this.ownsDevice = ownsDevice;
    this.runner = runner;
  }

  /** Create a Zilion batch executor. Rejects with a ZilionShaderError if `fetchHook` does not compile. */
  static async create(opts: ZilionOptions = {}): Promise<Zilion> {
    const memBytes = opts.memBytes ?? 256;
    if (memBytes < 4 || (memBytes & (memBytes - 1)) !== 0) {
      throw new Error(`memBytes must be a power of two >= 4 (got ${memBytes})`);
    }
    let device = opts.device;
    let owns = false;
    if (!device) {
      const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
      if (!gpu) throw new Error("WebGPU is not available in this environment");
      const adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error("No WebGPU adapter available");
      device = await adapter.requestDevice();
      owns = true;
    }
    const built = legacyMachine(memBytes, { fetchHook: opts.fetchHook });
    try {
      const { pipeline, layout } = await createKernel(device, built.wgsl, built.manifest, "zilion-z80");
      return new Zilion(device, memBytes, owns, new LaneRunner(device, pipeline, layout, built.manifest));
    } catch (e) {
      if (owns) device.destroy();
      throw e;
    }
  }

  /**
   * Run a batch of programs. Each program is a byte array copied into that
   * instance's memory (zero-padded / truncated to `memBytes`). Returns the
   * final memory and registers of every program.
   */
  async run(
    programs: ArrayLike<number>[] | Uint8Array[],
    opts: RunOptions,
  ): Promise<RunResult> {
    if (this.destroyed) throw new Error("Zilion instance has been destroyed");
    const count = programs.length;
    if (count === 0) {
      return {
        count: 0,
        memBytes: this.memBytes,
        memory: new Uint8Array(0),
        registers: [],
        memoryOf: () => new Uint8Array(0),
      };
    }
    const memBytes = this.memBytes;

    // Pack memory (memBytes per program; the 0.2 storage layout is the bytes themselves).
    const memory = new Uint8Array(count * memBytes);
    for (let p = 0; p < count; p++) {
      const prog = programs[p];
      const off = p * memBytes;
      const len = Math.min(prog.length, memBytes);
      for (let i = 0; i < len; i++) memory[off + i] = prog[i] & 0xff;
    }

    // Pack initial registers (defaults: 0, sp=0xFFFF).
    const regData = new Uint32Array(count * REGS_PER_PROGRAM);
    for (let p = 0; p < count; p++) {
      const base = p * REGS_PER_PROGRAM;
      regData[base + 6] = 0xffff; // sp default
      const init = opts.init?.[p];
      if (init) {
        for (let f = 0; f < REG_FIELDS.length; f++) {
          const v = init[REG_FIELDS[f]];
          if (v !== undefined) regData[base + f] = v & 0xffff;
        }
      }
    }

    // Run in chunks that respect the device limits. As in 0.2 the buffers belong to this run (so runs may
    // overlap and destroy() never pulls buffers from under one); they are reused across its chunks and
    // released before the run resolves.
    const per = maxLanesPerChunk({
      workgroupSize: WORKGROUP_SIZE,
      bytesPerLane: this.runner.bytesPerLane(),
      stagingBytesPerLane: this.runner.stagingBytesPerLane(),
      limits: deviceLimits(this.device),
    });
    const slab = this.runner.createSlab(0, Math.min(count, per), "zilion-z80");
    const outRegs = new Uint32Array(count * REGS_PER_PROGRAM);
    try {
      for (const { start, count: n } of planChunks(count, per)) {
        const memWords = new Uint32Array(memory.buffer, start * memBytes, (n * memBytes) >> 2);
        this.runner.writeMemory(slab, memWords);
        this.runner.writeState(slab, regData.subarray(start * REGS_PER_PROGRAM, (start + n) * REGS_PER_PROGRAM));
        this.runner.writeParams(slab, { laneCount: n, laneBase: 0, budget: opts.steps, seed: 0 });
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        this.runner.dispatch(pass, slab, n);
        pass.end();
        this.device.queue.submit([enc.finish()]);
        const out = await this.runner.snapshot(slab, n, true);
        memory.set(new Uint8Array(out.memory!.buffer, out.memory!.byteOffset, n * memBytes), start * memBytes);
        outRegs.set(out.record, start * REGS_PER_PROGRAM);
      }
    } finally {
      this.runner.destroySlab(slab);
    }

    const registers: Z80Registers[] = [];
    for (let p = 0; p < count; p++) {
      const b = p * REGS_PER_PROGRAM;
      registers.push({
        af: outRegs[b + 0],
        bc: outRegs[b + 1],
        de: outRegs[b + 2],
        hl: outRegs[b + 3],
        ix: outRegs[b + 4],
        iy: outRegs[b + 5],
        sp: outRegs[b + 6],
        pc: outRegs[b + 7],
        afPrime: outRegs[b + 8],
        bcPrime: outRegs[b + 9],
        dePrime: outRegs[b + 10],
        hlPrime: outRegs[b + 11],
      });
    }

    return {
      count,
      memBytes,
      memory,
      registers,
      memoryOf: (i: number) =>
        memory.subarray(i * memBytes, (i + 1) * memBytes),
    };
  }

  /** Release GPU resources (and the device, if Zilion created it). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ownsDevice) this.device.destroy();
  }
}
