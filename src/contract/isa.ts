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

/** A compile-time parameter a core declares (`IsaCore.params`). Never a uniform: changing one is a recompile. */
export type CoreParamDecl =
  | { readonly type: "u32"; readonly default: number; readonly description?: string }
  | { readonly type: "bool"; readonly default: boolean; readonly description?: string }
  /** One of `values`; emitted as its index, with one constant per value. */
  | { readonly type: "enum"; readonly default: string; readonly values: readonly string[]; readonly description?: string };

/** A resolved core parameter value: a u32, a bool, or an enum value name. */
export type CoreParamValue = number | boolean | string;

export interface CoreGenOptions {
  /** One of `IsaCore.variants` (default `IsaCore.defaultVariant`). */
  variant?: string;
  /** One of `IsaCore.compat` (default: its first entry). Selects historical semantics. */
  compat?: string;
  /** Which optional hooks the generated text calls. A disabled hook is never called (WGSL has no defaults). */
  hooks: Readonly<Partial<Record<CoreHook, boolean>>>;
  /**
   * Every declared parameter, resolved (the world's choice, else the declared default). The builder also emits
   * each one as a WGSL constant ahead of the core text (`coreParamConstants`), which is what the core text
   * should use; the values are passed here for cores that generate text from them.
   */
  params?: Readonly<Record<string, CoreParamValue>>;
}

export interface IsaConventions {
  /** What one step is (the budget unit `steps`). */
  readonly step: string;
  /**
   * State values that realise the world convention `init.stack.topAliases: t` ("the stack pointer aliases ring
   * position t") on a ring of P bytes, or null for an ISA without a hardware stack. Where the first push lands
   * relative to t is ISA-specific (Z80: t − 1; 6502: t). Kept for the `compat:'0.2'` and Algocell worlds.
   */
  readonly stackTop: ((P: number, t: number) => Readonly<Record<string, number>>) | null;
  /**
   * State values that realise `init.stack.firstPushAt: t`: the first byte pushed lands at ring position t, the
   * same bytes on every ISA (Z80: SP − 1 aliases t; 6502: 0x0100 | S aliases t). Null exactly when `stackTop`
   * is null. Keep it a small function of its own: it is the cross-ISA meaning of the stack.
   */
  readonly firstPushAt: ((P: number, t: number) => Readonly<Record<string, number>>) | null;
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
  /** The state record, in record order (for the default variant and compat). */
  readonly state: readonly StateField[];
  /** Private per-instruction temporaries (WGSL lvalues) that the world reset also zeroes. */
  readonly internals: readonly string[];
  /**
   * The state record and internals for a variant and compat, when they differ from `state` and `internals` (a newer
   * semantics may model more latches than a historical one). The builder uses this when present.
   */
  stateFor?(o: { variant: string; compat: string }): { readonly state: readonly StateField[]; readonly internals: readonly string[] };
  readonly symbols: {
    /** WGSL function that executes one step. */
    readonly step: string;
    /** WGSL u32 expression: ZIL_RUNNING or a ZIL_HALT_* reason. */
    readonly haltReason: string;
    /**
     * WGSL u32 expression: the TRAP_CAUSES code (ZIL_TRAP_<CAUSE>) of the trap that halted the core, as-chip or by
     * a world policy, and 0 when it did not halt on a trap. It must depend on state fields only, so that it
     * survives a state store and load (resumed runs, per-lane state).
     */
    readonly trapCause: string;
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
  /** Accepted `compat` values; the first is the default (unless `compatRequired`). */
  readonly compat: readonly string[];
  /**
   * True when a machine must name its `compat` (in the core selection, or through a world that states it): the
   * builder refuses a build that names none, instead of taking `compat[0]`. The Z80 requires it through 0.3.x, as
   * worlds require their stack and budget (no silent default).
   */
  readonly compatRequired?: boolean;
  /**
   * The version of the semantics a selection runs, when it differs from `coreVersion` (a historical `compat`
   * reproduces an older version's outputs). The builder records it as `manifest.core.coreVersion`.
   */
  coreVersionFor?(o: { variant: string; compat: string }): string;
  /**
   * Compile-time parameters (name → declaration). A machine selects values with `core: { isa, params }`; the
   * builder validates them, emits `const ZIL_PARAM_<NAME>` ahead of the core text and records them in the
   * manifest. Names are lower snake case (`[a-z][a-z0-9_]*`), as are enum values.
   */
  readonly params?: Readonly<Record<string, CoreParamDecl>>;
  /** The core text for these options. Uses the prelude constants (HOST_CONTRACT_PRELUDE_WGSL) when hooks are on. */
  wgsl(o: CoreGenOptions): string;
  /** Mnemonic table (later milestone). */
  table?(): readonly InstructionInfo[];
}
