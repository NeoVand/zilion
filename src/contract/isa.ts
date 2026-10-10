// The plug-in contract (L0): what every ISA core provides to Zilion.
//
// A core is WGSL text plus this descriptor. The world (L1) and the engine (L2) use only the descriptor and the
// hooks of the host contract (./host.ts); they never name a core's registers or functions directly. Everything
// the builder generates per core (reset, state record store/load, random init, stack and entry conventions,
// ablation tables) is derived from the descriptor, so a new core writes only its step function and its state.

import type { TrapCause, TrapDecision } from "./host.js";

/** One field of a core's state record (registers, flags, latches). */
export interface StateField {
  /** Record name; stable across versions (vector adapters and manifests use it). */
  readonly name: string;
  /** Width in bits (1..32). Stored values are masked to it. */
  readonly bits: number;
  /** WGSL lvalue that holds the field, e.g. `cpu_a` or `rv_x[5]`. */
  readonly wgsl: string;
  /** Value after the world reset (default 0). The world reset is "all-zero state", not the chip's reset sequence. */
  readonly reset?: number;
  /** Drawn by `init.random` when no field list is given (general-purpose registers). */
  readonly randomizable?: boolean;
  /** Free-text note (e.g. "PC is parked on HALT while halted"). */
  readonly note?: string;
}

/** One page of the decode-key space, for ablation masks. */
export interface DecodePage {
  readonly id: number;
  readonly name: string;
  /** Keys per page = 2^keyBits. */
  readonly keyBits: number;
}

/** A way of folding the core's decode hook arguments into (page, key) for an ablation bitset. */
export interface DecodeLayout {
  readonly pages: readonly DecodePage[];
  /** WGSL u32 expression over the hook parameters giving the page index. */
  readonly pageExpr: string;
  /** WGSL u32 expression over the hook parameters giving the key. */
  readonly keyExpr: string;
  readonly description: string;
}

/** The decode (ablation) hook a core calls once per executed instruction, after full decode. */
export interface DecodeHook {
  /** WGSL function name: `on_decode` by convention; the Z80 keeps its 0.2 name `on_fetch_opcode`. */
  readonly fn: string;
  /** The two u32 parameter names, in order. The hook returns `bool`: true skips the instruction. */
  readonly params: readonly [string, string];
  readonly layouts: Readonly<Record<string, DecodeLayout>>;
  readonly defaultLayout: string;
  /** What a skipped instruction consumes (documented per ISA, because it shapes evolution). */
  readonly skip: string;
}

/** Optional host-contract-v2 hooks a core can call (the decode hook is always called when `decode` is set). */
export type CoreHook = "fetch" | "instructionStart" | "trap" | "io";

export interface CoreGenOptions {
  /** One of `IsaCore.variants` (default `IsaCore.defaultVariant`). */
  variant?: string;
  /** One of `IsaCore.compat` (default: its first entry). Selects historical semantics. */
  compat?: string;
  /** Which optional hooks the generated text calls. A disabled hook is never called (WGSL has no defaults). */
  hooks: Readonly<Partial<Record<CoreHook, boolean>>>;
}

export interface IsaConventions {
  /** What one step is (the budget unit `steps`). */
  readonly step: string;
  /**
   * State values that realise the world convention "the stack top aliases ring position t" on a ring of P bytes,
   * or null for an ISA without a hardware stack. Where the first push lands relative to t is ISA-specific.
   */
  readonly stackTop: ((P: number, t: number) => Readonly<Record<string, number>>) | null;
  /** State values that start execution at ring position `pos`. */
  entry(pos: number, P: number): Readonly<Record<string, number>>;
  /** The trap causes this core raises, with what the chip itself does ("as-chip"). */
  readonly traps: Readonly<Partial<Record<TrapCause, TrapDecision>>>;
  /** Halting behaviour in prose: native halts, what `haltReason` reports. */
  readonly halting: string;
  /** Illegal and undefined opcodes in prose. */
  readonly illegal: string;
}

/** A mnemonic table entry (later milestone; optional now). */
export interface InstructionInfo {
  readonly page: number;
  readonly key: number;
  readonly mnemonic: string;
  readonly length: number;
  readonly families: readonly string[];
}

export interface IsaCore {
  /** Short id: 'z80' | 'bff' | 'm6502' | … */
  readonly id: string;
  readonly name: string;
  /** Version of this core's semantics; changes whenever any output for any input can change. */
  readonly coreVersion: string;
  /** `skeleton` cores exist to validate the contract and must not be used for results. */
  readonly status: "stable" | "experimental" | "skeleton";
  /** Address width: 16 (Z80, 6502), 20 (8086), 32 (RV32), or 0 for ring-native machines (BFF). */
  readonly addressBits: 0 | 16 | 20 | 32;
  /** Width of the unit passed to `on_instruction_start`. `on_fetch` is always per byte. */
  readonly fetchUnitBytes: 1 | 2 | 4;
  readonly endianness: "little";
  /** The state record, in record order. */
  readonly state: readonly StateField[];
  /** Private per-instruction temporaries (WGSL lvalues) that the world reset also zeroes. */
  readonly internals: readonly string[];
  readonly symbols: {
    /** WGSL function that executes one step. */
    readonly step: string;
    /** WGSL u32 expression: ZIL_RUNNING or a ZIL_HALT_* reason. */
    readonly haltReason: string;
    /** WGSL u32 expression: address of the next instruction. */
    readonly pc: string;
  };
  /** Optional hooks this core can call. */
  readonly hooks: readonly CoreHook[];
  /** The decode hook, or null when the core has no per-instruction decode point. */
  readonly decode: DecodeHook | null;
  readonly conventions: IsaConventions;
  /** Variant name → description. */
  readonly variants: Readonly<Record<string, string>>;
  readonly defaultVariant: string;
  /** Accepted `compat` values; the first is the default. */
  readonly compat: readonly string[];
  /** The core text for these options. Uses the prelude constants (HOST_CONTRACT_PRELUDE_WGSL) when hooks are on. */
  wgsl(o: CoreGenOptions): string;
  /** Mnemonic table (later milestone). */
  table?(): readonly InstructionInfo[];
}
