// Machine presets: a world preset together with the core selection it ran with. Worlds carry no core semantics
// (src/world/presets.ts); these name the core and its compat explicitly, as a machine must (the Z80 has no default
// compat through 0.3.x). Each returns a MachineSpec for buildMachine or engine.machine:
//
//   buildMachine(algocellPairMachine({ L: 16, P: 32, steps: 128 }))
//   const m = algocellPairMachine({ L: 16, P: 37, steps: 128 });
//   buildMachine({ ...m, world: { ...m.world, halting: { lethal: { firstUnit: 0 } } } })    // add a condition
//   buildMachine({ ...m, core: { ...m.core, compat: "0.3" } })                              // the same world, 0.3
//
// The JSON form for scripts/export-machines.mjs is the same with the ISA named by id:
//   { "name": "…", "core": { "isa": "z80", "compat": "0.2" }, "world": { … } }

import { z80 } from "./cores/z80/index.js";
import type { MachineSpec } from "./world/spec.js";
import { algocellPairWorld, compat02World } from "./world/presets.js";

/** The machine of 0.2's `Zilion.run`: the Z80 with compat '0.2' in `compat02World`. */
export function compat02Machine(o: { memBytes: number; steps: number; registers?: "default" | "perLane" }): MachineSpec {
  return { core: { isa: z80, compat: "0.2" }, world: compat02World(o) };
}

/** Algocell's registered machine: the Z80 with compat '0.2' in `algocellPairWorld`. */
export function algocellPairMachine(o: { L: number; P: number; steps: number }): MachineSpec {
  return { core: { isa: z80, compat: "0.2" }, world: algocellPairWorld(o) };
}

/** The machine presets, by name. */
export const machinePresets = { compat02: compat02Machine, algocellPair: algocellPairMachine } as const;
