#!/usr/bin/env node
// Recorded-output test for `compat: '0.2'` (design §5.5). Run after `npm run build`:
//
//   node test/world/compat02.mjs [--python <exe>] [--record] [--lanes N] [--compat <c>] [--variant <v>]
//
// 100,000 random programs on each of six Algocell-shaped worlds (a pair [L, L] on a ring of P = 2L bytes for
// P = 32, 38, 40, 64, 100, 128; stack top at the last byte; 128 steps; write counts) were run once through the
// 0.2.0 core and their outputs recorded in test/world/compat-0.2.0.json: a SHA-256 per chunk of 10,000 lanes over
// each lane's record words (steps, halt reason, state, write counts; little-endian u32) followed by its final
// memory, plus the full outputs of the first lanes of every world. This test rebuilds the same machines with
// `compat: '0.2'`, regenerates the programs (splitmix32, seeded per world; the data file pins the generator's
// first outputs) and requires every digest to match. The recording was made from a build whose world shaders embed
// the published 0.2.0 core text verbatim (checked here too: SHA-256 of the core text and its presence in each
// shader).
//
// --record rewrites the data file. Do that only from a build whose compat '0.2' core is the 0.2.0 core; the
// recording is not meant to follow later changes (that is the point of the test). --compat / --variant run the same
// check on another semantics, as a negative control (compat '0.3' must fail: its BIT n,(HL) flags and wasted-prefix
// R differ); the state fields compared are always the recorded ones, taken by name.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Z from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const python = opt("--python", process.env.ZILION_PYTHON ?? "python3");
const record = args.includes("--record");
const compat = opt("--compat", "0.2");
const variant = opt("--variant", undefined);
if (record && (compat !== "0.2" || variant)) throw new Error("--record needs compat '0.2'");
const DATA = join(here, "compat-0.2.0.json");

/** SHA-256 of the 0.2.0 core text (Z80_CORE_WGSL of the published @neovand/zilion 0.2.0). */
const CORE_0_2_0_SHA256 = "8db4015dab560cd075b2f4da7de78b6cc5e2b120034bfbf62590eb49784b2955";
const WORLDS = [[16, 32], [19, 38], [20, 40], [32, 64], [50, 100], [64, 128]];
const LANES = +opt("--lanes", "100000"); // fewer (a multiple of CHUNK) checks a prefix of the recording
const CHUNK = 10000;
const BUDGET = 128;
const SAMPLE = 4;

const HALT_NAMES = Z.HALT_REASONS;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** splitmix32: s += 0x9E3779B9; z = s; z = (z ^ z >>> 16) * 0x85EBCA6B; z = (z ^ z >>> 13) * 0xC2B2AE35; z ^ z >>> 16. */
function splitmix32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}
/** n random bytes: each draw gives four bytes, least significant first. */
function programs(seed, n) {
  const next = splitmix32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 4) {
    const w = next();
    for (let k = 0; k < 4 && i + k < n; k++) out[i + k] = (w >>> (8 * k)) & 0xff;
  }
  return out;
}
const seedOf = (P) => (0x5eed0000 + P) >>> 0;
const firstDraws = (seed) => { const g = splitmix32(seed); return [g(), g(), g(), g()]; };

const world = (L, P) => ({
  memory: { kind: "segments", segments: [{ bytes: L, name: "A" }, { bytes: L, name: "B" }], ring: P },
  init: { stack: { topAliases: "lastByte" } },
  budget: { unit: "steps", value: BUDGET },
  outputs: { writeCounts: true },
});

if (sha256(Z.Z80_CORE_WGSL) !== CORE_0_2_0_SHA256) {
  console.log(`FAIL  Z80_CORE_WGSL is not the 0.2.0 core (sha256 ${sha256(Z.Z80_CORE_WGSL)})`);
  process.exit(1);
}

const want = record ? null : JSON.parse(readFileSync(DATA, "utf8"));
const dir = mkdtempSync(join(tmpdir(), "zilion-compat02-"));
const jobs = WORLDS.map(([L, P], i) => {
  const m = Z.buildMachine({ isa: Z.z80, compat, ...(variant ? { variant } : {}), world: world(L, P) });
  if (compat === "0.2" && !m.wgsl.includes(Z.Z80_CORE_WGSL)) throw new Error(`P=${P}: the compat '0.2' shader does not embed the 0.2.0 core verbatim`);
  writeFileSync(join(dir, `m${i}.wgsl`), m.wgsl);
  writeFileSync(join(dir, `m${i}.manifest.json`), JSON.stringify(m.manifest));
  writeFileSync(join(dir, `j${i}.in`), programs(seedOf(P), LANES * 2 * L));
  return { id: `j${i}`, wgsl: `m${i}.wgsl`, manifest: `m${i}.manifest.json`, lanes: LANES, input: `j${i}.in`, seed: 0,
    budget: BUDGET, ablation: null, chunk: null, lane_base: 0, out_memory: `j${i}.mem`, out_record: `j${i}.rec`,
    L, P, recordWords: m.manifest.record.wordsPerLane, recordFields: m.manifest.record.fields };
});
writeFileSync(join(dir, "plan.json"), JSON.stringify({ jobs }));
const t0 = Date.now();
const py = spawnSync(python, [join(here, "gpu_runner.py"), join(dir, "plan.json")], { encoding: "utf8" });
if (py.status !== 0) {
  console.error(py.stdout, py.stderr);
  rmSync(dir, { recursive: true, force: true });
  console.error(`gpu_runner failed (python: ${python})`);
  process.exit(2);
}
process.stderr.write(py.stderr);

// The digested words, by name, so that record fields added later (a trap cause, say) do not change the digest:
// steps, haltReason, every state field of the 0.2 record in its order (when verifying: the recorded items, by name),
// the write counters.
const RECORDED = ["steps", "haltReason", "state", "writeCounts"];
const results = jobs.map((j) => {
  const mem = new Uint8Array(readFileSync(join(dir, j.out_memory)));
  const recBuf = readFileSync(join(dir, j.out_record));
  const rec = new Uint32Array(recBuf.buffer, recBuf.byteOffset, recBuf.byteLength / 4);
  const H = 2 * j.L;
  const R = j.recordWords;
  const recorded = want?.worlds.find((w) => w.P === j.P && w.L === j.L)?.recordFields;
  const layout = RECORDED.map((n) => {
    const f = j.recordFields.find((x) => x.name === n);
    if (!f) throw new Error(`P=${j.P}: the record has no field '${n}'`);
    const items = recorded?.find((x) => x.name === n)?.items ?? f.items;
    const idx = items
      ? items.map((it) => { const k = f.items.indexOf(it); if (k < 0) throw new Error(`P=${j.P}: record field ${n} has no item '${it}'`); return k; })
      : Array.from({ length: f.words }, (_, k) => k);
    return { name: n, offset: f.offset, idx, words: idx.length, items };
  });
  const lane = (i) => {
    const r = rec.subarray(i * R, (i + 1) * R);
    return { record: Uint32Array.from(layout.flatMap((f) => f.idx.map((k) => r[f.offset + k]))),
      memory: mem.subarray(i * H, (i + 1) * H) };
  };
  const digests = [];
  const halts = {};
  for (let c = 0; c < LANES; c += CHUNK) {
    const h = createHash("sha256");
    for (let i = c; i < Math.min(LANES, c + CHUNK); i++) {
      const { record, memory } = lane(i);
      h.update(Buffer.from(record.buffer, record.byteOffset, record.byteLength));
      h.update(memory);
      const k = Object.keys(HALT_NAMES).find((n) => HALT_NAMES[n] === record[1]) ?? String(record[1]);
      halts[k] = (halts[k] ?? 0) + 1;
    }
    digests.push(h.digest("hex"));
  }
  const sample = Array.from({ length: Math.min(SAMPLE, LANES) }, (_, i) => {
    const { record, memory } = lane(i);
    return { lane: i, record: Array.from(record), memory: Buffer.from(memory).toString("hex") };
  });
  return { L: j.L, P: j.P, seed: `0x${seedOf(j.P).toString(16)}`, firstDraws: firstDraws(seedOf(j.P)).map((w) => `0x${w.toString(16).padStart(8, "0")}`),
    lanes: LANES, chunk: CHUNK, recordFields: layout.map((f) => ({ name: f.name, words: f.words, ...(f.items ? { items: f.items } : {}) })),
    halts, digests, sample };
});
rmSync(dir, { recursive: true, force: true });

if (record) {
  const doc = {
    schema: 1,
    what: "Outputs of the 0.2.0 Z80 core (compat '0.2') on random programs; see test/world/compat02.mjs",
    recordedWith: { zilion: Z.ZILION_VERSION, coreSha256: CORE_0_2_0_SHA256, budget: BUDGET,
      programs: "splitmix32(seed) draws, 4 bytes each, least significant first; lane i holds bytes [i*2L, (i+1)*2L)",
      digest: "sha256 over each lane of the chunk: the record fields listed in recordFields, in that order (u32 LE), then the final memory (host layout)" },
    worlds: results,
  };
  writeFileSync(DATA, JSON.stringify(doc, null, 1) + "\n");
  console.log(`recorded ${WORLDS.length} worlds x ${LANES} lanes into ${DATA} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(0);
}

let fail = 0;
for (const r of results) {
  const w = want.worlds.find((x) => x.P === r.P && x.L === r.L);
  const errs = [];
  if (!w) errs.push("no recording for this world");
  else {
    if (JSON.stringify(w.firstDraws) !== JSON.stringify(r.firstDraws)) errs.push(`program generator differs: ${r.firstDraws} vs ${w.firstDraws}`);
    if (r.lanes > w.lanes || r.lanes % CHUNK !== 0) errs.push(`recorded ${w.lanes} lanes; --lanes must be a multiple of ${CHUNK} up to that (ran ${r.lanes})`);
    if (JSON.stringify(w.recordFields) !== JSON.stringify(r.recordFields)) errs.push(`record layout differs: ${JSON.stringify(r.recordFields)}`);
    const bad = r.digests.map((d, k) => (d === w.digests[k] ? -1 : k)).filter((k) => k >= 0);
    if (bad.length) errs.push(`${bad.length} of ${r.digests.length} chunks differ (first: lanes ${bad[0] * CHUNK}..${bad[0] * CHUNK + CHUNK - 1})`);
    r.sample.forEach((s, i) => {
      const ws = w.sample[i];
      if (ws && (JSON.stringify(ws.record) !== JSON.stringify(s.record) || ws.memory !== s.memory)) {
        errs.push(`lane ${s.lane}: record ${JSON.stringify(s.record)} memory ${s.memory} vs recorded ${JSON.stringify(ws.record)} ${ws.memory}`);
      }
    });
  }
  if (errs.length) {
    fail++;
    console.log(`  FAIL  P=${r.P} L=${r.L}`);
    for (const e of errs.slice(0, 6)) console.log(`          ${e}`);
  } else {
    console.log(`  ok    P=${r.P} L=${r.L}: ${r.lanes.toLocaleString("en")} programs, ${r.digests.length} chunk digests identical (halts ${JSON.stringify(r.halts)})`);
  }
}
console.log(fail === 0 ? `compat '${compat}'${variant ? ` ${variant}` : ""} reproduces the recorded 0.2.0 outputs (${WORLDS.length} worlds, ${((Date.now() - t0) / 1000).toFixed(1)} s)` : `${fail} world(s) FAILED`);
process.exit(fail === 0 ? 0 : 1);
