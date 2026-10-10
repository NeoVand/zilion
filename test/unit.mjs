#!/usr/bin/env node
// Unit tests that need no GPU. Run after `npm run build`:  node test/unit.mjs
// Address math (hand-computed values), the hash mirror, SHA-256, buildMachine validation, the "generality costs
// nothing" rule (unused hooks are not emitted), manifest invariants, ISA neutrality of the world layer, and the
// engine's chunk planner.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Z from "../dist/index.js";
import { m6502 } from "../dist/cores/m6502/index.js";
import { bff } from "../dist/cores/bff/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
function eq(a, b, what = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function throws(fn, re) {
  try {
    fn();
  } catch (e) {
    if (re && !re.test(String(e.message))) throw new Error(`threw ${JSON.stringify(e.message)}, expected ${re}`);
    return;
  }
  throw new Error(`did not throw (expected ${re})`);
}
const ring = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, ...extra });
const build = (world, extra = {}) => Z.buildMachine({ isa: Z.z80, world, ...extra });

// --- address math (values worked out by hand; see test/world/cases.mjs) -------------------------------------
test("highestAlias: P | 65536 gives 0xFFFF; P = 38, 40, 100 give 0xFFE7, 0xFFEF, 0xFFDB", () => {
  eq(Z.highestAlias(31, 32), 0xffff);
  eq(Z.highestAlias(255, 256), 0xffff);
  eq(Z.highestAlias(37, 38), 0xffe7);
  eq(Z.highestAlias(39, 40), 0xffef);
  eq(Z.highestAlias(99, 100), 0xffdb);
  eq(Z.highestAlias(31, 33), 0xffdf);
  eq(Z.highestAlias(71, 75), 0xffbf);
  eq(Z.highestAlias(5, 40), 0xfff5);
  for (const P of [1, 2, 3, 33, 37, 75, 79, 100, 4096, 65536]) {
    for (const t of [0, P - 1, Math.floor(P / 2)]) {
      const a = Z.highestAlias(t, P);
      if (a % P !== t || a > 0xffff || a + P <= 0xffff) throw new Error(`highestAlias(${t}, ${P}) = ${a} is not the highest alias`);
    }
  }
  throws(() => Z.highestAlias(40, 40), /not on a ring/);
  throws(() => Z.highestAlias(70000, 100000), /unreachable/);
});
test("seamOffset = 65536 mod P; ringPos masks to 16 bits first", () => {
  eq([32, 33, 38, 40, 100, 256].map((P) => Z.seamOffset(P)), [0, 31, 24, 16, 36, 0]);
  eq(Z.ringPos(0x10001, 40), 1);
  eq(Z.ringPos(0xffff, 40), 15);
  eq(Z.ringPos(-1, 40), 15);
  eq(Z.ringPos(0xffff, 40, 32), 65535 % 40);
  eq(Z.ringPos(77, 33, 0), 11);
});

// --- hash ---------------------------------------------------------------------------------------------------
test("zil_hash with salt 0 is Algocell's BFF hash32(p*0x9E3779B1 ^ (s+1)*0x85EBCA77 ^ seed)", () => {
  // hash32 from experiments/micro/bff.py, transcribed: h = x*0x9E3779B9; h ^= h>>16; h *= 0x85EBCA6B; h ^= h>>13;
  // h *= 0xC2B2AE35; h ^= h>>16 (all mod 2^32).
  const M = 2n ** 32n;
  const hash32 = (x) => {
    let h = (BigInt(x) * 0x9e3779b9n) % M;
    h ^= h >> 16n;
    h = (h * 0x85ebca6bn) % M;
    h ^= h >> 13n;
    h = (h * 0xc2b2ae35n) % M;
    h ^= h >> 16n;
    return Number(h);
  };
  for (const [p, s, seed] of [[0, 0, 0], [1, 0, 1], [12345, 8191, 0xdeadbeef], [0xffffffff, 0xffffffff, 7]]) {
    const x = Number(((BigInt(p) * 0x9e3779b1n) % M) ^ ((BigInt(s + 1) * 0x85ebca77n) % M) ^ BigInt(seed));
    eq(Z.zilHash(seed, p, s, 0), hash32(x >>> 0), `p=${p} s=${s}`);
  }
  eq(Z.zilMix32(0), 0);
  eq(Z.dialThreshold(0), 0);
  eq(Z.dialThreshold(1), 0xffffffff);
  eq(Z.dialThreshold(0.5), 0x80000000);
  eq(Z.dialThreshold(0.03), Math.round(0.03 * 2 ** 32));
});
test("sha256 matches node:crypto", () => {
  for (const t of ["", "abc", "x".repeat(1000), "héllo ✓", Z.Z80_CORE_WGSL]) eq(Z.sha256(t), createHash("sha256").update(t).digest("hex"));
});

// --- generality costs nothing ---------------------------------------------------------------------------------
test("a plain world emits no v2 hook and calls none (the core is the 0.2 text)", () => {
  const m = build(ring(32));
  for (const f of ["fn on_fetch(", "fn on_instruction_start(", "fn zil_trap(", "fn io_in(", "fn io_out("]) {
    if (m.wgsl.includes(f)) throw new Error(`emitted ${f}`);
  }
  if (!m.wgsl.includes(Z.Z80_CORE_WGSL)) throw new Error("the core text is not the 0.2 core");
  eq(m.manifest.core.hooks, []);
});
test("each feature enables exactly the hook it needs", () => {
  eq(build(ring(32, { outputs: { fetchMap: true } })).manifest.core.hooks, ["fetch"]);
  eq(build(ring(32, { budget: { unit: "fetchBytes" } })).manifest.core.hooks, ["fetch"]);
  eq(build(ring(32, { outputs: { startMap: true } })).manifest.core.hooks, ["instructionStart"]);
  eq(build(ring(32, { halting: { lethal: { firstUnit: 0 } } })).manifest.core.hooks, ["instructionStart"]);
  eq(build(ring(32, { halting: { lethal: { firstUnit: 0, probability: 0 } } })).manifest.core.hooks, []);
  eq(build(ring(32, { halting: { traps: { "halt-insn": "halt" } } })).manifest.core.hooks, [], "as-chip policy");
  eq(build(ring(32, { halting: { traps: { "halt-insn": "ignore" } } })).manifest.core.hooks, ["trap"]);
  eq(build(ring(32, { hooks: { ioOut: "" } })).manifest.core.hooks, ["io"]);
  eq(build(ring(32, { ablation: { table: "uniform" } })).manifest.core.hooks, []);
});

// --- validation ----------------------------------------------------------------------------------------------
test("buildMachine rejects inconsistent worlds with a clear message", () => {
  throws(() => build({ memory: { kind: "mask", bytes: 48 } }), /power of two/);
  throws(() => build({ memory: { kind: "ring", bytes: 0 } }), /positive integer/);
  throws(() => build({ memory: { kind: "segments", segments: [{ bytes: 16 }, { bytes: 16 }], ring: 31 } }), /smaller than/);
  throws(() => build({ memory: { kind: "segments", segments: [{ bytes: 4, name: "padding" }] } }), /reserved/);
  throws(() => build(ring(32, { init: { state: "perLane", stack: { topAliases: 0 } } })), /excludes/);
  throws(() => build(ring(32, { init: { set: { a: 256 } } })), /does not fit/);
  throws(() => build(ring(32, { init: { set: { wz: 1 } } })), /no state field 'wz'/);
  throws(() => build(ring(32, { init: { stack: { topAliases: 32 } } })), /not on the ring/);
  throws(() => build(ring(32, { halting: { lethal: { firstUnit: 256 } } })), /firstUnit/);
  throws(() => build(ring(32, { halting: { lethal: { firstUnit: 0, probability: 1.5 } } })), /probability/);
  throws(() => build(ring(32, { halting: { traps: { unmatched: "halt" } } })), /never raises trap 'unmatched'/);
  throws(() => build(ring(32, { halting: { traps: { "halt-insn": "vector" } } })), /no vector/);
  throws(() => build(ring(32, { ablation: { table: "uniform", layout: "nope" } })), /no decode layout/);
  throws(() => build(ring(32, { ablation: { expr: "  " } })), /non-empty/);
  throws(() => build(ring(32, { budget: { value: -1 } })), /u32/);
  throws(() => build(ring(32), { compat: "0.3" }), /compat/);
  throws(() => build(ring(32), { variant: "zilog-nmos" }), /variant/);
  throws(() => build(ring(32), { bindingNames: { memory: "x" } }), /library mode only/);
  throws(() => build(ring(32, { ablation: { table: "uniform" } }), { mode: "library" }), /bindingNames.ablation/);
});

// --- manifest ------------------------------------------------------------------------------------------------
test("manifest: record layout is contiguous and matches the outputs; hashes are reproducible", () => {
  const w = { memory: { kind: "segments", segments: [{ bytes: 19 }, { bytes: 19 }], ring: 41 },
    outputs: { writeCounts: true, fetchMap: true, startMap: true }, ablation: { table: "uniform" } };
  const a = build(w);
  const b = build(JSON.parse(JSON.stringify(w)));
  eq(a.wgsl, b.wgsl, "deterministic");
  eq(a.manifest.sha256, b.manifest.sha256);
  eq(a.manifest.sha256.wgsl, Z.sha256(a.wgsl));
  let o = 0;
  for (const f of a.manifest.record.fields) {
    eq(f.offset, o, f.name);
    o += f.words;
  }
  eq(o, a.manifest.record.wordsPerLane);
  eq(a.manifest.record.fields.map((f) => f.name), ["steps", "haltReason", "state", "writeCounts", "fetchMap", "startMap"]);
  eq(a.manifest.record.fields.find((f) => f.name === "writeCounts").items, ["s0", "s1", "padding"]);
  eq(a.manifest.memory.segments.map((s) => [s.position, s.storageWord, s.storageWords]), [[0, 0, 5], [19, 5, 5]]);
  eq(a.manifest.memory.padding, { from: 38, to: 41 });
  eq(a.manifest.memory.hostBytesPerLane, 38);
  eq(a.manifest.params.bytes, 16 + 6 * 16);
  eq(a.manifest.ablation.words, 24);
  if (!a.wgsl.startsWith(`// Generated by @neovand/zilion ${Z.ZILION_VERSION}`)) throw new Error("header");
  if (!a.wgsl.includes(a.manifest.sha256.world) || !a.wgsl.includes(a.manifest.sha256.core)) throw new Error("hashes not in the header");
  // key order does not change the world hash
  const reordered = { outputs: w.outputs, ablation: w.ablation, memory: w.memory };
  eq(build(reordered).manifest.sha256.world, a.manifest.sha256.world);
});
test("ZILION_VERSION equals package.json version", () => {
  eq(Z.ZILION_VERSION, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
});

// --- ISA neutrality ------------------------------------------------------------------------------------------
test("the world layer names no register, opcode or core function of any ISA", () => {
  const dir = join(root, "src/world");
  for (const f of readdirSync(dir)) {
    const code = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    for (const bad of [/\bcpu_\w+/, /\bz80_\w+/, /\bm6502_\w+/, /\bbff_\w+/, /\bon_fetch_opcode\b/]) {
      const m = code.match(bad);
      if (m) throw new Error(`${f} mentions ${m[0]}`);
    }
  }
});

// --- skeleton cores: the contract rejects what a core cannot do ---------------------------------------------------
test("skeletons: the builder refuses what a core cannot do, and accepts each core's own traps and pages", () => {
  throws(() => Z.buildMachine({ isa: bff, world: ring(32, { init: { stack: { topAliases: 0 } } }) }), /no hardware stack/);
  throws(() => Z.buildMachine({ isa: bff, world: ring(32, { hooks: { ioIn: "return 0u;" } }) }), /does not call the 'io' hook/);
  throws(() => Z.buildMachine({ isa: m6502, world: ring(32, { halting: { traps: { "halt-insn": "ignore" } } }) }), /never raises trap 'halt-insn'/);
  throws(() => Z.buildMachine({ isa: Z.z80, world: ring(32, { halting: { traps: { bounds: "ignore" } } }) }), /never raises trap 'bounds'/);
  throws(() => Z.buildMachine({ isa: m6502, world: ring(512, { init: { stack: { topAliases: 0 } } }) }), /no stack pointer/);
  eq(Z.buildMachine({ isa: bff, world: ring(32, { halting: { traps: { unmatched: { halt: { probability: 0.25 } } } } }) }).manifest.core.hooks, ["trap"]);
  eq(Z.buildMachine({ isa: m6502, world: ring(32, { ablation: { table: "uniform" } }) }).manifest.ablation.words, 8);
  eq(Z.buildMachine({ isa: bff, world: ring(32, { ablation: { table: "uniform" } }) }).manifest.ablation.words, 1);
  eq(m6502.conventions.stackTop(40, 39), { s: 0xdf });
  eq(m6502.conventions.stackTop(32, 20), { s: 0xf4 });
  for (const core of [m6502, bff]) {
    const w = Z.buildMachine({ isa: core, world: ring(33, { outputs: { fetchMap: true } }) }).wgsl;
    if (/\bcpu_|\bz80_/.test(w)) throw new Error(`${core.id}: a Z80 symbol leaked into the generated shader`);
  }
});

// --- engine chunk planner ---------------------------------------------------------------------------------------
test("chunk planner at the default limits: 4,194,240 lanes per dispatch, 524,288 lanes of 256 B per binding", () => {
  const L = Z.DEFAULT_LIMITS;
  eq(Z.maxLanesPerChunk({ workgroupSize: 64, bytesPerLane: [4, 48, 48], limits: L }), Math.floor(134217728 / 48 / 64) * 64);
  eq(Z.maxLanesPerChunk({ workgroupSize: 64, bytesPerLane: [4], limits: L }), 65535 * 64);
  eq(65535 * 64, 4194240);
  eq(Z.maxLanesPerChunk({ workgroupSize: 64, bytesPerLane: [256, 48, 48], limits: L }), 524288);
  eq(Z.maxLanesPerChunk({ workgroupSize: 64, bytesPerLane: [256], limits: L, maxLanes: 1000 }), 960);
  eq(Z.maxLanesPerChunk({ workgroupSize: 64, bytesPerLane: [256], limits: L, maxLanes: 10 }), 10);
  eq(Z.maxLanesPerChunk({ workgroupSize: 16, lanesPerInvocation: 4, bytesPerLane: [4], limits: L }), 65535 * 64);
  throws(() => Z.maxLanesPerChunk({ workgroupSize: 64, bytesPerLane: [2 ** 28], limits: L }), /does not fit/);
  eq(Z.planChunks(10, 4), [{ start: 0, count: 4 }, { start: 4, count: 4 }, { start: 8, count: 2 }]);
  eq(Z.planChunks(0, 4), []);
  eq(Z.planChunks(4194241, 4194240).length, 2);
});
test("host <-> storage packing follows the manifest segments (word-padded tapes)", () => {
  const m = build({ memory: { kind: "segments", segments: [{ bytes: 5 }, { bytes: 3 }], ring: 9 } }).manifest;
  const host = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18]);
  const st = Z.packMemory(m, host, 2);
  eq(m.memory.storageWordsPerLane, 3);
  eq(Array.from(new Uint8Array(st.buffer)), [1, 2, 3, 4, 5, 0, 0, 0, 6, 7, 8, 0, 11, 12, 13, 14, 15, 0, 0, 0, 16, 17, 18, 0]);
  eq(Array.from(Z.unpackMemory(m, st, 2)), Array.from(host));
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
