#!/usr/bin/env node
// Export machines for hosts in other languages (Python, …): a JSON file of machine specs → <name>.wgsl and
// <name>.manifest.json per machine. Codegen stays in TypeScript; the host reads only the manifest.
//
//   npm run build && node scripts/export-machines.mjs machines.json --out shaders/ [--check] [--list-cores]
//
// machines.json, the canonical shape: an array of machine specs, each with the core selection beside the world:
//
//   [ { "name": "algocell_L16_P32",
//       "core": { "isa": "z80", "compat": "0.2", "variant"?: "classic", "params"?: { … } },
//       "world": { …WorldSpec… },
//       "mode"?: "kernel" | "library", "workgroupSize"?: 64, "bindingNames"?: { … } }, … ]
//
// `core.isa` is a core id. Every core the package builds is accepted: the script finds them in dist/cores/*/index.js
// (and the package root) by their descriptor id, so a new core needs no change here (`--list-cores` prints them).
// `variant`, `compat` and `params` go to buildMachine unchanged. The Z80 needs `core.compat` ('0.3' or '0.2'; no
// default through 0.3.x): Algocell's registered machines are '0.2'. Skeleton cores export, with a note (not for
// results). Every world states its budget and stack (buildMachine refuses silent defaults).
//
// Also accepted (the earlier shape): an object { "<name>": { …spec without name… } }, and in a spec the shorthand
// "isa": "<id>" with "variant"/"compat" beside it instead of "core".
// --check writes nothing and exits 1 unless every file on disk equals what would be written (for CI).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const Z = await import(pathToFileURL(join(root, "dist/index.js")).href);

/** Every IsaCore the build contains, by id: exported from the package root or from dist/cores/<dir>/index.js. */
async function findCores() {
  const isCore = (v) => v !== null && typeof v === "object" && typeof v.id === "string" && typeof v.wgsl === "function" &&
    Array.isArray(v.state) && typeof v.symbols?.step === "string";
  const cores = new Map();
  const add = (v, where) => {
    const prev = cores.get(v.id);
    if (prev && prev.isa !== v) throw new Error(`two different cores claim the id '${v.id}' (${prev.where}, ${where})`);
    if (!prev) cores.set(v.id, { isa: v, where });
  };
  for (const v of Object.values(Z)) if (isCore(v)) add(v, "dist/index.js");
  const dir = join(root, "dist", "cores");
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, d.name, "index.js");
    if (!d.isDirectory() || !existsSync(f)) continue;
    for (const v of Object.values(await import(pathToFileURL(f).href))) if (isCore(v)) add(v, `dist/cores/${d.name}/index.js`);
  }
  return cores;
}

const args = process.argv.slice(2);
const cores = await findCores();
if (args.includes("--list-cores")) {
  for (const [id, { isa, where }] of cores) {
    console.log(`${id}\t${isa.coreVersion}\t${isa.status}\tcompat: ${isa.compat.join(", ")}${isa.compatRequired ? " (required)" : ""}\t` +
      `variants: ${Object.keys(isa.variants).join(", ")}\t${where}`);
  }
  process.exit(0);
}
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : ".";
const check = args.includes("--check");
if (!file) {
  console.error("usage: node scripts/export-machines.mjs machines.json --out <dir> [--check] | --list-cores");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const entries = Array.isArray(raw)
  ? raw.map((s, i) => {
    if (s === null || typeof s !== "object" || typeof s.name !== "string") throw new Error(`machine ${i}: needs a "name"`);
    const { name, ...spec } = s;
    return [name, spec];
  })
  : raw !== null && typeof raw === "object" ? Object.entries(raw) : null;
if (!entries) throw new Error(`${file}: expected an array of machine specs (or an object of them by name)`);

const seen = new Set();
const machines = entries.map(([name, s]) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid machine name '${name}'`);
  if (seen.has(name)) throw new Error(`machine name '${name}' appears twice`);
  seen.add(name);
  if (s === null || typeof s !== "object") throw new Error(`${name}: the spec must be an object`);
  if (s.core !== undefined && (s.isa !== undefined || s.variant !== undefined || s.compat !== undefined)) {
    throw new Error(`${name}: give "core": { "isa", "compat", … } or the shorthand "isa" (with "variant"/"compat" beside it), not both`);
  }
  const { isa: shortIsa, variant, compat, ...rest } = s;
  const core = s.core ?? { isa: shortIsa, ...(variant !== undefined ? { variant } : {}), ...(compat !== undefined ? { compat } : {}) };
  if (core === null || typeof core !== "object") throw new Error(`${name}: "core" must be { "isa": "<id>", … }`);
  if (core.isa === undefined) throw new Error(`${name}: name the core ("core": { "isa": "<id>", … }; cores: ${[...cores.keys()].join(", ")})`);
  const entry = cores.get(core.isa);
  if (!entry) throw new Error(`${name}: unknown core '${core.isa}' (cores in this build: ${[...cores.keys()].join(", ")})`);
  const isa = entry.isa;
  if (isa.compatRequired && core.compat === undefined) {
    throw new Error(`${name}: "core.compat" is required for ${isa.id} (one of ${isa.compat.map((c) => `'${c}'`).join(", ")}; ` +
      "no default): Algocell's registered machines are '0.2'");
  }
  if (isa.status === "skeleton") console.error(`note  ${name}: ${isa.id} is a skeleton core (status 'skeleton'): not for results`);
  let m;
  try {
    m = Z.buildMachine({ ...rest, core: { ...core, isa } });
  } catch (e) {
    throw new Error(`${name}: ${e.message}`);
  }
  return [name, m];
});

if (!check) mkdirSync(out, { recursive: true });
let stale = 0;
for (const [name, m] of machines) {
  const files = { [`${name}.wgsl`]: m.wgsl, [`${name}.manifest.json`]: JSON.stringify(m.manifest, null, 1) + "\n" };
  for (const [f, text] of Object.entries(files)) {
    const path = join(out, f);
    if (check) {
      const same = existsSync(path) && readFileSync(path, "utf8") === text;
      if (!same) stale++;
      console.log(`${same ? "ok   " : "STALE"} ${path}`);
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${path}`);
    }
  }
}
process.exit(stale ? 1 : 0);
