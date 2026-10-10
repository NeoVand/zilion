#!/usr/bin/env node
// Differential world test against the executors Algocell exported with zilion 0.2.0 (optional; needs an Algocell
// checkout). Run after `npm run build`:
//
//   node test/world/algocell.mjs [--algocell <repo>] [--python <exe>] [--n 20000] [--only <substring>]
//
// For each case it builds a machine from a world spec (segments [L, L] on a ring of P, stack at the last byte,
// writes counted) and runs the same random pairs through it and through Algocell's shader for that condition:
// the plain executors (even, odd and padded rings), the lethal-tar executor, the traced and op-traced executors
// (derived by Algocell's own gen_trace_shader / optrace hunks), the probability dial and the randreg/randsp
// conventions (both reproduced through raw hooks, the escape hatch for registered PCG streams), and instruction
// ablation through the uniform table. Compared: final memory, A..L, SP, PC, writes into A and into B (+ padding),
// fetched and instruction-start positions. The world code never sees Algocell's shader; only outputs are compared.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Z from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const algocell = resolve(opt("--algocell", process.env.ALGOCELL_DIR ?? join(here, "../../../algocell")));
const python = opt("--python", process.env.ZILION_PYTHON ?? "python3");
const N = +opt("--n", "20000");
const only = opt("--only", "");
if (!existsSync(join(algocell, "experiments/algocell_exp/shader"))) {
  console.log(`no Algocell checkout at ${algocell}; skipped`);
  process.exit(0);
}

const pair = (L, P, extra = {}) => ({
  memory: { kind: "segments", segments: [{ bytes: L, name: "A" }, { bytes: L, name: "B" }], ring: P },
  init: { stack: { topAliases: "lastByte" } },
  ...extra,
  outputs: { writeCounts: true, ...(extra.outputs ?? {}) },
});

// Algocell's PCG step (gen_dial_shader.py, gen_conv_shader.py), reproduced through raw hooks.
const pcg = (state, fn) => `var<private> ${state}: u32;
fn ${fn}() -> u32 {
    let s = ${state};
    ${state} = s * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}`;
const dialHooks = (p) => ({
  declarations: pcg("lethal_state", "lethal_draw"),
  onReset: "lethal_state = zil_seed * 2654435761u + zil_lane * 2246822519u + 0x165667b1u; lethal_draw();",
  onInstructionStart: `if (unit == 0u) { if (${p >= 1 ? "true" : `lethal_draw() < ${Math.min(Math.floor(p * 2 ** 32), 2 ** 32 - 1)}u`}) { return ZIL_HALT; } }`,
});
const REG8 = ["cpu_a", "cpu_f", "cpu_b", "cpu_c", "cpu_d", "cpu_e", "cpu_h", "cpu_l", "cpu_a2", "cpu_f2", "cpu_b2", "cpu_c2", "cpu_d2", "cpu_e2", "cpu_h2", "cpu_l2"];
const convHooks = (variant) => ({
  declarations: pcg("conv_state", "conv_draw"),
  onReset: [
    "conv_state = zil_seed * 2246822519u + zil_lane * 3266489917u + 0x27d4eb2fu;",
    "conv_draw();",
    ...(variant === "randreg"
      ? [...REG8.map((r) => `${r} = conv_draw() & 0xffu;`), "cpu_ix = conv_draw() & 0xffffu;", "cpu_iy = conv_draw() & 0xffffu;"]
      : ["cpu_sp = conv_draw() & 0xffffu;"]),
  ].join("\n"),
});

const CASES = [
  ...[[16, 32], [8, 16], [20, 40], [50, 100], [64, 128]].map(([L, P]) => ({ name: `plain L=${L} P=${P}`, L, source: `z80_test_L${L}.wgsl`, world: pair(L, P) })),
  ...[[16, 33], [16, 35], [16, 37], [36, 73], [36, 75], [36, 79]].map(([L, P]) => ({ name: `odd padded L=${L} P=${P}`, L, source: `z80_test_L${L}_P${P}.wgsl`, world: pair(L, P) })),
  ...[[16, 34], [16, 40], [16, 56], [8, 18], [10, 44], [12, 48], [36, 74]].map(([L, P]) => ({ name: `even padded L=${L} P=${P}`, L, source: `z80_test_L${L}_P${P}.wgsl`, world: pair(L, P) })),
  { name: "lethal tar L=16", L: 16, source: "z80_test_lethal_L16.wgsl", world: pair(16, 32, { halting: { lethal: { firstUnit: 0 } } }) },
  { name: "lethal tar L=32", L: 32, source: "z80_test_lethal_L32.wgsl", world: pair(32, 64, { halting: { lethal: { firstUnit: 0 } } }) },
  { name: "fetch map (traced executor) L=16", L: 16, source: "z80_test_L16.wgsl", derive: "trace", world: pair(16, 32, { outputs: { fetchMap: true } }) },
  { name: "fetch map (traced executor) L=36", L: 36, source: "z80_test_L36.wgsl", derive: "trace", world: pair(36, 72, { outputs: { fetchMap: true } }) },
  { name: "fetch + start maps (op-traced executor) L=16", L: 16, source: "z80_test_L16.wgsl", derive: "optrace", world: pair(16, 32, { outputs: { fetchMap: true, startMap: true } }) },
  { name: "fetch + start maps, lethal tar L=16", L: 16, source: "z80_test_lethal_L16.wgsl", derive: "optrace",
    world: pair(16, 32, { halting: { lethal: { firstUnit: 0 } }, outputs: { fetchMap: true, startMap: true } }) },
  ...[["lp003", 0.03], ["lp03", 0.3], ["lp1", 1.0]].map(([tag, p]) => ({
    name: `dial ${tag} L=16 (Algocell's PCG stream via raw hooks)`, L: 16, source: `z80_test_${tag}_L16.wgsl`, world: pair(16, 32, { hooks: dialHooks(p) }) })),
  ...["randreg", "randsp"].flatMap((v) => [16, 32].map((L) => ({
    name: `${v} L=${L} (Algocell's PCG stream via raw hooks)`, L, source: `z80_test_${v}_L${L}.wgsl`, world: pair(L, 2 * L, { hooks: convHooks(v) }) }))),
  { name: "ablation: random masks in the uniform table = Algocell's params.suppress L=16", L: 16, source: "z80_test_L16.wgsl", masks: "random",
    world: pair(16, 32, { ablation: { table: "uniform" } }) },
  { name: "ablation + odd padded ring L=16 P=37", L: 16, source: "z80_test_L16_P37.wgsl", masks: "random", world: pair(16, 37, { ablation: { table: "uniform" } }) },
].filter((c) => !only || c.name.includes(only));

const dir = mkdtempSync(join(tmpdir(), "zilion-algocell-"));
const plan = CASES.map((c, i) => {
  const m = Z.buildMachine({ isa: Z.z80, world: c.world });
  writeFileSync(join(dir, `m${i}.wgsl`), m.wgsl);
  writeFileSync(join(dir, `m${i}.manifest.json`), JSON.stringify(m.manifest));
  return { name: c.name, L: c.L, source: c.source, derive: c.derive ?? null, masks: c.masks ?? null,
    wgsl: join(dir, `m${i}.wgsl`), manifest: join(dir, `m${i}.manifest.json`), n: N, steps: 128, seed: 1000 + i };
});
writeFileSync(join(dir, "plan.json"), JSON.stringify({ algocell, cases: plan }));
const py = spawnSync(python, [join(here, "algocell_equiv.py"), join(dir, "plan.json")], { stdio: "inherit" });
rmSync(dir, { recursive: true, force: true });
process.exit(py.status ?? 2);
