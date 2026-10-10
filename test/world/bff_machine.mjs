#!/usr/bin/env node
// Builds Zilion BFF machines for bff.py configurations (the machine-building half of test/world/bff_equiv.py).
// Run after `npm run build`:
//
//   node test/world/bff_machine.mjs <configs.json> <out dir>
//
// configs.json: [{ name, steps, ip_wrap, literal, nohalt, halt_p, lit_rep, alphabet: [256 op ids],
//                  salt?, mutate?: [[from, to], …], probe? }]
// writes <out dir>/<name>.wgsl and <name>.manifest.json for each.
//
// This file holds the whole mapping from bff.py's parameters onto a Zilion world, which is what the equivalence
// test checks (docs/ARCHITECTURE.md, "BFF"):
//   - the pair: segments A and B of 64 bytes on a ring of 128 (no padding), entry 0, a steps budget = bff.py steps;
//   - ip_wrap   → halting.traps.bounds = 'ignore' (the published rule is the as-chip halt);
//   - nohalt    → halting.traps.unmatched = 'ignore';
//     halt_p < 1 → halting.traps.unmatched = { halt: { probability: halt_p } } (the world dial, salt 0; seed = roll_seed);
//   - alphabet, literal, lit_rep → the core params of the same names;
//   - outputs: memory, state, writeCounts (writesB = segment B), startMap (entered, max_pc) and fetchMap.
// `salt` and `mutate` exist only for the negative controls (a wrong dial salt; a mutated core text).
// `probe` builds the dial-hash probe instead: a 4-byte ring, one step, a raw on_instruction_start hook that writes
// zil_draw(0) into the four bytes (so the host reads the world's draw for any lane, seed and step base).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Z from "../../dist/index.js";
import { bff } from "../../dist/cores/bff/index.js";

export function bffWorld(c) {
  const traps = {};
  if (c.ip_wrap) traps.bounds = "ignore";
  if (c.nohalt) traps.unmatched = "ignore";
  else if (c.halt_p < 1) traps.unmatched = { halt: { probability: c.halt_p, ...(c.salt !== undefined ? { salt: c.salt } : {}) } };
  return {
    memory: { kind: "segments", segments: [{ bytes: 64, name: "A" }, { bytes: 64, name: "B" }] },
    budget: { unit: "steps", value: c.steps },
    halting: { traps },
    outputs: { memory: true, state: true, writeCounts: true, startMap: true, fetchMap: true },
  };
}

export function buildBff(c) {
  if (c.probe) {
    return Z.buildMachine({
      core: { isa: bff },
      world: {
        memory: { kind: "ring", bytes: 4 },
        budget: { unit: "steps", value: 1 },
        outputs: { state: false },
        hooks: { onInstructionStart: "let d = zil_draw(0u);\nfor (var k = 0u; k < 4u; k++) { mem_write(k, d >> (8u * k)); }" },
      },
    });
  }
  const built = Z.buildMachine({
    core: { isa: bff, params: { alphabet: c.alphabet, literal: !!c.literal, lit_rep: c.lit_rep ?? 1 } },
    world: bffWorld(c),
  });
  let wgsl = built.wgsl;
  for (const [from, to] of c.mutate ?? []) {
    const n = wgsl.split(from).length - 1;
    if (n !== 1) throw new Error(`${c.name}: mutation anchor occurs ${n} times: ${JSON.stringify(from)}`);
    wgsl = wgsl.replace(from, to);
  }
  return { wgsl, manifest: built.manifest };
}

const [cfgPath, outDir] = process.argv.slice(2);
if (cfgPath && outDir) {
  const configs = JSON.parse(readFileSync(cfgPath, "utf8"));
  mkdirSync(outDir, { recursive: true });
  for (const c of configs) {
    const m = buildBff(c);
    writeFileSync(join(outDir, `${c.name}.wgsl`), m.wgsl);
    writeFileSync(join(outDir, `${c.name}.manifest.json`), JSON.stringify(m.manifest));
  }
}
