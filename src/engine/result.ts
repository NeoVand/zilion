// Typed results, decoded from raw lane records through the manifest.

import type { HaltReasonName } from "../contract/host.js";
import type { ShaderManifest } from "../manifest.js";

export interface MachineResult {
  readonly lanes: number;
  readonly manifest: ShaderManifest;
  /** Final memory in the host layout (segments back to back, no padding), lanes × hostBytesPerLane; null if not read. */
  readonly memory: Uint8Array | null;
  /** Raw lane records, lanes × manifest.record.wordsPerLane. */
  readonly record: Uint32Array;
  /** Steps executed per lane. */
  readonly steps: Uint32Array;
  /** Halt reason per lane (manifest.haltReasons; 0 = still running when the budget ran out). */
  readonly haltReason: Uint32Array;
  /** Final state records, lanes × state fields (manifest.state); null when outputs.state is false. */
  readonly state: Uint32Array | null;
  /** Write counters, lanes × counters (segments, then padding); null unless outputs.writeCounts. */
  readonly writeCounts: Uint32Array | null;
  /** Fetch bitmaps (T_S), lanes × ceil(P/32) words; null unless outputs.fetchMap. */
  readonly fetchMap: Uint32Array | null;
  /** Instruction-start bitmaps, lanes × ceil(P/32) words; null unless outputs.startMap. */
  readonly startMap: Uint32Array | null;
  memoryOf(i: number): Uint8Array;
  stateOf(i: number): Record<string, number>;
  haltReasonOf(i: number): HaltReasonName | number;
  writesOf(i: number): Record<string, number>;
  /** Ring positions fetched as instruction stream by lane i. */
  fetchedOf(i: number): number[];
  /** Ring positions where an instruction of lane i started. */
  startsOf(i: number): number[];
}

function column(record: Uint32Array, lanes: number, stride: number, offset: number): Uint32Array {
  const out = new Uint32Array(lanes);
  for (let i = 0; i < lanes; i++) out[i] = record[i * stride + offset];
  return out;
}

function block(record: Uint32Array, lanes: number, stride: number, offset: number, words: number): Uint32Array {
  const out = new Uint32Array(lanes * words);
  for (let i = 0; i < lanes; i++) out.set(record.subarray(i * stride + offset, i * stride + offset + words), i * words);
  return out;
}

function positions(words: Uint32Array, from: number, count: number): number[] {
  const out: number[] = [];
  for (let w = 0; w < count; w++) {
    const v = words[from + w];
    if (v) for (let b = 0; b < 32; b++) if ((v >>> b) & 1) out.push(w * 32 + b);
  }
  return out;
}

export function decodeResult(manifest: ShaderManifest, lanes: number, memory: Uint8Array | null, record: Uint32Array): MachineResult {
  const R = manifest.record.wordsPerLane;
  const f = (n: string) => manifest.record.fields.find((x) => x.name === n);
  const take = (n: string) => {
    const x = f(n);
    return x ? block(record, lanes, R, x.offset, x.words) : null;
  };
  const stepsF = f("steps");
  const haltF = f("haltReason");
  const state = take("state");
  const writeCounts = take("writeCounts");
  const fetchMap = take("fetchMap");
  const startMap = take("startMap");
  const S = manifest.state.length;
  const H = manifest.memory.hostBytesPerLane;
  const mapWords = f("fetchMap")?.words ?? f("startMap")?.words ?? 0;
  const counters = f("writeCounts")?.items ?? [];
  const haltNames = Object.entries(manifest.haltReasons);
  const steps = stepsF ? column(record, lanes, R, stepsF.offset) : new Uint32Array(lanes);
  const haltReason = haltF ? column(record, lanes, R, haltF.offset) : new Uint32Array(lanes);
  return {
    lanes,
    manifest,
    memory,
    record,
    steps,
    haltReason,
    state,
    writeCounts,
    fetchMap,
    startMap,
    memoryOf: (i) => {
      if (!memory) throw new Error("zilion: memory was not read back (outputs.memory is false)");
      return memory.subarray(i * H, (i + 1) * H);
    },
    stateOf: (i) => {
      if (!state) throw new Error("zilion: the state record is not an output of this machine");
      return Object.fromEntries(manifest.state.map((s, k) => [s.name, state[i * S + k]]));
    },
    haltReasonOf: (i) => (haltNames.find(([, v]) => v === haltReason[i])?.[0] as HaltReasonName | undefined) ?? haltReason[i],
    writesOf: (i) => {
      if (!writeCounts) throw new Error("zilion: write counts are not an output of this machine");
      return Object.fromEntries(counters.map((n, k) => [n, writeCounts[i * counters.length + k]]));
    },
    fetchedOf: (i) => {
      if (!fetchMap) throw new Error("zilion: the fetch map is not an output of this machine");
      return positions(fetchMap, i * mapWords, mapWords);
    },
    startsOf: (i) => {
      if (!startMap) throw new Error("zilion: the start map is not an output of this machine");
      return positions(startMap, i * mapWords, mapWords);
    },
  };
}
