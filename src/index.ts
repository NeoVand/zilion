// @neovand/zilion — root exports. The 0.2 API (Zilion, buildComputeShader, REG_FIELDS, REGS_PER_PROGRAM,
// Z80_CORE_WGSL) is unchanged; everything else is new in 0.3.

// 0.2 API (compatibility facade)
export { Zilion } from "./legacy/zilion.js";
export type {
  ZilionOptions,
  RunOptions,
  RunResult,
  Z80Registers,
  Z80RegisterInit,
} from "./legacy/zilion.js";
export { buildComputeShader, REG_FIELDS, REGS_PER_PROGRAM } from "./legacy/shader.js";
export type { ShaderOptions } from "./legacy/shader.js";
export { Z80_CORE_WGSL } from "./cores/z80/core.wgsl.js";

// Provenance
export { ZILION_VERSION } from "./version.js";

// L0: the plug-in contract and the Z80 core
export {
  HOST_CONTRACT,
  HOST_CONTRACT_PRELUDE_WGSL,
  HALT_REASONS,
  TRAP_CAUSES,
  ZIL_CONTINUE,
  ZIL_HALT,
  ZIL_SKIP,
  ZIL_TRAP_HALT,
  ZIL_TRAP_IGNORE,
  ZIL_TRAP_VECTOR,
} from "./contract/host.js";
export type { HaltReasonName, TrapCause, TrapDecision } from "./contract/host.js";
export type {
  IsaCore,
  IsaConventions,
  StateField,
  DecodeHook,
  DecodeLayout,
  DecodePage,
  CoreHook,
  CoreGenOptions,
  CoreParamDecl,
  CoreParamValue,
  InstructionInfo,
} from "./contract/isa.js";
export { coreParamConstant, resolveCoreParams, checkCoreParamDecls } from "./contract/params.js";
export { ringPos, highestAlias, lowestAlias, seamOffset } from "./contract/address.js";
export { z80, z80CoreText } from "./cores/z80/index.js";
export type { Z80Hooks } from "./cores/z80/index.js";

// L1: worlds and the machine builder
export {
  buildMachine,
  zilHash,
  zilMix32,
  zilDraw,
  dialThreshold,
  initDraw,
  ZIL_SALT_INIT,
  presets,
  compat02World,
  algocellPairWorld,
} from "./world/index.js";
export type {
  BuiltMachine,
  WorldSpec,
  MachineSpec,
  MemoryModel,
  Segment,
  Position,
  InitSpec,
  StackSpec,
  CoreSelection,
  BudgetSpec,
  HaltingSpec,
  Dial,
  TrapPolicy,
  AblationSpec,
  OutputSpec,
  RawHooks,
  BindingNames,
} from "./world/index.js";
export { MANIFEST_SCHEMA } from "./manifest.js";
export type {
  ShaderManifest,
  ParamField,
  ParamRole,
  BindingInfo,
  BindingRole,
  MemoryLayout,
  SegmentLayout,
  RecordLayout,
  RecordField,
  RecordFieldName,
  StateLayoutField,
} from "./manifest.js";
export { sha256 } from "./util/sha256.js";

// L2: the batch engine
export { createEngine, Engine, Machine, Batch } from "./engine/engine.js";
export type { EngineOptions, MachineRunOptions, BatchRunOptions, LaneInput } from "./engine/engine.js";
export type { MachineResult } from "./engine/result.js";
export { decodeResult } from "./engine/result.js";
export { ZilionShaderError } from "./engine/gpu.js";
export { maxLanesPerChunk, planChunks, DEFAULT_LIMITS } from "./engine/chunks.js";
export type { ChunkLimits, ChunkPlanOptions } from "./engine/chunks.js";
export { packMemory, unpackMemory, stepBaseWords } from "./engine/runner.js";
export type { Slab, SlabBuffers } from "./engine/runner.js";
export { legacyMachine } from "./legacy/manifest.js";
