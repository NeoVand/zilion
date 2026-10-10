// The shader manifest: everything a host in any language needs to run a generated machine without re-deriving a
// layout by hand (bindings, the params struct, the memory and record layouts, provenance hashes). It is plain
// JSON; `test/world/gpu_runner.py` is a complete Python host driven only by it.

import type { CoreHook, CoreParamValue, DecodePage } from "./contract/isa.js";

/**
 * Schema 2 (0.3.0-dev): the record gains `trapCause` (word 2, after `haltReason`, so later fields moved by one
 * word) and, on resumable padded worlds, `padding`; the params gain `stepBase` and `resume`; the manifest gains
 * `trapCauses`, `resumable` and `core.params`.
 */
export const MANIFEST_SCHEMA = "zilion.manifest/2";

/** What the host writes into a params word. */
export type ParamRole =
  /** Lanes in this dispatch. */
  | "laneCount"
  /** Global index of the dispatch's first lane (seeds the per-lane hashes; makes chunking invisible). */
  | "laneBase"
  /** Budget for every lane of the dispatch (unless the world has a per-lane budget buffer). */
  | "budget"
  /** Run seed for random initial state and dials. */
  | "seed"
  /**
   * 64-bit step base, two words (low, high): the index the dials give the first step of the dispatch. A run split
   * into dispatches draws what one long dispatch draws when each dispatch passes the steps already run.
   */
  | "stepBase"
  /** 0: lanes begin (reset, init conventions, on_reset). 1: lanes continue from their record and memory. */
  | "resume"
  /** Ablation bitset: `words` u32, page-major, bit (key & 31) of word page·wordsPerPage + (key >> 5). */
  | "ablation"
  /** A fixed value (`value`). */
  | "constant"
  /** Padding; write 0. */
  | "pad";

export interface ParamField {
  readonly name: string;
  readonly role: ParamRole;
  /** Byte offset in the uniform buffer. */
  readonly offset: number;
  /** Number of u32 words. */
  readonly words: number;
  readonly value?: number;
}

export type BindingRole =
  | "params"
  /** Lane memory, read and written (storage layout: word-padded segments). */
  | "memory"
  /** Per-lane output record. */
  | "record"
  /** Per-lane initial state (perLane worlds) or initial registers (0.2 layout). */
  | "stateIn"
  /** Per-lane budgets (perLane budget worlds). */
  | "budgetIn";

export interface BindingInfo {
  readonly group: 0;
  readonly binding: number;
  /** WGSL variable name. */
  readonly name: string;
  readonly role: BindingRole;
  readonly type: "uniform" | "storage" | "read-only-storage";
  /** u32 words per lane (storage bindings). */
  readonly wordsPerLane?: number;
}

/** One loaded segment: host bytes [hostOffset, +bytes) ↔ ring positions [position, +bytes) ↔ storage words. */
export interface SegmentLayout {
  readonly name: string;
  readonly position: number;
  readonly bytes: number;
  readonly hostOffset: number;
  readonly storageWord: number;
  readonly storageWords: number;
}

export interface MemoryLayout {
  readonly model: "mask" | "ring" | "segments";
  /** P: the number of ring positions (private memory per lane). */
  readonly ringBytes: number;
  /** WGSL expression mapping an ISA address to a position ('addr & 0xffu', 'addr % 33u'). */
  readonly position: string;
  /** Bytes per lane in the host (tight) layout: the segments concatenated, no padding. */
  readonly hostBytesPerLane: number;
  /** u32 words per lane in the storage layout. */
  readonly storageWordsPerLane: number;
  /** Byte order within a storage word. */
  readonly packing: "little-endian bytes";
  readonly segments: readonly SegmentLayout[];
  /** Ring positions zeroed every run and never stored. */
  readonly padding: { readonly from: number; readonly to: number } | null;
  /** Whether the kernel writes lane memory back (outputs.memory). */
  readonly stored: boolean;
}

export type RecordFieldName =
  | "steps"
  | "haltReason"
  /** TRAP_CAUSES code of the trap that halted the lane (manifest.trapCauses); 0 when it did not halt on a trap. */
  | "trapCause"
  | "state"
  | "writeCounts"
  | "fetchMap"
  | "startMap"
  /** The padding bytes at the end of the run (resumable padded worlds), packed like memory. */
  | "padding"
  | "regs16";

export interface RecordField {
  readonly name: RecordFieldName;
  /** Word offset in the lane record. */
  readonly offset: number;
  readonly words: number;
  /** Names of the words (state fields, write counters). Bitmaps: bit (pos & 31) of word (pos >> 5). */
  readonly items?: readonly string[];
}

export interface RecordLayout {
  readonly wordsPerLane: number;
  readonly fields: readonly RecordField[];
}

export interface StateLayoutField {
  readonly name: string;
  readonly bits: number;
  /** Word offset within the state block (record field `state`, or a stateIn lane). */
  readonly offset: number;
}

/**
 * How the stack was initialised (manifest.init.stack), in the order the steps apply. Nothing a world gives is
 * dropped silently: an `init.stack` on an ISA without a stack is listed here as not applicable, with what was given.
 */
export interface StackInit {
  /** No stack set up: the ISA has none (`given` is the init.stack it did not apply), or the state is loaded per lane. */
  readonly notApplicable?: "no stack" | "per-lane state";
  readonly given?: { readonly firstPushAt?: number | "lastByte"; readonly topAliases?: number | "lastByte" };
  /** The convention applied first: which one, the resolved ring position and the state values it set. */
  readonly convention?: {
    readonly kind: "firstPushAt" | "topAliases";
    readonly position: number;
    readonly values: Readonly<Record<string, number>>;
  };
  /** Stack fields then given by init.set. */
  readonly set?: readonly string[];
  /** Stack fields then drawn by init.random. */
  readonly random?: readonly string[];
}

export interface ShaderManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly zilion: string;
  readonly hostContract: number;
  readonly mode: "kernel" | "library" | "legacy-0.2";
  /** Compute entry point, or null in library mode. */
  readonly entryPoint: string | null;
  readonly workgroupSize: number;
  readonly core: {
    readonly id: string;
    readonly name: string;
    readonly coreVersion: string;
    readonly status: string;
    readonly variant: string;
    readonly compat: string;
    readonly addressBits: number;
    readonly fetchUnitBytes: number;
    /** v2 hooks the generated core text calls. */
    readonly hooks: readonly CoreHook[];
    /** Every compile-time parameter the core declares, resolved (`IsaCore.params`); empty when it declares none. */
    readonly params: Readonly<Record<string, CoreParamValue>>;
  };
  /** The world spec as given (raw hook text included); null for the 0.2 layout. */
  readonly world: unknown;
  readonly sha256: {
    /** The whole generated WGSL. */
    readonly wgsl: string;
    /** The core text as emitted (with its hooks). */
    readonly core: string;
    /** Canonical JSON of the world spec. */
    readonly world: string;
    /** Canonical JSON of the build options (variant, compat, mode, workgroup size, binding names). */
    readonly options: string;
  };
  readonly params: { readonly bytes: number; readonly fields: readonly ParamField[] };
  readonly bindings: readonly BindingInfo[];
  readonly memory: MemoryLayout;
  readonly record: RecordLayout;
  readonly state: readonly StateLayoutField[];
  readonly haltReasons: Readonly<Record<string, number>>;
  /** Codes of the record field `trapCause` (0: the lane did not halt on a trap). */
  readonly trapCauses: Readonly<Record<string, number>>;
  /**
   * Whether a dispatch can continue lanes from their previous record and memory (params role `resume`): the world
   * counts `steps`, stores the state and the memory, and its raw hooks declare no private state. What a lane carries
   * over: memory (and padding, in the record), the state record, steps, write counts and maps; the dials continue
   * through `stepBase`.
   */
  readonly resumable: boolean;
  readonly ablation: {
    readonly kind: "none" | "expr" | "uniform";
    readonly layout?: string;
    readonly pages?: readonly DecodePage[];
    readonly wordsPerPage?: number;
    readonly words?: number;
  };
  readonly budget: { readonly unit: "steps" | "fetchBytes"; readonly perLane: boolean; readonly default: number | null };
  readonly init: { readonly perLane: boolean; readonly stateWords: number; readonly stack: StackInit };
  /** Library mode: the WGSL functions a host shader calls. */
  readonly functions?: readonly string[];
  /** Host shaders that run several lanes per invocation (not emitted by buildMachine): dispatch size divisor. */
  readonly lanesPerInvocation?: number;
}
