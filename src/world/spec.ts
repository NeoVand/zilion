// The world specification (L1). One WorldSpec means the same thing for every ISA: the code generated from it
// names no register and no opcode; it talks to the core only through the descriptor and the host-contract hooks.

import type { TrapCause, TrapDecision } from "../contract/host.js";
import type { IsaCore } from "../contract/isa.js";

/** One named stretch of the ring that the host loads and stores (a tape, a genome, a program). */
export interface Segment {
  readonly bytes: number;
  readonly name?: string;
}

/**
 * How ISA addresses map onto lane memory. Positions are `pos = addr & (bytes − 1)` (mask) or `addr mod P`
 * (ring, segments), where `addr` is already reduced to the ISA width by the core.
 */
export type MemoryModel =
  /** Power-of-two memory, 0.2's model. All bytes are loaded and stored. */
  | { readonly kind: "mask"; readonly bytes: number }
  /** A ring of any P ≥ 1 bytes (odd sizes included). All bytes are loaded and stored. */
  | { readonly kind: "ring"; readonly bytes: number }
  /**
   * Segments laid out back to back from position 0 (e.g. tapes A and B of a pair), on a ring of `ring` bytes
   * (default: their total). Ring bytes after the last segment are padding: zeroed at the start of every run and
   * never written back. Each segment is stored word-padded (ceil(bytes/4) u32), as Algocell's pair_data is.
   */
  | { readonly kind: "segments"; readonly segments: readonly Segment[]; readonly ring?: number };

/** Ring position a convention refers to: an index, or the last byte of the last segment (P − 1 without segments). */
export type Position = number | "lastByte";

export interface InitSpec {
  /**
   * `zero` (default): the core's world reset (every state field at its `reset` value, usually 0), then the
   * conventions below. `perLane`: the whole state record is read per lane from a buffer (excludes the rest).
   */
  readonly state?: "zero" | "perLane";
  /** "The stack top aliases position t", realised by `IsaCore.conventions.stackTop`. */
  readonly stack?: { readonly topAliases: Position };
  /** Constant state values (by field name), applied after the stack convention. */
  readonly set?: Readonly<Record<string, number>>;
  /**
   * Random state per lane from the counter-based hash: field k of lane l gets
   * zil_hash(seed, l, k, salt ^ ZIL_SALT_INIT) masked to the field width. Default fields: the randomizable ones.
   */
  readonly random?: { readonly fields?: readonly string[]; readonly salt?: number };
}

export interface BudgetSpec {
  /** `steps` (default): IsaCore steps. `fetchBytes`: instruction-stream bytes, counted ISA-neutrally by on_fetch. */
  readonly unit?: "steps" | "fetchBytes";
  /** A default for every run (overridable per run), or `perLane` for a per-lane budget buffer. */
  readonly value?: number | "perLane";
}

/** A probabilistic halt: halt when zil_hash(seed, lane, step, salt) < round(p · 2^32); p ≥ 1 always halts. */
export interface Dial {
  readonly probability: number;
  readonly salt?: number;
}

export type TrapPolicy = "as-chip" | TrapDecision | { readonly halt: Dial };

export interface HaltingSpec {
  /**
   * Halt the lane when the first fetch unit of an instruction equals `firstUnit` (Algocell's lethal tar:
   * `firstUnit: 0`), always or with a probability. Judged on the raw unit, before prefixes and before ablation.
   */
  readonly lethal?: { readonly firstUnit: number; readonly probability?: number; readonly salt?: number };
  /** Policy per trap cause (only causes the core raises). Unlisted causes behave as the chip does. */
  readonly traps?: Readonly<Partial<Record<TrapCause, TrapPolicy>>>;
}

export type AblationSpec =
  /** A raw WGSL boolean expression over the core's decode-hook parameters (Z80: `prefix`, `op`). Baked in. */
  | { readonly expr: string }
  /** A packed bitset per decode page, passed per run in the uniform: changing it needs no recompile. */
  | { readonly table: "uniform"; readonly layout?: string };

export interface OutputSpec {
  /** Final memory of the loaded region (default true). */
  readonly memory?: boolean;
  /** Final state record (default true). */
  readonly state?: boolean;
  /** T_S: bitmap of positions fetched as instruction stream, ceil(P/32) words (default false). */
  readonly fetchMap?: boolean;
  /** Bitmap of positions where an instruction started (default false). */
  readonly startMap?: boolean;
  /** Writes per segment, then writes into padding (mask/ring: total writes) (default false). */
  readonly writeCounts?: boolean;
}

/**
 * Escape hatch: raw WGSL added to the generated hooks. Bodies run after the world's own hook logic. Every raw
 * hook can use the world privates `zil_lane`, `zil_seed` and `zil_step` (the index of the current step).
 */
export interface RawHooks {
  /** Module-scope declarations (private variables, helper functions) the bodies below use. */
  readonly declarations?: string;
  /** Statements in `on_fetch(addr: u32)`. Enables the fetch hook. */
  readonly onFetch?: string;
  /** Statements in `on_instruction_start(pc: u32, unit: u32) -> u32`; may `return ZIL_HALT;` or `ZIL_SKIP`. */
  readonly onInstructionStart?: string;
  /** A WGSL boolean expression over the decode-hook parameters, OR-ed with the world's ablation. */
  readonly decode?: string;
  /** Statements in `zil_trap(cause: u32) -> u32`, before the world's policy; may return a decision. */
  readonly trap?: string;
  /** Body of `io_in(port: u32) -> u32` (must return). Enables the io hooks. Default: return 0u. */
  readonly ioIn?: string;
  /** Body of `io_out(port: u32, val: u32)`. Enables the io hooks. Default: nothing. */
  readonly ioOut?: string;
  /** Statements run once per lane, last: after the reset and the init conventions, or after a per-lane state load (`on_reset()`). */
  readonly onReset?: string;
}

export interface WorldSpec {
  readonly memory: MemoryModel;
  /** The PC starts at the lowest address that maps to this position (default 0). */
  readonly entry?: { readonly position: Position };
  readonly init?: InitSpec;
  readonly budget?: BudgetSpec;
  readonly halting?: HaltingSpec;
  readonly ablation?: AblationSpec;
  readonly outputs?: OutputSpec;
  readonly hooks?: RawHooks;
}

/** Names the library mode uses for host-owned resources. */
export interface BindingNames {
  /** Storage array (u32) the memory is loaded from and stored to: enables zil_load_memory / zil_store_memory. */
  readonly memory?: string;
  /** Storage array (u32) for zil_store_record. */
  readonly out?: string;
  /** Storage array (u32) for zil_load_state (perLane init). */
  readonly stateIn?: string;
  /** WGSL expression of an array<vec4<u32>, N> holding the ablation table (uniform tables). */
  readonly ablation?: string;
}

export interface MachineSpec {
  readonly isa: IsaCore;
  readonly variant?: string;
  readonly compat?: string;
  readonly world: WorldSpec;
  /** Workgroup size of the kernel entry point (default 64). */
  readonly workgroupSize?: number;
  /**
   * `kernel` (default): bindings and an entry point `main`. `library`: only functions (zil_begin, zil_run,
   * zil_load_memory, …) for a host shader that owns its buffers (e.g. a soup shader with several entry points).
   */
  readonly mode?: "kernel" | "library";
  readonly bindingNames?: BindingNames;
}
