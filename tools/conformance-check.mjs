#!/usr/bin/env node
// Apply the unchanged check functions of test/conformance.js to results that
// the headless harness produced on the GPU (tools/zt.py conformance).
//
// Usage: node tools/conformance-check.mjs <plan.json> <results.json>
// Prints one JSON report on stdout: { total, passed, results[], parallel }.
// Exit code: 0 when every vector and the parallel batch pass, 1 otherwise.
//
// results.json: { vectors: [{ index, regs: [12 x u32 in REG_FIELDS order], mem: [memBytes x u8] }],
//                 parallel: { regs: [count x [12 x u32]], ms } }

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [planPath, resultsPath] = process.argv.slice(2);
if (!planPath || !resultsPath) {
  console.error("usage: node tools/conformance-check.mjs <plan.json> <results.json>");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const results = JSON.parse(readFileSync(resultsPath, "utf8"));
const { VECTORS, PARALLEL } = await import(
  pathToFileURL(join(root, "test", "conformance.js")).href
);

if (plan.vectors.length !== VECTORS.length) {
  throw new Error(`plan has ${plan.vectors.length} vectors, test/conformance.js has ${VECTORS.length}: re-run tools/build-wgsl.mjs`);
}
// Same object shape as Zilion.run's `registers[i]` (REG_FIELDS order, 16-bit values).
const toRegs = (words) =>
  Object.fromEntries(plan.regFields.map((f, i) => [f, words[i] >>> 0]));

const out = [];
for (const r of results.vectors) {
  const v = VECTORS[r.index];
  if (v.name !== plan.vectors[r.index].name) throw new Error(`vector ${r.index} renamed since the plan was emitted`);
  const detail = v.check(toRegs(r.regs), Uint8Array.from(r.mem));
  out.push({ name: v.name, ok: detail === null, detail: detail ?? "ok" });
}
const parallelOk = PARALLEL.check(results.parallel.regs.map(toRegs));
const passed = out.filter((x) => x.ok).length;
const report = {
  total: VECTORS.length,
  passed,
  results: out,
  parallel: { count: results.parallel.regs.length, ms: results.parallel.ms, ok: parallelOk },
};
process.stdout.write(JSON.stringify(report) + "\n");
process.exit(passed === VECTORS.length && out.length === VECTORS.length && parallelOk ? 0 : 1);
