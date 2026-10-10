// The shader manifest: everything a host in any language needs to run a generated machine without re-deriving a
// layout by hand (bindings, the params struct, the memory and record layouts, provenance hashes). It is plain
// JSON; `test/world/gpu_runner.py` is a complete Python host driven only by it.

import type { CoreHook, DecodePage } from "./contract/isa.js";

export const MANIFEST_SCHEMA = "zilion.manifest/1";

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

export type RecordFieldName = "steps" | "haltReason" | "state" | "writeCounts" | "fetchMap" | "startMap" | "regs16";

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
  readonly ablation: {
    readonly kind: "none" | "expr" | "uniform";
    readonly layout?: string;
    readonly pages?: readonly DecodePage[];
    readonly wordsPerPage?: number;
    readonly words?: number;
  };
  readonly budget: { readonly unit: "steps" | "fetchBytes"; readonly perLane: boolean; readonly default: number | null };
  readonly init: { readonly perLane: boolean; readonly stateWords: number };
  /** Library mode: the WGSL functions a host shader calls. */
  readonly functions?: readonly string[];
  /** Host shaders that run several lanes per invocation (not emitted by buildMachine): dispatch size divisor. */
  readonly lanesPerInvocation?: number;
}
