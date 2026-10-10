#!/usr/bin/env node
// Throughput of the cores on a soup-like workload (GPU, wgpu-py): many lanes, each a pair [16,16] on a ring of 32
// bytes filled with random bytes, `budget` steps from PC 0 with the stack on the last byte, as an encounter of a
// soup runs. Run after `npm run build`:
//
//   node test/bench/bench-cores.mjs [--lanes 1048576] [--reps 5] [--budgets 128,512] [--python <exe>] [--json out.json]
//
// Each configuration is compiled once, its lane memory uploaded once into a pristine buffer, and every timed
// dispatch first copies the pristine memory into the working buffer on the GPU, so every repetition runs the same
// programs. The time per dispatch includes that copy (a few MB, well under a millisecond) and excludes uploads and
// readbacks. The executed steps come from the lane records (halted lanes stop early: a Z80 HALT, a 6502 JAM).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Z from "../../dist/index.js";
import { m6502 } from "../../dist/cores/m6502/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const lanes = Number(opt("--lanes", 1 << 20));
const reps = Number(opt("--reps", 5));
const budgets = opt("--budgets", "128,512").split(",").map(Number);
const python = opt("--python", process.env.ZILION_PYTHON ?? "python3");
const jsonOut = opt("--json", null);

const world = (budget, extra = {}) => ({
  memory: { kind: "segments", segments: [{ bytes: 16, name: "A" }, { bytes: 16, name: "B" }], ring: 32 },
  init: { stack: { firstPushAt: "lastByte" }, ...(extra.init ?? {}) },
  entry: { position: 0 },
  budget: { unit: "steps", value: budget },
  outputs: { state: false, memory: true, writeCounts: true },
  ...(extra.halting ? { halting: extra.halting } : {}),
});

const configs = [];
for (const b of budgets) {
  configs.push({ name: `z80 b${b}`, isa: "z80", budget: b, note: "HALT halts (as-chip)", spec: { isa: Z.z80, world: world(b) } });
  configs.push({ name: `6502 b${b}`, isa: "6502", budget: b, note: "JAM halts (as-chip); P = 0x20",
    spec: { isa: m6502, world: world(b, { init: { set: { a: 0, x: 0, y: 0, p: 0x20 } } }) } });
  configs.push({ name: `6502 b${b} jam-ignored`, isa: "6502", budget: b, note: "JAM a 1-byte no-op: every lane runs the whole budget",
    spec: { isa: m6502, world: world(b, { init: { set: { a: 0, x: 0, y: 0, p: 0x20 } }, halting: { traps: { illegal: "ignore" } } }) } });
}

const dir = mkdtempSync(join(tmpdir(), "zilion-bench-"));
try {
  const plan = { lanes, reps, seed: 20261010, configs: [] };
  configs.forEach((c, i) => {
    const m = Z.buildMachine(c.spec);
    writeFileSync(join(dir, `m${i}.wgsl`), m.wgsl);
    writeFileSync(join(dir, `m${i}.manifest.json`), JSON.stringify(m.manifest));
    plan.configs.push({ name: c.name, isa: c.isa, budget: c.budget, note: c.note, wgsl: `m${i}.wgsl`, manifest: `m${i}.manifest.json` });
  });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  const r = spawnSync(python, ["-I", join(here, "bench_cores.py"), join(dir, "plan.json"), ...(jsonOut ? [jsonOut] : [])], { stdio: "inherit" });
  process.exitCode = r.status ?? 2;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
