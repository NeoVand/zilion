// Engine (L2) and 0.2-facade tests on a real WebGPU device (browser; open test/engine.html after `npm run build`).
// Results go to the page and to window.__zilionEngineTests.

import * as Z from "../dist/index.js";
import { runConformance } from "./conformance.js";

const results = [];
const state = { done: false, passed: 0, failed: 0, results };
window.__zilionEngineTests = state;

async function test(name, fn) {
  const t0 = performance.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note ?? "", ms: performance.now() - t0 });
    state.passed++;
  } catch (e) {
    results.push({ name, ok: false, note: String(e?.stack ?? e), ms: performance.now() - t0 });
    state.failed++;
  }
}
function assert(c, msg) {
  if (!c) throw new Error(msg);
}
function equalArrays(a, b, what) {
  assert(a.length === b.length, `${what}: length ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${what} differs at ${i}: ${a[i]} vs ${b[i]}`);
}
function randomBytes(n, seed) {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    out[i] = (z ^ (z >>> 16)) & 0xff;
  }
  return out;
}
/** A device whose reported limits are smaller, to force chunking with real dispatches. */
function limitedDevice(device, limits) {
  const lim = new Proxy(device.limits, { get: (t, k) => (k in limits ? limits[k] : t[k]) });
  return new Proxy(device, {
    get: (t, k) => {
      if (k === "limits") return lim;
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

const adapter = await navigator.gpu.requestAdapter();
const engine = await Z.createEngine();

await test("0.2 facade: the 17 conformance vectors + the parallel batch (test/conformance.js)", async () => {
  const rep = await runConformance();
  const bad = rep.results.filter((r) => !r.ok);
  assert(bad.length === 0 && rep.parallel.ok, `failed: ${bad.map((r) => `${r.name}: ${r.detail}`).join("; ")} parallel ${rep.parallel.ok}`);
  return `${rep.passed}/${rep.total}, ${rep.parallel.count} parallel in ${rep.parallel.ms.toFixed(1)} ms`;
});

await test("0.2 facade: chunked runs equal one dispatch (dispatch-bound: 3 workgroups; binding-bound: 16 KiB)", async () => {
  const dev = await adapter.requestDevice();
  const programs = Array.from({ length: 1000 }, (_, i) => randomBytes(256, i));
  const init = programs.map((_, i) => ({ af: i * 7, bc: i * 13, sp: 0xfff0 - i }));
  const a = await Z.Zilion.create({ device: dev });
  const ra = await a.run(programs, { steps: 128, init });
  const notes = [];
  for (const [label, limits, chunk] of [["dispatch", { maxComputeWorkgroupsPerDimension: 3 }, 192], ["binding", { maxStorageBufferBindingSize: 16384 }, 64]]) {
    const b = await Z.Zilion.create({ device: limitedDevice(dev, limits) });
    const per = Z.maxLanesPerChunk({ workgroupSize: 64, bytesPerLane: [256, 48, 48], limits: { ...Z.DEFAULT_LIMITS, ...limits } });
    assert(per === chunk, `${label}: planned ${per} lanes per chunk, expected ${chunk}`);
    const rb = await b.run(programs, { steps: 128, init });
    equalArrays(ra.memory, rb.memory, `${label}: memory`);
    equalArrays(ra.registers.map((r) => Object.values(r)).flat(), rb.registers.map((r) => Object.values(r)).flat(), `${label}: registers`);
    const rc = await b.run(programs.slice(0, 10), { steps: 128, init }); // the reused buffers serve a smaller batch
    equalArrays(rc.memory, ra.memory.subarray(0, 2560), `${label}: memory after reuse`);
    notes.push(`${label}-bound: ${Math.ceil(1000 / chunk)} chunks of ${chunk}`);
    b.destroy();
  }
  a.destroy();
  dev.destroy();
  return notes.join("; ");
});

await test("0.2 facade: an invalid fetchHook rejects at create with the compiler's line", async () => {
  try {
    await Z.Zilion.create({ fetchHook: "op ==== 1u" });
  } catch (e) {
    assert(e instanceof Z.ZilionShaderError, `not a ZilionShaderError: ${e}`);
    assert(e.message.includes("op ==== 1u"), `message lacks the hook line: ${e.message}`);
    return e.message.split("\n")[1];
  }
  throw new Error("create did not reject");
});

await test("engine: typed results for the P=33 seam case (A=0xC3, PC=1, fetched {0,1,2,30})", async () => {
  const m = await engine.machine({ isa: Z.z80, world: { memory: { kind: "ring", bytes: 33 }, outputs: { fetchMap: true, startMap: true } } });
  const mem = new Uint8Array(33);
  mem.set([0xc3, 0xff, 0xff]);
  mem[30] = 0x3e;
  const r = await m.run(mem, { budget: 2 });
  const s = r.stateOf(0);
  assert(s.a === 0xc3 && s.pc === 1, `a=${s.a} pc=${s.pc}`);
  equalArrays(r.fetchedOf(0), [0, 1, 2, 30], "fetched");
  equalArrays(r.startsOf(0), [0, 30], "starts");
  assert(r.steps[0] === 2 && r.haltReasonOf(0) === "running", `steps ${r.steps[0]} halt ${r.haltReasonOf(0)}`);
  m.destroy();
});

await test("engine: chunking (333 and 1000 lanes per dispatch, lane base) is invisible, dials included", async () => {
  const world = { memory: { kind: "segments", segments: [{ bytes: 16 }, { bytes: 16 }], ring: 37 },
    init: { stack: { topAliases: "lastByte" }, random: { fields: ["ix", "iy", "a"] } },
    halting: { lethal: { firstUnit: 0, probability: 0.1 } }, outputs: { writeCounts: true, fetchMap: true } };
  const m = await engine.machine({ isa: Z.z80, world });
  const input = randomBytes(5000 * 32, 5);
  const a = await m.run(input, { budget: 100, seed: 9 });
  const b = await m.run(input, { budget: 100, seed: 9, maxLanesPerChunk: 333 });
  const c = await m.run(input, { budget: 100, seed: 9, maxLanesPerChunk: 1000 });
  const d = await m.run(input.subarray(1000 * 32, 2000 * 32), { budget: 100, seed: 9, laneBase: 1000 });
  equalArrays(a.record, b.record, "records (333)");
  equalArrays(a.memory, b.memory, "memory (333)");
  equalArrays(a.record, c.record, "records (1000)");
  equalArrays(a.record.subarray(1000 * m.manifest.record.wordsPerLane, 2000 * m.manifest.record.wordsPerLane), d.record, "lane-base slice");
  const halted = a.haltReason.filter((h) => h === 2).length;
  m.destroy();
  return `${halted} of 5000 lanes halted by the dial`;
});

await test("engine: resident batch over 4 slabs; a second run continues from the resident memory", async () => {
  const world = { memory: { kind: "ring", bytes: 64 }, init: { stack: { topAliases: "lastByte" } }, outputs: { writeCounts: true } };
  const m = await engine.machine({ isa: Z.z80, world });
  const input = randomBytes(1000 * 64, 77);
  const once = await m.run(input, { budget: 64 });
  const twice = await m.run(once.memory, { budget: 64 });
  const batch = m.batch(1000, { maxLanesPerSlab: 300 });
  assert(batch.slabs.length === 4, `${batch.slabs.length} slabs`);
  batch.upload(input);
  const r1 = await batch.run({ budget: 64 });
  equalArrays(r1.record, once.record, "first run records");
  equalArrays(r1.memory, once.memory, "first run memory");
  const enc = engine.device.createCommandEncoder();
  batch.encode(enc, { budget: 64 });
  engine.device.queue.submit([enc.finish()]);
  const r2 = await batch.read();
  equalArrays(r2.record, twice.record, "second run records");
  equalArrays(r2.memory, twice.memory, "second run memory");
  batch.upload(input.subarray(0, 64 * 10), { lane: 295 }); // spans slabs 0 and 1
  const r3 = await batch.read({ lanes: 310 });
  equalArrays(r3.memory.subarray(295 * 64, 305 * 64), input.subarray(0, 640), "upload across a slab boundary");
  batch.destroy();
  m.destroy();
});

await test("engine: per-lane budgets and per-lane state", async () => {
  const m = await engine.machine({ isa: Z.z80, world: { memory: { kind: "ring", bytes: 32 }, budget: { value: "perLane" }, init: { state: "perLane" } } });
  const S = m.manifest.state.length;
  const st = new Uint32Array(4 * S);
  const kA = m.manifest.state.findIndex((f) => f.name === "a");
  for (let i = 0; i < 4; i++) st[i * S + kA] = 10 * i;
  const r = await m.run(new Uint8Array(4 * 32).fill(0x3c), { budget: Uint32Array.from([0, 1, 7, 31]), state: st });
  equalArrays([0, 1, 2, 3].map((i) => r.stateOf(i).a), [0, 11, 27, 61], "A = 10 i + budget");
  equalArrays(r.steps, [0, 1, 7, 31], "steps");
  m.destroy();
});

await test("engine: a world with a broken raw hook rejects with the offending line", async () => {
  try {
    await engine.machine({ isa: Z.z80, world: { memory: { kind: "ring", bytes: 32 }, ablation: { expr: "prefix === 0u" } } });
  } catch (e) {
    assert(e instanceof Z.ZilionShaderError, `not a ZilionShaderError: ${e}`);
    assert(e.message.includes("prefix === 0u") && e.messages.length > 0, e.message);
    return `${e.messages[0].line}:${e.messages[0].column} ${e.messages[0].message}`;
  }
  throw new Error("did not reject");
});

await test("0.2 facade = engine mask world with per-lane state (2048 random programs, random registers)", async () => {
  const z = await Z.Zilion.create({ memBytes: 64, device: engine.device });
  const m = await engine.machine({ isa: Z.z80, world: { memory: { kind: "mask", bytes: 64 }, init: { state: "perLane" } } });
  const n = 2048;
  const progs = Array.from({ length: n }, (_, i) => randomBytes(64, 1000 + i));
  const rnd = randomBytes(n * 24, 3);
  const w = (i, k) => rnd[i * 24 + 2 * k] | (rnd[i * 24 + 2 * k + 1] << 8);
  const init = progs.map((_, i) => Object.fromEntries(Z.REG_FIELDS.map((f, k) => [f, w(i, k)])));
  const legacy = await z.run(progs, { steps: 100, init });
  const S = m.manifest.state.length;
  const idx = (name) => m.manifest.state.findIndex((f) => f.name === name);
  const st = new Uint32Array(n * S);
  init.forEach((r, i) => {
    const set = (name, v) => (st[i * S + idx(name)] = v);
    set("a", r.af >> 8); set("f", r.af & 255); set("b", r.bc >> 8); set("c", r.bc & 255);
    set("d", r.de >> 8); set("e", r.de & 255); set("h", r.hl >> 8); set("l", r.hl & 255);
    set("ix", r.ix); set("iy", r.iy); set("sp", r.sp); set("pc", r.pc);
    set("a_", r.afPrime >> 8); set("f_", r.afPrime & 255); set("b_", r.bcPrime >> 8); set("c_", r.bcPrime & 255);
    set("d_", r.dePrime >> 8); set("e_", r.dePrime & 255); set("h_", r.hlPrime >> 8); set("l_", r.hlPrime & 255);
  });
  const world = await m.run(progs, { budget: 100, state: st });
  equalArrays(legacy.memory, world.memory, "memory");
  for (let i = 0; i < n; i++) {
    const s = world.stateOf(i);
    const r = legacy.registers[i];
    const pairs = [[r.af, (s.a << 8) | s.f], [r.bc, (s.b << 8) | s.c], [r.de, (s.d << 8) | s.e], [r.hl, (s.h << 8) | s.l],
      [r.ix, s.ix], [r.iy, s.iy], [r.sp, s.sp], [r.pc, s.pc], [r.afPrime, (s.a_ << 8) | s.f_], [r.bcPrime, (s.b_ << 8) | s.c_],
      [r.dePrime, (s.d_ << 8) | s.e_], [r.hlPrime, (s.h_ << 8) | s.l_]];
    pairs.forEach(([x, y], k) => assert(x === y, `program ${i}, ${Z.REG_FIELDS[k]}: ${x} vs ${y}`));
  }
  z.destroy();
  m.destroy();
  return `${n} programs identical`;
});

state.done = true;
const out = document.getElementById("out");
out.innerHTML = results
  .map((r) => `<span class="${r.ok ? "pass" : "fail"}">${r.ok ? "PASS" : "FAIL"}</span>  ${r.name} (${r.ms.toFixed(0)} ms)${r.note ? `\n        ${r.note.replace(/</g, "&lt;")}` : ""}`)
  .join("\n") + `\n\n${state.passed} passed, ${state.failed} failed`;
