import { buildComputeShader, REG_FIELDS, REGS_PER_PROGRAM } from './shader.js';

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
}

const WORKGROUP_SIZE = 64;

/**
 * A batch Z80 executor. Runs many independent Z80 CPUs in parallel on the GPU.
 * Create once, call `run` as many times as you like, then `destroy`.
 */
export class Zilion {
	readonly memBytes: number;
	readonly device: GPUDevice;
	private pipeline: GPUComputePipeline;
	private ownsDevice: boolean;
	private destroyed = false;

	private constructor(device: GPUDevice, memBytes: number, ownsDevice: boolean) {
		this.device = device;
		this.memBytes = memBytes;
		this.ownsDevice = ownsDevice;
		const module = device.createShaderModule({
			label: 'zilion-z80',
			code: buildComputeShader(memBytes)
		});
		this.pipeline = device.createComputePipeline({
			label: 'zilion-z80',
			layout: 'auto',
			compute: { module, entryPoint: 'main' }
		});
	}

	/** Create a Zilion batch executor. */
	static async create(opts: ZilionOptions = {}): Promise<Zilion> {
		const memBytes = opts.memBytes ?? 256;
		if (memBytes < 4 || (memBytes & (memBytes - 1)) !== 0) {
			throw new Error(`memBytes must be a power of two >= 4 (got ${memBytes})`);
		}
		let device = opts.device;
		let owns = false;
		if (!device) {
			const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
			if (!gpu) throw new Error('WebGPU is not available in this environment');
			const adapter = await gpu.requestAdapter();
			if (!adapter) throw new Error('No WebGPU adapter available');
			device = await adapter.requestDevice();
			owns = true;
		}
		return new Zilion(device, memBytes, owns);
	}

	/**
	 * Run a batch of programs. Each program is a byte array copied into that
	 * instance's memory (zero-padded / truncated to `memBytes`). Returns the
	 * final memory and registers of every program.
	 */
	async run(programs: ArrayLike<number>[] | Uint8Array[], opts: RunOptions): Promise<RunResult> {
		if (this.destroyed) throw new Error('Zilion instance has been destroyed');
		const count = programs.length;
		if (count === 0) {
			return { count: 0, memBytes: this.memBytes, memory: new Uint8Array(0), registers: [], memoryOf: () => new Uint8Array(0) };
		}
		const device = this.device;
		const memBytes = this.memBytes;
		const words = memBytes >> 2;

		// Pack memory (flat u32 per program).
		const memData = new Uint32Array(count * words);
		const memBytesView = new Uint8Array(memData.buffer);
		for (let p = 0; p < count; p++) {
			const prog = programs[p];
			const off = p * memBytes;
			const len = Math.min(prog.length, memBytes);
			for (let i = 0; i < len; i++) memBytesView[off + i] = prog[i] & 0xff;
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

		const params = new Uint32Array([count, memBytes, opts.steps, 0]);

		// Buffers.
		const memBuf = device.createBuffer({
			size: memData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(memBuf, 0, memData);
		const regsOutBuf = device.createBuffer({
			size: regData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
		});
		const regsInBuf = device.createBuffer({
			size: regData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(regsInBuf, 0, regData);
		const paramsBuf = device.createBuffer({
			size: params.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(paramsBuf, 0, params);

		const bindGroup = device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: paramsBuf } },
				{ binding: 1, resource: { buffer: memBuf } },
				{ binding: 2, resource: { buffer: regsOutBuf } },
				{ binding: 3, resource: { buffer: regsInBuf } }
			]
		});

		const memStage = device.createBuffer({
			size: memData.byteLength,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
		});
		const regsStage = device.createBuffer({
			size: regData.byteLength,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
		});

		const enc = device.createCommandEncoder();
		const pass = enc.beginComputePass();
		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP_SIZE));
		pass.end();
		enc.copyBufferToBuffer(memBuf, 0, memStage, 0, memData.byteLength);
		enc.copyBufferToBuffer(regsOutBuf, 0, regsStage, 0, regData.byteLength);
		device.queue.submit([enc.finish()]);

		await memStage.mapAsync(GPUMapMode.READ);
		const outMem = new Uint8Array(memStage.getMappedRange().slice(0));
		memStage.unmap();
		await regsStage.mapAsync(GPUMapMode.READ);
		const outRegs = new Uint32Array(regsStage.getMappedRange().slice(0));
		regsStage.unmap();

		memBuf.destroy();
		regsOutBuf.destroy();
		regsInBuf.destroy();
		paramsBuf.destroy();
		memStage.destroy();
		regsStage.destroy();

		// Repack memory: private-array layout stores 1 byte per u32, but we wrote
		// it back packed 4-per-word, so outMem is already tight bytes.
		const memory = new Uint8Array(count * memBytes);
		memory.set(outMem.subarray(0, count * memBytes));

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
				hlPrime: outRegs[b + 11]
			});
		}

		return {
			count,
			memBytes,
			memory,
			registers,
			memoryOf: (i: number) => memory.subarray(i * memBytes, (i + 1) * memBytes)
		};
	}

	/** Release GPU resources (and the device, if Zilion created it). */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		if (this.ownsDevice) this.device.destroy();
	}
}
