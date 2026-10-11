// World presets: the worlds earlier code ran in, written out with every convention explicit (decision 3: a world
// states its stack and its budget). Each returns a plain WorldSpec, free of core semantics; spread it to add halting,
// ablation or outputs. The machines those worlds ran (the Z80 with compat '0.2') are in src/machine-presets.ts.

import type { WorldSpec } from "./spec.js";

function positiveInt(what: string, v: number): number {
  if (!Number.isInteger(v) || v < 1) throw new Error(`${what} must be a positive integer (got ${v})`);
  return v;
}

function u32(what: string, v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`${what} must be a u32 (got ${v})`);
  return v;
}

/**
 * The world of 0.2's `Zilion.run` (the machine: `compat02Machine`, the Z80 with compat '0.2'): `memBytes` of power-of-two memory,
 * `steps` per run. Registers: `'default'` is 0.2's default (all zero, SP = 0xFFFF: the stack pointer aliases the
 * last byte, and memBytes divides 65,536), `'perLane'` loads the whole state record per lane, as 0.2's `init` did.
 */
export function compat02World(o: { memBytes: number; steps: number; registers?: "default" | "perLane" }): WorldSpec {
  const bytes = positiveInt("memBytes", o.memBytes);
  if ((bytes & (bytes - 1)) !== 0 || bytes < 4) throw new Error(`memBytes must be a power of two ≥ 4 (got ${bytes})`);
  const registers = o.registers ?? "default";
  if (registers !== "default" && registers !== "perLane") throw new Error(`registers must be 'default' or 'perLane' (got ${String(registers)})`);
  return {
    memory: { kind: "mask", bytes },
    init: registers === "perLane" ? { state: "perLane" } : { stack: { topAliases: "lastByte" } },
    budget: { unit: "steps", value: u32("steps", o.steps) },
  };
}

/**
 * Algocell's pair world: tapes A and B of L bytes back to back on a ring of P ≥ 2L bytes (padding after B), the stack
 * pointer aliasing the last byte of B (Algocell's registered convention: on the Z80 the first push lands one byte
 * below it), `steps` per run, writes counted per tape and padding (the machine: `algocellPairMachine`, the Z80 with
 * compat '0.2', as registered). Add the condition's halting, ablation or maps
 * by spreading: `{ ...algocellPairWorld({ L: 16, P: 32, steps: 128 }), halting: { lethal: { firstUnit: 0 } } }`.
 */
export function algocellPairWorld(o: { L: number; P: number; steps: number }): WorldSpec {
  const L = positiveInt("L", o.L);
  const P = positiveInt("P", o.P);
  if (P < 2 * L) throw new Error(`P = ${P} is smaller than the pair (2L = ${2 * L})`);
  return {
    memory: { kind: "segments", segments: [{ bytes: L, name: "A" }, { bytes: L, name: "B" }], ring: P },
    init: { stack: { topAliases: "lastByte" } },
    budget: { unit: "steps", value: u32("steps", o.steps) },
    outputs: { writeCounts: true },
  };
}

/** The presets, by name. */
export const presets = { compat02: compat02World, algocellPair: algocellPairWorld } as const;
