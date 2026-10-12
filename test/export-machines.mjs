#!/usr/bin/env node
// scripts/export-machines.mjs end to end (no GPU). Run after `npm run build`:  node test/export-machines.mjs
// The canonical spec shape ({ name, core: { isa, compat?, variant?, params? }, world }), cores found by id in the
// build (z80, m6502, bff; a BFF alphabet table through JSON), byte-identity with the machine presets, --check, and the errors a vendoring script
// relies on (a Z80 without compat, an unknown core, an undeclared param), plus the earlier object-by-name shape.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Z from "../dist/index.js";
import { BFF_ASCII_LITERAL } from "../dist/cores/bff/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "export-machines.mjs");
const dir = mkdtempSync(join(tmpdir(), "zilion-export-"));
let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}\n          ${String(e.message ?? e).split("\n").join("\n          ")}`);
  }
}
const run = (specs, ...extra) => {
  const f = join(dir, `specs-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(specs));
  return spawnSync(process.execPath, [script, f, ...extra], { encoding: "utf8" });
};
const read = (out, f) => readFileSync(join(out, f), "utf8");
const expectError = (r, re) => {
  if (r.status === 0) throw new Error(`exited 0; stdout: ${r.stdout}`);
  if (!re.test(r.stderr)) throw new Error(`stderr does not match ${re}: ${r.stderr.slice(0, 600)}`);
};

const pairWorld = Z.algocellPairWorld({ L: 16, P: 32, steps: 128 });
const canonical = [
  { name: "algocell_L16_P32", core: { isa: "z80", compat: "0.2" }, world: pairWorld },
  { name: "z80_nmos", core: { isa: "z80", compat: "0.3", variant: "zilog-nmos" }, world: { ...pairWorld, outputs: { writeCounts: true, fetchMap: true } } },
  { name: "m6502_pair", core: { isa: "m6502" }, world: { ...pairWorld, init: { stack: { firstPushAt: "lastByte" } } } },
  { name: "bff_pair", core: { isa: "bff" }, world: { memory: pairWorld.memory, budget: { unit: "steps", value: 64 } } },
  // a table param through JSON: bff.py's ascii_map(True) with the literal push
  { name: "bff_lit", core: { isa: "bff", params: { alphabet: [...BFF_ASCII_LITERAL], literal: true, lit_rep: 2 } },
    world: { memory: pairWorld.memory, budget: { unit: "steps", value: 64 } } },
];

test("--list-cores finds z80, m6502 and bff in the build by descriptor id", () => {
  const r = spawnSync(process.execPath, [script, "--list-cores"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  const ids = r.stdout.trim().split("\n").map((l) => l.split("\t")[0]).sort();
  for (const id of ["bff", "m6502", "z80", "i8086"]) if (!ids.includes(id)) throw new Error(`no ${id} in ${ids}`);
  if (!/z80\t0\.3\.0\tstable\tcompat: 0\.3, 0\.2 \(required\)/.test(r.stdout)) throw new Error(r.stdout);
});

const out = join(dir, "out");
test("canonical specs: z80 (compat 0.2 and 0.3 zilog-nmos), m6502 and bff export; variant, compat and params pass through", () => {
  const r = run(canonical, "--out", out);
  if (r.status !== 0) throw new Error(r.stderr);
  // the full 6502 (experimental) and BFF (stable) cores export without a skeleton note
  if (/is a skeleton core/.test(r.stderr)) throw new Error(`a skeleton note: ${r.stderr}`);
  const man = (n) => JSON.parse(read(out, `${n}.manifest.json`)).core;
  const pick = (c) => [c.id, c.compat, c.variant, c.coreVersion];
  const got = canonical.map((s) => pick(man(s.name)));
  const want = [["z80", "0.2", "classic", "0.2.0"], ["z80", "0.3", "zilog-nmos", "0.3.0"],
    ["m6502", "0.3", "nmos", "0.3.0"], ["bff", "bff.py", "cubff", "1.0.0"], ["bff", "bff.py", "cubff", "1.0.0"]];
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  const lit = man("bff_lit").params;
  if (JSON.stringify(lit) !== JSON.stringify({ alphabet: [...BFF_ASCII_LITERAL], literal: true, lit_rep: 2 })) throw new Error(`bff_lit params ${JSON.stringify(lit)}`);
  if (!read(out, "bff_lit.wgsl").includes("const ZIL_PARAM_LIT_REP: u32 = 2u;")) throw new Error("bff_lit: the params did not reach the WGSL");
});

test("8086 exports by descriptor id and rejects its unvalidated queued mode", () => {
  const dest = join(dir, "intel");
  const spec = {name:"intel",core:{isa:"i8086",params:{prefetch:"coherent",hidden_latch:"zero_ea"}},world:{...pairWorld,init:{stack:{firstPushAt:"lastByte"}}}};
  const r = run([spec],"--out",dest);
  if(r.status!==0) throw new Error(r.stderr);
  const m = JSON.parse(read(dest,"intel.manifest.json"));
  if(m.core.id!=="i8086" || m.core.params.prefetch!=="coherent" || m.core.params.hidden_latch!=="zero_ea" || m.core.status!=="experimental" || m.core.compat!=="0.3" || m.core.coreVersion!=="0.3.0") throw new Error(JSON.stringify(m.core));
  expectError(run([{...spec,core:{isa:"i8086",params:{prefetch:"8088"}}}],"--out",dest),/prefetch '8088' is not implemented or validated/);
});

test("the exported compat '0.2' machine is byte-identical to buildMachine(algocellPairMachine(...)) and runs the 0.2.0 core", () => {
  const m = Z.buildMachine(Z.algocellPairMachine({ L: 16, P: 32, steps: 128 }));
  if (read(out, "algocell_L16_P32.wgsl") !== m.wgsl) throw new Error("WGSL differs from the machine preset");
  if (read(out, "algocell_L16_P32.manifest.json") !== JSON.stringify(m.manifest, null, 1) + "\n") throw new Error("manifest differs");
  if (!m.wgsl.includes(Z.Z80_CORE_WGSL)) throw new Error("not the 0.2.0 core");
});

test("--check: identical files pass; a changed file is STALE (exit 1)", () => {
  let r = run(canonical, "--out", out, "--check");
  if (r.status !== 0) throw new Error(r.stdout);
  appendFileSync(join(out, "bff_pair.wgsl"), "\n");
  r = run(canonical, "--out", out, "--check");
  if (r.status !== 1 || !/STALE .*bff_pair\.wgsl/.test(r.stdout)) throw new Error(`status ${r.status}: ${r.stdout}`);
});

test("errors: a Z80 core selection without compat; an unknown core; no core; an undeclared param; a duplicate name", () => {
  expectError(run([{ name: "a", core: { isa: "z80" }, world: pairWorld }], "--out", join(dir, "e")),
    /a: "core\.compat" is required for z80 \(one of '0\.3', '0\.2'; no default\)/);
  expectError(run([{ name: "a", isa: "z80", world: pairWorld }], "--out", join(dir, "e")), /"core\.compat" is required for z80/);
  expectError(run([{ name: "a", core: { isa: "pdp11" }, world: pairWorld }], "--out", join(dir, "e")),
    /unknown core 'pdp11' \(cores in this build: .*z80/);
  expectError(run([{ name: "a", world: pairWorld }], "--out", join(dir, "e")), /a: name the core/);
  expectError(run([{ name: "a", core: { isa: "z80", compat: "0.2", params: { q: true } }, world: pairWorld }], "--out", join(dir, "e")),
    /a: .*z80 has no param 'q'/);
  expectError(run([{ name: "a", core: { isa: "z80", compat: "0.2" }, world: pairWorld }, { name: "a", core: { isa: "bff" }, world: pairWorld }],
    "--out", join(dir, "e")), /'a' appears twice/);
  expectError(run([{ name: "a", core: { isa: "z80", compat: "0.2" }, compat: "0.3", world: pairWorld }], "--out", join(dir, "e")), /not both/);
});

test("the earlier shape still works: an object of specs by name, with the isa shorthand", () => {
  const o2 = join(dir, "old");
  const r = run({ algocell_L16_P32: { isa: "z80", compat: "0.2", world: pairWorld } }, "--out", o2);
  if (r.status !== 0) throw new Error(r.stderr);
  if (read(o2, "algocell_L16_P32.wgsl") !== read(out, "algocell_L16_P32.wgsl")) throw new Error("differs from the canonical export");
});

rmSync(dir, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
