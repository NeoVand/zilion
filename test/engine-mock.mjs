#!/usr/bin/env node
// Engine lifecycle and ordering tests on a mock WebGPU device (no GPU). Run after `npm run build`:
//   node test/engine-mock.mjs
//
// The mock executes queue operations in the order they are issued (as a real queue does): writeBuffer copies at
// once, a submitted command buffer runs its copies and dispatches. A dispatch models a kernel: it adds 1 to every
// byte of the bound memory buffer (binding 1), then overwrites every u32 of the record buffer (binding 2) with the
// first memory byte, so resident memory accumulates dispatches and a snapshot shows how many preceded it. mapAsync resolves on a later macrotask. The mock counts live buffers and records
// any buffer larger than maxBufferSize or any use of a destroyed buffer.

import * as Z from "../dist/index.js";

globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUMapMode = { READ: 1, WRITE: 2 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

function mockDevice(limits = {}) {
  const stats = { live: 0, errors: [], maxSize: 0, dispatches: [] };
  const lim = { maxStorageBufferBindingSize: 134217728, maxBufferSize: 268435456, maxComputeWorkgroupsPerDimension: 65535, ...limits };
  let lost = false;
  const run = (ops) => {
    for (const op of ops) op();
  };
  const device = {
    limits: lim,
    stats,
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    pushErrorScope() {},
    popErrorScope: async () => null,
    createBindGroupLayout: (d) => ({ d }),
    createPipelineLayout: (d) => ({ d }),
    createComputePipelineAsync: async (d) => ({ d }),
    createBuffer({ size, label }) {
      if (size > lim.maxBufferSize) stats.errors.push(`buffer ${label} of ${size} bytes exceeds maxBufferSize ${lim.maxBufferSize}`);
      if (size % 4) stats.errors.push(`buffer ${label} size ${size} not a multiple of 4`);
      stats.live++;
      stats.maxSize = Math.max(stats.maxSize, size);
      const b = {
        size, label, destroyed: false, data: new Uint8Array(size), pending: false,
        async mapAsync(_mode, off = 0, sz = size - off) {
          if (b.pending) throw new Error(`mapAsync: ${label} already has a map pending`);
          b.pending = true;
          await new Promise((r) => setTimeout(r, 2));
          b.pending = false;
          if (b.destroyed || lost) throw new Error(`mapAsync on destroyed buffer ${label}`);
          if (off % 8 || sz % 4) stats.errors.push(`mapAsync misaligned ${off} ${sz}`);
        },
        getMappedRange: (off = 0, sz = size - off) => b.data.slice(off, off + sz).buffer,
        unmap() {},
        destroy() {
          if (!b.destroyed) stats.live--;
          b.destroyed = true;
        },
      };
      return b;
    },
    createBindGroup: (d) => ({ entries: d.entries }),
    createCommandEncoder: () => {
      const ops = [];
      return {
        beginComputePass: () => {
          let bg = null;
          return {
            setPipeline() {},
            setBindGroup(_i, g) { bg = g; },
            dispatchWorkgroups() {
              const g = bg;
              ops.push(() => {
                const buf = (k) => g.entries.find((e) => e.binding === k)?.resource.buffer;
                const mem = buf(1);
                const rec = buf(2);
                for (const x of [mem, rec]) if (x.destroyed) stats.errors.push(`dispatch uses destroyed ${x.label}`);
                // what the kernel would see: the params and the records it would resume from
                stats.dispatches.push({ params: new Uint32Array(buf(0).data.slice().buffer), recordIn: new Uint32Array(rec.data.slice().buffer) });
                for (let i = 0; i < mem.data.length; i++) mem.data[i] = (mem.data[i] + 1) & 0xff;
                new Uint32Array(rec.data.buffer).fill(mem.data[0]);
              });
            },
            end() {},
          };
        },
        copyBufferToBuffer(src, so, dst, doff, sz) {
          ops.push(() => {
            if (src.destroyed || dst.destroyed) stats.errors.push(`copy uses a destroyed buffer (${src.label} -> ${dst.label})`);
            dst.data.set(src.data.subarray(so, so + sz), doff);
          });
        },
        finish: () => ops,
      };
    },
    queue: {
      writeBuffer(b, off, data) {
        if (b.destroyed) stats.errors.push(`writeBuffer to destroyed ${b.label}`);
        b.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), off);
      },
      submit(cbs) {
        for (const ops of cbs) run(ops);
      },
    },
    destroy() {
      lost = true;
    },
  };
  return device;
}

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}\n          ${String(e.stack ?? e).split("\n").slice(0, 4).join("\n          ")}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const all = (arr, v, what) => assert(Array.from(arr).every((x) => x === v), `${what}: expected all ${v}, got ${Array.from(arr).slice(0, 8)}…`);
const clean = (dev) => assert(dev.stats.errors.length === 0, dev.stats.errors.join("; "));
const world = { memory: { kind: "ring", bytes: 32 }, budget: { unit: "steps", value: 10 }, init: { stack: { firstPushAt: "lastByte" } } };

await test("Batch.read() snapshots at call time: read, run, read → 1 and 2 dispatches (review bug 1)", async () => {
  const dev = mockDevice();
  const engine = await Z.createEngine({ device: dev });
  const m = await engine.machine({ isa: Z.z80, compat: "0.3", world });
  const b = m.batch(200, { maxLanesPerSlab: 64 }); // 4 slabs
  b.upload(new Uint8Array(200 * 32));
  const run = () => {
    const enc = dev.createCommandEncoder();
    b.encode(enc);
    dev.queue.submit([enc.finish()]);
  };
  run();
  const r1 = b.read();
  run();
  const r2 = b.read();
  const [a, c] = await Promise.all([r1, r2]);
  all(a.steps, 1, "first read");
  all(c.steps, 2, "second read");
  all(a.memory, 1, "first read memory");
  // a run's result is not affected by an upload issued right after it
  const p = b.run();
  b.upload(new Uint8Array(200 * 32).fill(0x50));
  const r = await p;
  all(r.steps, 3, "run then upload: steps");
  all(r.memory, 3, "run then upload: memory");
  all((await b.read()).memory, 0x50, "after the upload");
  b.destroy();
  assert(dev.stats.live === 0, `${dev.stats.live} buffers live after destroy`);
  clean(dev);
});

await test("0.2 facade: no GPU buffer outlives a run; overlapping runs; destroy() racing run() resolves (review risks 3, 4)", async () => {
  const dev = mockDevice();
  const z = await Z.Zilion.create({ memBytes: 16, device: dev });
  const progs = (n, v) => Array.from({ length: n }, () => new Array(16).fill(v));
  const r = await z.run(progs(100, 7), { steps: 5 });
  assert(dev.stats.live === 0, `${dev.stats.live} buffers live after run`);
  all(r.memory, 8, "memory after one dispatch");
  assert(r.registers.every((x) => x.af === 8 && x.hlPrime === 8), "the record of this run");
  const [a, b] = await Promise.all([z.run(progs(70, 1), { steps: 5 }), z.run(progs(90, 2), { steps: 5 })]);
  all(a.memory, 2, "overlapping run a");
  all(b.memory, 3, "overlapping run b");
  const p = z.run(progs(50, 9), { steps: 5 });
  z.destroy();
  const q = await p; // 0.2: a run called before destroy() completes (on a device the caller owns)
  all(q.memory, 10, "run racing destroy");
  let rejected = false;
  await z.run(progs(1, 0), { steps: 1 }).catch(() => (rejected = true));
  assert(rejected, "run after destroy must reject");
  assert(dev.stats.live === 0, `${dev.stats.live} buffers live at the end`);
  clean(dev);
});

await test("Machine: destroy() racing run() lets the run finish, then releases its buffers; later runs reject", async () => {
  const dev = mockDevice();
  const engine = await Z.createEngine({ device: dev });
  const m = await engine.machine({ isa: Z.z80, compat: "0.3", world });
  const p1 = m.run(new Uint8Array(300 * 32));
  const p2 = m.run(new Uint8Array(100 * 32));
  m.destroy();
  const [a, b] = await Promise.all([p1, p2]);
  all(a.steps, 1, "first run");
  all(b.steps, 1, "second run");
  let rejected = false;
  await m.run(new Uint8Array(32)).catch(() => (rejected = true));
  assert(rejected, "run after destroy must reject");
  await new Promise((r) => setTimeout(r, 10));
  assert(dev.stats.live === 0, `${dev.stats.live} buffers live after destroy`);
  clean(dev);
});

await test("staging buffers stay within maxBufferSize; chunks are planned for them (review risk 5)", async () => {
  // binding and buffer limit 4096 B; 256 B of memory and 32 + 4 words of record per lane: the bindings alone allow
  // 16 lanes, but the staging buffer (256 + 108 B per lane) allows 11.
  const limits = { maxStorageBufferBindingSize: 4096, maxBufferSize: 4096 };
  const per = Z.maxLanesPerChunk({ workgroupSize: 64, bytesPerLane: [256, 108], stagingBytesPerLane: 364, limits: { ...Z.DEFAULT_LIMITS, ...limits } });
  assert(per === 11, `planned ${per} lanes per chunk, expected 11`);
  const dev = mockDevice(limits);
  const engine = await Z.createEngine({ device: dev });
  const m = await engine.machine({ isa: Z.z80, compat: "0.3", world: { memory: { kind: "ring", bytes: 256 }, budget: { unit: "steps", value: 1 }, init: { stack: { topAliases: "lastByte" } } } });
  const r = await m.run(new Uint8Array(100 * 256));
  all(r.steps, 1, "steps");
  const z = await Z.Zilion.create({ memBytes: 256, device: dev });
  const rz = await z.run(Array.from({ length: 100 }, () => new Uint8Array(256)), { steps: 1 });
  all(rz.memory, 1, "facade memory");
  assert(dev.stats.maxSize <= 4096, `largest buffer ${dev.stats.maxSize} B`);
  clean(dev);
});

await test("the typed engine refuses 0.2-kernel manifests (review nit 7)", async () => {
  const engine = await Z.createEngine({ device: mockDevice() });
  let threw = false;
  await engine.machine(Z.legacyMachine(64)).catch(() => (threw = true));
  assert(threw, "engine.machine(legacyMachine) must reject");
  let threw2 = false;
  try {
    Z.decodeResult(Z.legacyMachine(64).manifest, 1, null, new Uint32Array(12));
  } catch {
    threw2 = true;
  }
  assert(threw2, "decodeResult on a legacy manifest must throw");
});

await test("Machine.run({ stepBase, resume }): the params carry the 64-bit step base and the resume flag; each chunk's records are uploaded before its dispatch", async () => {
  const dev = mockDevice();
  const engine = await Z.createEngine({ device: dev });
  const m = await engine.machine({ isa: Z.z80, compat: "0.3", world });
  assert(m.manifest.resumable, "the world should be resumable");
  const R = m.manifest.record.wordsPerLane;
  const at = (role) => m.manifest.params.fields.find((f) => f.role === role).offset / 4;
  const lanes = 150;
  const prev = new Uint32Array(lanes * R).map((_, i) => (i * 2654435761) >>> 0);
  await m.run(new Uint8Array(lanes * 32), { resume: prev, stepBase: 2n ** 32n + 7n, maxLanesPerChunk: 64 });
  const d = dev.stats.dispatches;
  assert(d.length === 3, `${d.length} dispatches, expected 3 chunks`);
  d.forEach((x, k) => {
    assert(x.params[at("stepBase")] === 7 && x.params[at("stepBase") + 1] === 1, `chunk ${k}: step base words ${x.params[at("stepBase")]}, ${x.params[at("stepBase") + 1]}`);
    assert(x.params[at("resume")] === 1, `chunk ${k}: resume flag ${x.params[at("resume")]}`);
    const n = Math.min(64, lanes - 64 * k);
    const want = prev.subarray(64 * k * R, (64 * k + n) * R);
    assert(want.every((v, i) => x.recordIn[i] === v), `chunk ${k}: the kernel would not resume from the uploaded records`);
  });
  d.length = 0;
  await m.run(new Uint8Array(2 * 32), { stepBase: 5 });
  assert(d[0].params[at("resume")] === 0 && d[0].params[at("stepBase")] === 5 && d[0].params[at("stepBase") + 1] === 0, "a begun run");
  const rejects = async (p, re) => {
    let msg = "";
    await p.catch((e) => (msg = String(e.message)));
    assert(re.test(msg), `expected ${re}, got ${JSON.stringify(msg)}`);
  };
  await rejects(m.run(new Uint8Array(2 * 32), { resume: new Uint32Array(5) }), /previous records/);
  await rejects(m.run(new Uint8Array(32), { stepBase: -1 }), /non-negative/);
  const nr = await engine.machine({ isa: Z.z80, compat: "0.3", world: { ...world, budget: { unit: "fetchBytes", value: 10 } } });
  await rejects(nr.run(new Uint8Array(32), { resume: new Uint32Array(nr.manifest.record.wordsPerLane) }), /cannot resume/);
  // Batch: uploadRecords + encode({ resume: true, stepBase }) continues the resident lanes
  const b = m.batch(100, { maxLanesPerSlab: 64 });
  const recs = new Uint32Array(100 * R).fill(9);
  b.uploadRecords(recs);
  d.length = 0;
  const enc = dev.createCommandEncoder();
  b.encode(enc, { resume: true, stepBase: 3 });
  dev.queue.submit([enc.finish()]);
  assert(d.length === 2 && d.every((x) => x.params[at("resume")] === 1 && x.params[at("stepBase")] === 3 && x.recordIn[0] === 9), "batch resume");
  let threw = false;
  try {
    nr.batch(4).encode(dev.createCommandEncoder(), { resume: true });
  } catch {
    threw = true;
  }
  assert(threw, "encode({ resume }) on a machine that cannot resume must throw");
  b.destroy();
  clean(dev);
});

await test("typed results decode trapCause through the manifest", async () => {
  const m = Z.buildMachine({ isa: Z.z80, compat: "0.3", world }).manifest;
  const R = m.record.wordsPerLane;
  const rec = new Uint32Array(3 * R);
  rec[0 * R + 2] = 0;
  rec[1 * R + 1] = 1;
  rec[1 * R + 2] = Z.TRAP_CAUSES["halt-insn"];
  rec[2 * R + 2] = 99;
  const r = Z.decodeResult(m, 3, null, rec);
  assert(r.trapCause.join() === `0,${Z.TRAP_CAUSES["halt-insn"]},99`, `trapCause ${r.trapCause}`);
  assert(r.trapCauseOf(0) === 0 && r.trapCauseOf(1) === "halt-insn" && r.trapCauseOf(2) === 99, "trapCauseOf");
  assert(r.haltReasonOf(1) === "halt-insn", "haltReasonOf");
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
