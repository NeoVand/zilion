// L1: the world. One spec, the same generated code for every ISA.
export { buildMachine } from "./build.js";
export type { BuiltMachine } from "./build.js";
export type {
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
} from "./spec.js";
export { zilHash, zilMix32, zilDraw, dialThreshold, initDraw, ZIL_SALT_INIT, HASH_WGSL } from "./hash.js";
export { presets, compat02World, algocellPairWorld } from "./presets.js";
export { ringPos, highestAlias, lowestAlias, seamOffset } from "../contract/address.js";
