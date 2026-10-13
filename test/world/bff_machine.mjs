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
// test checks (docs/ARCHITECTURE.md, "The BFF core"):
//   - the pair: segments A and B of 64 bytes on a ring of 128 (no padding), entry 0, a steps budget = bff.py steps;
//   - ip_wrap   → halting.traps.bounds = 'ignore' (the published rule is the as-chip halt);
//   - nohalt    → halting.traps.unmatched = 'ignore';
//     halt_p    → bff.py's halt_q = round(halt_p · 2^32) with Python's rounding (half to even); halt_q >= 0xFFFFFFFF
//                 (bff.py's "always") keeps the as-chip halt, otherwise halting.traps.unmatched =
//                 { halt: { probability: halt_q / 2^32 } } (the world dial, salt 0; seed = roll_seed), whose
//                 threshold round(p · 2^32) is then exactly halt_q;
//   - alphabet, literal, lit_rep → the core params of the same names, after normalising the selections bff.py
//     accepts but the core refuses as silent no-ops, into their equivalents: without `literal`, op-11 bytes are
//     no-ops (mapped to 0) and lit_rep is irrelevant (1); with `literal` but no op-11 byte the switch never runs
//     (literal off, lit_rep 1); op ids above 11 are no-ops in bff.py's switch (mapped to 0);
//   - outputs: memory, state, writeCounts (writesB = segment B), startMap (entered, max_pc) and fetchMap.
// `salt` and `mutate` exist only for the negative controls (a wrong dial salt; a mutated core text).
// `probe` builds the dial-hash probe instead: a 4-byte ring, one step, a raw on_instruction_start hook that writes
// zil_draw(0) into the four bytes (so the host reads the world's draw for any lane, seed and step base).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Z from "../../dist/index.js";
import { bff } from "../../dist/cores/bff/index.js";

/** bff.py's halt_q: Python's round() (half to even) of halt_p · 2^32, or 0xFFFFFFFF ("always") for halt_p >= 1. */
export function bffHaltQ(p) {
  if (!(typeof p === "number" && p >= 0)) throw new Error(`halt_p ${p}: bff.py cannot hold a negative halt_q`);
  if (p >= 1) return 0xffffffff;
  const x = p * 4294967296; // exact: a power-of-two scaling
  const k = Math.floor(x);
  const f = x - k;
  return f > 0.5 ? k + 1 : f < 0.5 ? k : k % 2 === 0 ? k : k + 1;
}

/** The core params for bff.py's alphabet, literal and lit_rep (normalised; see above). */
export function bffParams(c) {
  let alphabet = Array.from(c.alphabet, (v) => (v > 11 ? 0 : v));
  let literal = !!c.literal;
  let lit_rep = c.lit_rep ?? 1;
  if (!literal) {
    alphabet = alphabet.map((v) => (v === 11 ? 0 : v));
    lit_rep = 1;
  } else if (!alphabet.includes(11)) {
    literal = false;
    lit_rep = 1;
  }
  return { alphabet, literal, lit_rep };
}

export function bffWorld(c) {
  const traps = {};
  if (c.ip_wrap) traps.bounds = "ignore";
  if (c.nohalt) traps.unmatched = "ignore";
  else {
    const q = bffHaltQ(c.halt_p ?? 1);
    if (q < 0xffffffff) traps.unmatched = { halt: { probability: q / 4294967296, ...(c.salt !== undefined ? { salt: c.salt } : {}) } };
  }
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
    core: { isa: bff, params: bffParams(c) },
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
