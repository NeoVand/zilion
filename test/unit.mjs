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
import { fakeCore } from "./world/fake_core.mjs";

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
// Worlds state their budget and (on a stack ISA) their stack; `ring` gives both (extra.init replaces the init),
// `bare` only the budget (for BFF, which has no stack).
const STEPS = { unit: "steps", value: 100 };
const LAST = { topAliases: "lastByte" };
const ring = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, budget: STEPS, init: { stack: LAST }, ...extra });
const bare = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, budget: STEPS, ...extra });
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
test("a plain world emits no v2 hook and calls none (the core is the hook-free text; compat '0.2': the 0.2.0 core)", () => {
  const m = build(ring(32));
  for (const f of ["fn on_fetch(", "fn on_instruction_start(", "fn zil_trap(", "fn io_in(", "fn io_out("]) {
    if (m.wgsl.includes(f)) throw new Error(`emitted ${f}`);
  }
  const code = Z.z80.wgsl({ hooks: {} }).replace(/\/\/[^\n]*/g, "");
  for (const f of ["on_fetch(", "on_instruction_start(", "zil_trap(", "io_in(", "io_out(", "ZIL_"]) {
    if (code.includes(f)) throw new Error(`the hook-free 0.3 core uses ${f}`);
  }
  if (!m.wgsl.includes(Z.z80.wgsl({ hooks: {} }))) throw new Error("the core text is not the hook-free core");
  eq(m.manifest.core.hooks, []);
  eq([m.manifest.core.compat, m.manifest.core.variant, m.manifest.core.coreVersion], ["0.3", "classic", "0.3.0"]);
  const m02 = build(ring(32), { compat: "0.2" });
  if (!m02.wgsl.includes(Z.Z80_CORE_WGSL)) throw new Error("the compat '0.2' core text is not the 0.2.0 core");
  eq(m02.manifest.core.compat, "0.2");
});
test("Z80 semantics: the state record per compat and variant; the core's halt reasons are the contract's", () => {
  const names = (o) => build(ring(32), o).manifest.state.map((f) => f.name);
  const r02 = names({ compat: "0.2" });
  eq(r02.length, 25);
  eq(names({}), [...r02, "wz", "im"]);
  eq(names({ variant: "zilog-nmos" }), [...r02, "wz", "im", "q"]);
  eq(Z.z80.state.map((f) => f.name), names({}));
  const text = Z.z80CoreText({}, { variant: "zilog-nmos" });
  for (const [k, v] of [["Z80_RUNNING", Z.HALT_REASONS.running], ["Z80_HALT_INSN", Z.HALT_REASONS["halt-insn"]],
    ["Z80_HALT_HOST", Z.HALT_REASONS.host], ["Z80_HALT_TRAP", Z.HALT_REASONS.trap]]) {
    if (!text.includes(`const ${k}: u32 = ${v}u;`)) throw new Error(`${k} is not ${v}`);
  }
  // the world reset zeroes the latches of the configuration (and only those)
  const w = build(ring(32), { variant: "zilog-nmos" }).wgsl;
  for (const x of ["cpu_wz = 0x0u;", "cpu_im = 0x0u;", "cpu_q = 0x0u;", "z80_qf = 0u;"]) if (!w.includes(x)) throw new Error(`zil_reset lacks ${x}`);
  if (build(ring(32), { compat: "0.2" }).wgsl.includes("cpu_wz")) throw new Error("compat '0.2' names cpu_wz");
  throws(() => Z.z80CoreText({}, { compat: "0.2", variant: "zilog-nmos" }), /needs compat '0.3'/);
  throws(() => Z.z80CoreText({}, { compat: "0.1" }), /unknown compat/);
});
test("each feature enables exactly the hook it needs", () => {
  eq(build(ring(32, { outputs: { fetchMap: true } })).manifest.core.hooks, ["fetch"]);
  eq(build(ring(32, { budget: { unit: "fetchBytes", value: 100 } })).manifest.core.hooks, ["fetch"]);
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
  throws(() => build(ring(32, { init: { stack: LAST, set: { a: 256 } } })), /does not fit/);
  throws(() => build(ring(32, { init: { stack: LAST, set: { wz: 1 } } }), { compat: "0.2" }), /no state field 'wz'/);
  throws(() => build(ring(32, { init: { stack: LAST, set: { q: 1 } } })), /no state field 'q'/);
  throws(() => build(ring(32, { init: { stack: { topAliases: 32 } } })), /not on the ring/);
  throws(() => build(ring(32, { halting: { lethal: { firstUnit: 256 } } })), /firstUnit/);
  throws(() => build(ring(32, { halting: { lethal: { firstUnit: 0, probability: 1.5 } } })), /probability/);
  throws(() => build(ring(32, { halting: { traps: { unmatched: "halt" } } })), /never raises trap 'unmatched'/);
  throws(() => build(ring(32, { halting: { traps: { "halt-insn": "vector" } } })), /no vector/);
  throws(() => build(ring(32, { ablation: { table: "uniform", layout: "nope" } })), /no decode layout/);
  throws(() => build(ring(32, { ablation: { expr: "  " } })), /non-empty/);
  throws(() => build(ring(32, { budget: { unit: "steps", value: -1 } })), /u32/);
  throws(() => build(ring(32), { compat: "0.1" }), /compat/);
  throws(() => build(ring(32), { variant: "zilog-cmos" }), /variant/);
  throws(() => build(ring(32), { compat: "0.2", variant: "zilog-nmos" }), /needs compat '0.3'/);
  throws(() => build(ring(32), { bindingNames: { memory: "x" } }), /library mode only/);
  throws(() => build(ring(32, { ablation: { table: "uniform" } }), { mode: "library" }), /bindingNames.ablation/);
});

test("user strings that reach WGSL are validated (review nit 8)", () => {
  throws(() => build({ memory: { kind: "segments", segments: [{ bytes: 4, name: "A\nfn x() {}" }] } }), /must be an identifier/);
  throws(() => build({ memory: { kind: "segments", segments: [{ bytes: 4, name: "a b" }] } }), /must be an identifier/);
  throws(() => build(ring(32), { mode: "library", bindingNames: { memory: "mem // x" } }), /must be an identifier/);
  throws(() => build(ring(32), { mode: "library", bindingNames: { out: "a.b" } }), /must be an identifier/);
  throws(() => build(ring(32, { ablation: { table: "uniform" } }), { mode: "library", bindingNames: { ablation: "params[0]" } }), /member access/);
  build(ring(32, { ablation: { table: "uniform" } }), { mode: "library", bindingNames: { ablation: "params.suppress", memory: "pair_data" } });
  const w = build(ring(32, { ablation: { expr: "op == 1u // one" } })).wgsl;
  if (!/\(\n\s+op == 1u \/\/ one\n\s+\)/.test(w)) throw new Error("the expression is not on its own line");
  if (!build(ring(32, { hooks: { ioIn: "  " } })).wgsl.includes("return 0u;")) throw new Error("an empty ioIn must default to return 0u");
});

// --- manifest ------------------------------------------------------------------------------------------------
test("manifest: record layout is contiguous and matches the outputs; hashes are reproducible", () => {
  const w = { memory: { kind: "segments", segments: [{ bytes: 19 }, { bytes: 19 }], ring: 41 }, budget: STEPS, init: { stack: LAST },
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
  eq(a.manifest.record.fields.map((f) => f.name), ["steps", "haltReason", "trapCause", "state", "writeCounts", "fetchMap", "startMap", "padding"]);
  eq(a.manifest.record.fields.find((f) => f.name === "trapCause").offset, 2);
  eq(a.manifest.record.fields.find((f) => f.name === "padding").words, 1); // 3 bytes of padding (38..40)
  eq(a.manifest.schema, "zilion.manifest/2");
  eq(a.manifest.trapCauses, Z.TRAP_CAUSES);
  eq(a.manifest.resumable, true);
  eq(a.manifest.record.fields.find((f) => f.name === "writeCounts").items, ["s0", "s1", "padding"]);
  eq(a.manifest.memory.segments.map((s) => [s.position, s.storageWord, s.storageWords]), [[0, 0, 5], [19, 5, 5]]);
  eq(a.manifest.memory.padding, { from: 38, to: 41 });
  eq(a.manifest.memory.hostBytesPerLane, 38);
  eq(a.manifest.params.bytes, 32 + 6 * 16);
  eq(a.manifest.params.fields.map((f) => [f.name, f.role, f.offset, f.words]), [["lane_count", "laneCount", 0, 1], ["lane_base", "laneBase", 4, 1],
    ["budget", "budget", 8, 1], ["seed", "seed", 12, 1], ["step_base", "stepBase", 16, 2], ["resume", "resume", 24, 1], ["_pad1", "pad", 28, 1],
    ["ablation", "ablation", 32, 24]]);
  eq(a.manifest.ablation.words, 24);
  if (!a.wgsl.startsWith(`// Generated by @neovand/zilion ${Z.ZILION_VERSION}`)) throw new Error("header");
  if (!a.wgsl.includes(a.manifest.sha256.world) || !a.wgsl.includes(a.manifest.sha256.core)) throw new Error("hashes not in the header");
  // key order does not change the world hash
  const reordered = { outputs: w.outputs, init: w.init, ablation: w.ablation, budget: w.budget, memory: w.memory };
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
  throws(() => Z.buildMachine({ isa: bff, world: bare(32, { init: { stack: { topAliases: 0 } } }) }), /no hardware stack/);
  throws(() => Z.buildMachine({ isa: bff, world: bare(32, { hooks: { ioIn: "return 0u;" } }) }), /does not call the 'io' hook/);
  throws(() => Z.buildMachine({ isa: m6502, world: ring(32, { halting: { traps: { "halt-insn": "ignore" } } }) }), /never raises trap 'halt-insn'/);
  throws(() => Z.buildMachine({ isa: Z.z80, world: ring(32, { halting: { traps: { bounds: "ignore" } } }) }), /never raises trap 'bounds'/);
  throws(() => Z.buildMachine({ isa: m6502, world: ring(512, { init: { stack: { topAliases: 0 } } }) }), /no stack pointer/);
  eq(Z.buildMachine({ isa: bff, world: bare(32, { halting: { traps: { unmatched: { halt: { probability: 0.25 } } } } }) }).manifest.core.hooks, ["trap"]);
  eq(Z.buildMachine({ isa: m6502, world: ring(32, { ablation: { table: "uniform" } }) }).manifest.ablation.words, 8);
  eq(Z.buildMachine({ isa: bff, world: bare(32, { ablation: { table: "uniform" } }) }).manifest.ablation.words, 1);
  eq(m6502.conventions.stackTop(40, 39), { s: 0xdf });
  eq(m6502.conventions.stackTop(32, 20), { s: 0xf4 });
  for (const core of [m6502, bff]) {
    const w = Z.buildMachine({ isa: core, world: (core === bff ? bare : ring)(33, { outputs: { fetchMap: true } }) }).wgsl;
    if (/\bcpu_|\bz80_/.test(w)) throw new Error(`${core.id}: a Z80 symbol leaked into the generated shader`);
  }
});

// --- decision 3: no implicit defaults for the stack and the budget ---------------------------------------------
test("no silent defaults: a world without budget (or its unit or value) or, on a stack ISA, without init.stack fails, naming the field", () => {
  const mem = { kind: "ring", bytes: 32 };
  throws(() => build({ memory: mem, init: { stack: LAST } }), /world\.budget is required/);
  throws(() => build({ memory: mem, init: { stack: LAST }, budget: { value: 10 } }), /world\.budget\.unit is required/);
  throws(() => build({ memory: mem, init: { stack: LAST }, budget: { unit: "steps" } }), /world\.budget\.value is required/);
  throws(() => build({ memory: mem, init: { stack: LAST }, budget: { unit: "steps", value: "lots" } }), /world\.budget\.value.*u32/);
  throws(() => build({ memory: mem, budget: STEPS }), /world\.init\.stack is required: z80 has a stack/);
  throws(() => build({ memory: mem, budget: STEPS, init: { set: { sp: 0x1234 } } }), /world\.init\.stack is required/);
  throws(() => Z.buildMachine({ isa: m6502, world: { memory: mem, budget: STEPS } }), /world\.init\.stack is required: m6502 has a stack/);
  // not required: per-lane state loads SP with everything else; BFF has no stack (and giving one is an error)
  build({ memory: mem, budget: STEPS, init: { state: "perLane" } });
  Z.buildMachine({ isa: bff, world: { memory: mem, budget: STEPS } });
  throws(() => Z.buildMachine({ isa: bff, world: { memory: mem, budget: STEPS, init: { stack: { firstPushAt: "lastByte" } } } }), /bff has no hardware stack/);
  // the budget a world states is the manifest's default; perLane has none
  eq(build(ring(32, { budget: { unit: "steps", value: 77 } })).manifest.budget, { unit: "steps", perLane: false, default: 77 });
  eq(build(ring(32, { budget: { unit: "fetchBytes", value: "perLane" } })).manifest.budget, { unit: "fetchBytes", perLane: true, default: null });
});
test("presets supply the stack and the budget explicitly: compat02World (0.2's Zilion.run world) and algocellPairWorld", () => {
  eq(Z.compat02World({ memBytes: 256, steps: 50 }), { memory: { kind: "mask", bytes: 256 }, init: { stack: { topAliases: "lastByte" } }, budget: { unit: "steps", value: 50 } });
  eq(Z.compat02World({ memBytes: 64, steps: 9, registers: "perLane" }).init, { state: "perLane" });
  // 0.2's default SP = 0xFFFF: the stack pointer aliases the last byte of a power-of-two memory
  if (!build(Z.compat02World({ memBytes: 256, steps: 1 }), { compat: "0.2" }).wgsl.includes("cpu_sp = 0xffffu;")) throw new Error("compat02: SP is not 0xFFFF");
  eq(Z.algocellPairWorld({ L: 16, P: 37, steps: 128 }), {
    memory: { kind: "segments", segments: [{ bytes: 16, name: "A" }, { bytes: 16, name: "B" }], ring: 37 },
    init: { stack: { topAliases: "lastByte" } }, budget: { unit: "steps", value: 128 }, outputs: { writeCounts: true } });
  if (!build(Z.algocellPairWorld({ L: 16, P: 37, steps: 128 })).wgsl.includes("cpu_sp = 0xfff1u;")) throw new Error("Algocell pair: SP0 is not 0xFFF1");
  throws(() => Z.compat02World({ memBytes: 48, steps: 1 }), /power of two/);
  throws(() => Z.algocellPairWorld({ L: 16, P: 31, steps: 1 }), /smaller than the pair/);
  eq(Z.presets.algocellPair, Z.algocellPairWorld);
});

// --- decision 1: init.stack.firstPushAt ---------------------------------------------------------------------------
test("init.stack.firstPushAt: the first pushed byte lands at t (Z80: SP - 1 aliases t; 6502: 0x0100|S aliases t), hand-computed", () => {
  // Z80: SP = highestAlias(t) + 1 (16-bit). ring 32, t = 31: 0xFFFF + 1 = 0x0000. ring 33, t = 32: (65535 - 32) mod 33
  // = 31, highest alias 0xFFE0, SP = 0xFFE1. pair [16,16] on 37, t = 31: 65504 mod 37 = 14, 0xFFF1 → SP = 0xFFF2.
  // ring 33, t = 30: 65535 mod 33 = 30, so the highest alias is 0xFFFF and SP = 0x0000 (the push wraps).
  eq(Z.z80.conventions.firstPushAt(32, 31), { sp: 0x0000 });
  eq(Z.z80.conventions.firstPushAt(33, 32), { sp: 0xffe1 });
  eq(Z.z80.conventions.firstPushAt(37, 31), { sp: 0xfff2 });
  eq(Z.z80.conventions.firstPushAt(33, 30), { sp: 0x0000 });
  // 6502: S = the largest value with (0x100 + S) mod P = t. 0x1FF mod 32 = 31 → 0xFF; 0x1EE = 494 = 14·33 + 32 → 0xEE;
  // 0x1DB = 475 = 12·37 + 31 → 0xDB.
  eq(m6502.conventions.firstPushAt(32, 31), { s: 0xff });
  eq(m6502.conventions.firstPushAt(33, 32), { s: 0xee });
  eq(m6502.conventions.firstPushAt(37, 31), { s: 0xdb });
  eq(bff.conventions.firstPushAt, null);
  // invariant over many rings: the address the first push writes aliases t
  for (const P of [1, 2, 3, 32, 33, 37, 40, 100, 255, 256]) {
    for (const t of new Set([0, P - 1, Math.floor(P / 2)])) {
      const sp = Z.z80.conventions.firstPushAt(P, t).sp;
      if (Z.ringPos((sp - 1) & 0xffff, P) !== t) throw new Error(`z80 P=${P} t=${t}: SP ${sp} pushes at ${Z.ringPos((sp - 1) & 0xffff, P)}`);
      const s = m6502.conventions.firstPushAt(P, t).s;
      if (Z.ringPos(0x100 | s, P) !== t) throw new Error(`6502 P=${P} t=${t}: S ${s}`);
    }
  }
  // the builder: both conventions, neither, an unknown key, a position off the ring
  throws(() => build(ring(32, { init: { stack: { firstPushAt: 3, topAliases: 3 } } })), /both firstPushAt and topAliases/);
  throws(() => build(ring(32, { init: { stack: {} } })), /needs firstPushAt or topAliases/);
  throws(() => build(ring(32, { init: { stack: { firstPushAT: 3 } } })), /unknown field\(s\) firstPushAT/);
  throws(() => build(ring(32, { init: { stack: { firstPushAt: 32 } } })), /not on the ring/);
  if (!build(ring(33, { init: { stack: { firstPushAt: "lastByte" } } })).wgsl.includes("cpu_sp = 0xffe1u; // first push lands at position 32 of 33")) {
    throw new Error("firstPushAt: SP0 not emitted");
  }
  // topAliases keeps its per-ISA meaning
  if (!build(ring(33, { init: { stack: { topAliases: "lastByte" } } })).wgsl.includes("cpu_sp = 0xffe0u;")) throw new Error("topAliases changed");
});

// --- decision 2: the trap cause in the record ----------------------------------------------------------------------
test("trapCause: a record word after haltReason, codes in the manifest, from each core's trapCause symbol", () => {
  for (const [core, world] of [[Z.z80, ring(32)], [m6502, ring(32)], [bff, bare(32)]]) {
    const m = Z.buildMachine({ isa: core, world: { ...world, outputs: { state: false, memory: false } } });
    eq(m.manifest.record.fields.map((f) => [f.name, f.offset]), [["steps", 0], ["haltReason", 1], ["trapCause", 2]], core.id);
    if (!m.wgsl.includes(`fn zil_trap_cause() -> u32 { return ${core.symbols.trapCause}; }`)) throw new Error(`${core.id}: zil_trap_cause`);
    if (!m.wgsl.includes("zil_out[o + 2u] = zil_trap_cause();")) throw new Error(`${core.id}: the record does not store it`);
  }
  eq(Z.legacyMachine(64).manifest.record.fields.map((f) => f.name), ["regs16"]); // the 0.2 record is unchanged
  eq(Z.z80.symbols.trapCause, "select(0u, ZIL_TRAP_HALT_INSN, cpu_halted == 1u)");
  // the skeletons report their trap field only while halted on a trap (a state load or init.set cannot fake one)
  eq(m6502.symbols.trapCause, "select(0u, m6502_trap, m6502_halted == ZIL_HALT_TRAP)");
  eq(bff.symbols.trapCause, "select(0u, bff_trap, bff_halted == ZIL_HALT_TRAP)");
  // descriptors are checked: every symbol, and both stack conventions functions or both null
  const { trapCause: _t, ...noCause } = Z.z80.symbols;
  throws(() => Z.buildMachine({ isa: { ...Z.z80, symbols: noCause }, world: ring(32) }), /symbols\.trapCause must be a WGSL expression/);
  throws(() => Z.buildMachine({ isa: { ...Z.z80, conventions: { ...Z.z80.conventions, firstPushAt: undefined } }, world: ring(32) }),
    /conventions\.firstPushAt must be a function, or null/);
  throws(() => Z.buildMachine({ isa: { ...Z.z80, conventions: { ...Z.z80.conventions, firstPushAt: null } }, world: ring(32) }),
    /must both be functions or both be null/);
  // every trap cause a skeleton raises sets its state field before halting (both with and without the trap hook)
  for (const [core, causes] of [[m6502, ["ILLEGAL", "UNIMPLEMENTED"]], [bff, ["BOUNDS", "UNIMPLEMENTED"]]]) {
    for (const trap of [false, true]) {
      const text = core.wgsl({ hooks: { trap } });
      for (const c of causes) if (!text.includes(`_trap = ZIL_TRAP_${c};`)) throw new Error(`${core.id} (trap hook ${trap}): ${c} does not set the cause`);
    }
  }
});

// --- decision 4: core params ----------------------------------------------------------------------------------------
test("core params (test-only fake core): validation, WGSL constants ahead of the core, manifest provenance", () => {
  const w = bare(4);
  const fb = (params, extra = {}) => Z.buildMachine({ core: { isa: fakeCore, params }, world: w, ...extra });
  const d = fb(undefined);
  eq(d.manifest.core.params, { scale: 1, skip_zero: false, mode: "add" });
  const m = fb({ scale: 3, mode: "xor", skip_zero: true });
  eq(m.manifest.core.params, { scale: 3, skip_zero: true, mode: "xor" });
  const consts = [
    "const ZIL_PARAM_SCALE: u32 = 3u;",
    "const ZIL_PARAM_SKIP_ZERO: bool = true;",
    "const ZIL_PARAM_MODE_ADD: u32 = 0u;",
    "const ZIL_PARAM_MODE_XOR: u32 = 1u;",
    "const ZIL_PARAM_MODE: u32 = 1u; // 'xor'",
  ];
  const at = consts.map((c) => m.wgsl.indexOf(c));
  if (at.some((i) => i < 0)) throw new Error(`missing constants: ${consts.filter((_, k) => at[k] < 0).join(" ")}`);
  if (!(Math.max(...at) < m.wgsl.indexOf("// === Core (L0)"))) throw new Error("the constants do not precede the core text");
  if (/var<uniform>[^;]*ZIL_PARAM|zil_params\.\w*(scale|mode)/.test(m.wgsl)) throw new Error("a param became a uniform");
  if (d.manifest.sha256.options === m.manifest.sha256.options) throw new Error("the options hash does not cover the params");
  eq(Z.coreParamConstant("skip_zero"), "ZIL_PARAM_SKIP_ZERO");
  eq(Z.coreParamConstant("mode", "xor"), "ZIL_PARAM_MODE_XOR");
  // errors: unknown name, wrong type, out of range, enum value not declared, params on a core that declares none
  throws(() => fb({ scal: 3 }), /fake has no param 'scal' \(params: scale, skip_zero, mode\)/);
  throws(() => fb({ scale: "3" }), /param 'scale' must be a u32/);
  throws(() => fb({ scale: 2 ** 32 }), /param 'scale' must be a u32/);
  throws(() => fb({ scale: 1.5 }), /param 'scale' must be a u32/);
  throws(() => fb({ skip_zero: 1 }), /param 'skip_zero' must be a boolean/);
  throws(() => fb({ mode: "sub" }), /param 'mode' must be one of 'add', 'xor'/);
  throws(() => fb({ mode: 1 }), /param 'mode' must be one of/);
  throws(() => fb([1, 2]), /core\.params must be an object/);
  throws(() => Z.buildMachine({ core: { isa: Z.z80, params: { q: true } }, world: ring(32) }), /z80 has no param 'q' \(it declares none\)/);
  // the two forms of the core are not mixed, and params never sit beside isa
  throws(() => Z.buildMachine({ isa: fakeCore, params: { scale: 2 }, world: w }), /go in core: \{ isa, params \}/);
  throws(() => Z.buildMachine({ core: { isa: fakeCore }, isa: fakeCore, world: w }), /not both/);
  throws(() => Z.buildMachine({ core: { isa: fakeCore }, compat: "test", world: w }), /not both/);
  eq(Z.buildMachine({ core: { isa: Z.z80, compat: "0.2" }, world: ring(32) }).wgsl, build(ring(32), { compat: "0.2" }).wgsl);
  // a core without params emits nothing and records {} (the Z80 0.2 world is unchanged)
  eq(build(ring(32)).manifest.core.params, {});
  if (build(ring(32)).wgsl.includes("ZIL_PARAM_")) throw new Error("a core without params emitted constants");
  // descriptor validation
  const bad = (params) => () => Z.buildMachine({ core: { isa: { ...fakeCore, params } }, world: w });
  throws(bad({ Scale: { type: "u32", default: 1 } }), /lower snake case/);
  throws(bad({ m: { type: "enum", default: "c", values: ["a", "b"] } }), /default of param 'm' must be one of/);
  throws(bad({ m: { type: "enum", default: "a", values: [] } }), /needs values/);
  throws(bad({ m: { type: "enum", default: "a", values: ["a", "a"] } }), /repeats a value/);
  throws(bad({ m: { type: "enum", default: "a_b", values: ["a_b"] }, m_a: { type: "enum", default: "b", values: ["b"] } }), /both emit ZIL_PARAM_M_A_B/);
  throws(bad({ k: { type: "float", default: 1 } }), /unknown type 'float'/);
});

// --- decision 5: the step base -------------------------------------------------------------------------------------
test("step base: zilDraw is zilHash below 2^32 steps, folds the high word into the seed above; stepBaseWords", () => {
  for (const [seed, lane, step, salt] of [[0, 0, 0, 0], [12345, 7, 99, 3], [0xdeadbeef, 1000, 0xffffffff, 7]]) {
    eq(Z.zilDraw(seed, lane, step, salt), Z.zilHash(seed, lane, step, salt));
    eq(Z.zilDraw(seed, lane, BigInt(step), salt), Z.zilHash(seed, lane, step, salt));
  }
  eq(Z.zilDraw(5, 3, 2n ** 32n + 9n, 1), Z.zilHash((5 ^ Z.zilMix32(1)) >>> 0, 3, 9, 1));
  if (Z.zilDraw(5, 3, 2n ** 32n + 9n) === Z.zilDraw(5, 3, 9)) throw new Error("the high word is ignored");
  throws(() => Z.zilDraw(0, 0, 2n ** 64n), /64-bit/);
  eq(Z.stepBaseWords(undefined), [0, 0]);
  eq(Z.stepBaseWords(2 ** 32 + 5), [5, 1]);
  eq(Z.stepBaseWords(2n ** 64n - 1n), [0xffffffff, 0xffffffff]);
  throws(() => Z.stepBaseWords(-1), /non-negative/);
  throws(() => Z.stepBaseWords(1.5), /non-negative/);
  throws(() => Z.stepBaseWords(2n ** 64n), /below 2\^64/);
  // every dial draws through zil_draw (the step base reaches every draw); raw hooks see zil_step and zil_step_hi
  const m = build(ring(32, { halting: { lethal: { firstUnit: 0, probability: 0.5, salt: 3 }, traps: { "halt-insn": { halt: { probability: 0.25, salt: 9 } } } } }));
  const code = m.wgsl.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  if (/zil_hash\(zil_seed, zil_lane, zil_step/.test(code)) throw new Error("a dial bypasses zil_draw");
  for (const t of ["zil_draw(0x3u) < 0x80000000u", "zil_draw(0x9u) < 0x40000000u", "fn zil_draw(salt: u32) -> u32 { return zil_hash(zil_seed ^ zil_mix32(zil_step_hi), zil_lane, zil_step, salt); }"]) {
    if (!m.wgsl.includes(t)) throw new Error(`missing: ${t}`);
  }
});
test("resumable machines: a steps budget, the state and the memory stored; the params carry stepBase and resume", () => {
  const roles = (m) => m.manifest.params.fields.map((f) => f.role);
  const r = build(ring(32));
  eq(r.manifest.resumable, true);
  eq(roles(r), ["laneCount", "laneBase", "budget", "seed", "stepBase", "resume", "pad"]);
  for (const [why, world] of [
    ["fetchBytes", ring(32, { budget: { unit: "fetchBytes", value: 10 } })],
    ["no state", ring(32, { outputs: { state: false } })],
    ["no memory", ring(32, { outputs: { memory: false } })],
  ]) {
    const m = build(world);
    eq(m.manifest.resumable, false, why);
    eq(roles(m), ["laneCount", "laneBase", "budget", "seed", "stepBase", "pad", "pad"], why);
    if (m.wgsl.includes("fn zil_resume(")) throw new Error(`${why}: zil_resume emitted`);
  }
  // padding rides in the record only when the machine is resumable
  // (steps, haltReason, trapCause, the state record (27 fields with compat '0.3', 25 with '0.2'), 3 write counters)
  eq(build({ ...Z.algocellPairWorld({ L: 16, P: 37, steps: 9 }) }).manifest.record.fields.at(-1), { name: "padding", offset: 33, words: 2 });
  eq(build({ ...Z.algocellPairWorld({ L: 16, P: 37, steps: 9 }) }, { compat: "0.2" }).manifest.record.fields.at(-1), { name: "padding", offset: 31, words: 2 });
  eq(build({ ...Z.algocellPairWorld({ L: 16, P: 37, steps: 9 }), outputs: { memory: false } }).manifest.record.fields.some((f) => f.name === "padding"), false);
  // raw hooks with private state of their own (Algocell's PCG streams) are not resumable; stateless helpers are
  eq(build(ring(32, { hooks: { declarations: "var<private> pcg: u32;\nfn draw() -> u32 { pcg = pcg * 3u; return pcg; }", onReset: "pcg = zil_lane;" } })).manifest.resumable, false);
  eq(build(ring(32, { hooks: { declarations: "fn twice(x: u32) -> u32 { return 2u * x; }" } })).manifest.resumable, true);
  // library mode: zil_resume exists when the host names memory and out
  const lib = (names) => build(ring(32), { mode: "library", bindingNames: names }).manifest;
  eq(lib({ memory: "m", out: "o" }).resumable, true);
  if (!lib({ memory: "m", out: "o" }).functions.includes("zil_resume(lane, seed, step_base: vec2<u32>, o)")) throw new Error("zil_resume not listed");
  eq(lib({ memory: "m" }).resumable, false);
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
  const m = build({ memory: { kind: "segments", segments: [{ bytes: 5 }, { bytes: 3 }], ring: 9 }, budget: STEPS, init: { stack: LAST } }).manifest;
  const host = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18]);
  const st = Z.packMemory(m, host, 2);
  eq(m.memory.storageWordsPerLane, 3);
  eq(Array.from(new Uint8Array(st.buffer)), [1, 2, 3, 4, 5, 0, 0, 0, 6, 7, 8, 0, 11, 12, 13, 14, 15, 0, 0, 0, 16, 17, 18, 0]);
  eq(Array.from(Z.unpackMemory(m, st, 2)), Array.from(host));
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
