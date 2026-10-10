// A manifest for the 0.2 kernel (buildComputeShader), so the engine and non-TypeScript hosts drive it like any
// other machine. The WGSL is buildComputeShader's, unchanged; only this description is new.

import { HALT_REASONS, HOST_CONTRACT, TRAP_CAUSES } from "../contract/host.js";
import { z80 } from "../cores/z80/index.js";
import { MANIFEST_SCHEMA, type ShaderManifest } from "../manifest.js";
import { canonicalJson } from "../util/json.js";
import { sha256 } from "../util/sha256.js";
import { ZILION_VERSION } from "../version.js";
import type { BuiltMachine } from "../world/build.js";
import { buildComputeShader, REG_FIELDS, REGS_PER_PROGRAM, type ShaderOptions } from "./shader.js";

/** buildComputeShader(memBytes, opts) with its manifest (mode 'legacy-0.2'). */
export function legacyMachine(memBytes: number, opts: ShaderOptions = {}): BuiltMachine {
  const wgsl = buildComputeShader(memBytes, opts);
  const words = memBytes >> 2;
  const hook = opts.fetchHook?.trim() || "false";
  const manifest: ShaderManifest = {
    schema: MANIFEST_SCHEMA,
    zilion: ZILION_VERSION,
    hostContract: HOST_CONTRACT,
    mode: "legacy-0.2",
    entryPoint: "main",
    workgroupSize: 64,
    core: {
      id: z80.id,
      name: z80.name,
      coreVersion: z80.coreVersion,
      status: z80.status,
      variant: z80.defaultVariant,
      compat: "0.2",
      addressBits: z80.addressBits,
      fetchUnitBytes: z80.fetchUnitBytes,
      hooks: [],
      params: {},
    },
    world: null,
    sha256: {
      wgsl: sha256(wgsl),
      core: sha256(z80.wgsl({ hooks: {} })),
      world: "",
      options: sha256(canonicalJson({ memBytes, fetchHook: hook })),
    },
    params: {
      bytes: 16,
      fields: [
        { name: "count", role: "laneCount", offset: 0, words: 1 },
        { name: "mem_bytes", role: "constant", offset: 4, words: 1, value: memBytes },
        { name: "steps", role: "budget", offset: 8, words: 1 },
        { name: "_pad", role: "pad", offset: 12, words: 1 },
      ],
    },
    bindings: [
      { group: 0, binding: 0, name: "params", role: "params", type: "uniform" },
      { group: 0, binding: 1, name: "mem_io", role: "memory", type: "storage", wordsPerLane: words },
      { group: 0, binding: 2, name: "regs_out", role: "record", type: "storage", wordsPerLane: REGS_PER_PROGRAM },
      { group: 0, binding: 3, name: "regs_in", role: "stateIn", type: "read-only-storage", wordsPerLane: REGS_PER_PROGRAM },
    ],
    memory: {
      model: "mask",
      ringBytes: memBytes,
      position: `addr & ${memBytes - 1}u`,
      hostBytesPerLane: memBytes,
      storageWordsPerLane: words,
      packing: "little-endian bytes",
      segments: [{ name: "memory", position: 0, bytes: memBytes, hostOffset: 0, storageWord: 0, storageWords: words }],
      padding: null,
      stored: true,
    },
    record: { wordsPerLane: REGS_PER_PROGRAM, fields: [{ name: "regs16", offset: 0, words: REGS_PER_PROGRAM, items: REG_FIELDS }] },
    state: REG_FIELDS.map((name, offset) => ({ name, bits: 16, offset })),
    haltReasons: HALT_REASONS,
    trapCauses: TRAP_CAUSES, // the 0.2 record (regs16) has no trapCause field
    resumable: false,
    ablation: hook === "false" ? { kind: "none" } : { kind: "expr" },
    budget: { unit: "steps", perLane: false, default: null },
    init: { perLane: true, stateWords: REGS_PER_PROGRAM },
  };
  return { wgsl, manifest };
}
