import { Z80_CORE_WGSL } from './z80-core.wgsl.js';

// Registers written back per program (16-bit values), in this fixed order.
export const REG_FIELDS = [
	'af',
	'bc',
	'de',
	'hl',
	'ix',
	'iy',
	'sp',
	'pc',
	'afPrime',
	'bcPrime',
	'dePrime',
	'hlPrime'
] as const;
export const REGS_PER_PROGRAM = REG_FIELDS.length; // 12 u32 per program

/**
 * Build the full WebGPU compute shader for a batch of Z80 programs, each with
 * `memBytes` bytes of private memory (must be a power of two). One workgroup
 * invocation runs one program for `params.steps` instructions.
 *
 * Bindings:
 *   0: uniform  Params { count, mem_bytes, steps, sp_init }
 *   1: storage  mem     — flat u32 array, memBytes/4 words per program (in+out)
 *   2: storage  regs    — flat u32 array, REGS_PER_PROGRAM per program (out)
 *   3: storage  init    — flat u32 array, REGS_PER_PROGRAM per program (in)
 */
export function buildComputeShader(memBytes: number): string {
	if (memBytes < 4 || (memBytes & (memBytes - 1)) !== 0) {
		throw new Error(`memBytes must be a power of two >= 4 (got ${memBytes})`);
	}
	const mask = memBytes - 1;

	return /* wgsl */ `
struct Params {
	count: u32,
	mem_bytes: u32,
	steps: u32,
	_pad: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> mem_io: array<u32>;
@group(0) @binding(2) var<storage, read_write> regs_out: array<u32>;
@group(0) @binding(3) var<storage, read> regs_in: array<u32>;

// --- Host contract for the Z80 core (see z80-core.wgsl.ts) ---
// Per-instance memory: one byte per u32 slot in a private array. The 16-bit
// address space wraps onto memBytes (a power of two) via a mask.
var<private> mem: array<u32, ${memBytes}u>;
fn mem_read(addr: u32) -> u32 { return mem[addr & ${mask}u]; }
fn mem_write(addr: u32, val: u32) { mem[addr & ${mask}u] = val & 0xffu; }
fn on_fetch_opcode(op: u32) -> bool { return false; } // no suppression by default

${Z80_CORE_WGSL}

fn get16(base: u32, idx: u32) -> u32 { return regs_in[base + idx] & 0xffffu; }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let id = gid.x;
	if (id >= params.count) { return; }

	let words = params.mem_bytes >> 2u;
	let mbase = id * words;

	// Load this program's memory into the private array.
	for (var i = 0u; i < words; i++) {
		let w = mem_io[mbase + i];
		mem[i*4u]      = w & 0xffu;
		mem[i*4u + 1u] = (w >> 8u) & 0xffu;
		mem[i*4u + 2u] = (w >> 16u) & 0xffu;
		mem[i*4u + 3u] = (w >> 24u) & 0xffu;
	}

	// Initial register state (packed 16-bit values; see REG_FIELDS order).
	let rb = id * ${REGS_PER_PROGRAM}u;
	set_af(get16(rb, 0u));
	set_bc(get16(rb, 1u));
	set_de(get16(rb, 2u));
	set_hl(get16(rb, 3u));
	cpu_ix = get16(rb, 4u);
	cpu_iy = get16(rb, 5u);
	cpu_sp = get16(rb, 6u);
	cpu_pc = get16(rb, 7u);
	cpu_a2 = (get16(rb, 8u) >> 8u) & 0xffu; cpu_f2 = get16(rb, 8u) & 0xffu;
	cpu_b2 = (get16(rb, 9u) >> 8u) & 0xffu; cpu_c2 = get16(rb, 9u) & 0xffu;
	cpu_d2 = (get16(rb, 10u) >> 8u) & 0xffu; cpu_e2 = get16(rb, 10u) & 0xffu;
	cpu_h2 = (get16(rb, 11u) >> 8u) & 0xffu; cpu_l2 = get16(rb, 11u) & 0xffu;
	cpu_halted = 0u;
	cpu_iff1 = 0u; cpu_iff2 = 0u;
	idx_mode = 0u; idx_disp = 0u; idx_uses_mem = 0u;

	// Run.
	for (var s = 0u; s < params.steps; s++) {
		if (cpu_halted != 0u) { break; }
		z80_step();
	}

	// Write memory back.
	for (var i = 0u; i < words; i++) {
		mem_io[mbase + i] = mem[i*4u] | (mem[i*4u + 1u] << 8u) | (mem[i*4u + 2u] << 16u) | (mem[i*4u + 3u] << 24u);
	}

	// Write registers back (packed 16-bit).
	regs_out[rb + 0u]  = get_af();
	regs_out[rb + 1u]  = get_bc();
	regs_out[rb + 2u]  = get_de();
	regs_out[rb + 3u]  = get_hl();
	regs_out[rb + 4u]  = cpu_ix;
	regs_out[rb + 5u]  = cpu_iy;
	regs_out[rb + 6u]  = cpu_sp;
	regs_out[rb + 7u]  = cpu_pc;
	regs_out[rb + 8u]  = (cpu_a2 << 8u) | cpu_f2;
	regs_out[rb + 9u]  = (cpu_b2 << 8u) | cpu_c2;
	regs_out[rb + 10u] = (cpu_d2 << 8u) | cpu_e2;
	regs_out[rb + 11u] = (cpu_h2 << 8u) | cpu_l2;
}
`;
}
