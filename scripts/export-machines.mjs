#!/usr/bin/env node
// Export machines for hosts in other languages (Python, …): a JSON file of world specs → <name>.wgsl and
// <name>.manifest.json per entry. Codegen stays in TypeScript; the host reads only the manifest.
//
//   npm run build && node scripts/export-machines.mjs worlds.json --out shaders/ [--check]
//
// worlds.json: { "<name>": { "isa": "z80", "world": { …WorldSpec… }, "mode"?: "kernel" | "library",
//                            "workgroupSize"?: 64, "variant"?: …, "compat"?: …, "bindingNames"?: {…} }, … }
// --check writes nothing and exits 1 unless every file on disk equals what would be written (for CI).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const Z = await import(pathToFileURL(join(root, "dist/index.js")).href);
const CORES = { z80: Z.z80 }; // skeleton cores are deliberately not exportable

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : ".";
const check = args.includes("--check");
if (!file) {
  console.error("usage: node scripts/export-machines.mjs worlds.json --out <dir> [--check]");
  process.exit(2);
}
const specs = JSON.parse(readFileSync(file, "utf8"));
if (!check) mkdirSync(out, { recursive: true });
let stale = 0;
for (const [name, s] of Object.entries(specs)) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid machine name '${name}'`);
  const isa = CORES[s.isa ?? "z80"];
  if (!isa) throw new Error(`${name}: unknown isa '${s.isa}' (known: ${Object.keys(CORES).join(", ")})`);
  const m = Z.buildMachine({ ...s, isa });
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
