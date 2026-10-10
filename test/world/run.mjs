#!/usr/bin/env node
// World-spec tests on the GPU (Python wgpu host). Run after `npm run build`:
//
//   node test/world/run.mjs [--only <substring>] [--keep] [--python <exe>]
//
// Each case builds a machine with buildMachine, runs lanes through test/world/gpu_runner.py (a host driven only
// by the manifest), decodes the lane records through the manifest and checks hand-computed expectations. The
// Python executable is --python, else $ZILION_PYTHON, else python3; it needs wgpu and numpy.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Z from "../../dist/index.js";
import { CASES as Z80_CASES } from "./cases.mjs";
import { CORE_CASES } from "./cases_cores.mjs";
import { M6502_CASES } from "./cases_m6502.mjs";

const CASES = [...Z80_CASES, ...CORE_CASES, ...M6502_CASES];

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const only = opt("--only", "");
const keep = args.includes("--keep");
const python = opt("--python", process.env.ZILION_PYTHON ?? "python3");

const dir = mkdtempSync(join(tmpdir(), "zilion-world-"));
const machines = new Map(); // wgsl -> { id, manifest }
const jobs = [];
const pending = []; // { c, job, machine }

function machineFor(spec) {
  const built = spec.wgsl ? spec : Z.buildMachine(spec);
  let m = machines.get(built.wgsl);
  if (!m) {
    const id = `m${machines.size}`;
    writeFileSync(join(dir, `${id}.wgsl`), built.wgsl);
    writeFileSync(join(dir, `${id}.manifest.json`), JSON.stringify(built.manifest));
    m = { id, manifest: built.manifest, wgsl: built.wgsl };
    machines.set(built.wgsl, m);
  }
  return m;
}

function packState(manifest, lanes) {
  const stateIn = manifest.bindings.find((b) => b.role === "stateIn");
  if (!stateIn) return null;
  const w = stateIn.wordsPerLane;
  const out = new Uint32Array(lanes.length * w);
  lanes.forEach((l, i) => {
    if (l.stateWords) out.set(l.stateWords, i * w);
    else for (const [k, v] of Object.entries(l.state ?? {})) {
      const f = manifest.state.find((s) => s.name === k);
      if (!f) throw new Error(`no state field ${k}`);
      out[i * w + f.offset] = v;
    }
  });
  return out;
}

let jobNo = 0;
function addJob(c, spec, lanes, run = {}) {
  const m = machineFor(spec);
  const id = `j${jobNo++}`;
  const host = new Uint8Array(lanes.length * m.manifest.memory.hostBytesPerLane);
  lanes.forEach((l, i) => host.set(l.mem.subarray(0, m.manifest.memory.hostBytesPerLane), i * m.manifest.memory.hostBytesPerLane));
  writeFileSync(join(dir, `${id}.in`), host);
  const job = {
    id, wgsl: `${m.id}.wgsl`, manifest: `${m.id}.manifest.json`, lanes: lanes.length, input: `${id}.in`,
    seed: run.seed ?? 0, budget: run.budget ?? null, ablation: run.ablation ? Array.from(run.ablation) : null,
    chunk: run.chunk ?? null, lane_base: run.laneBase ?? 0, out_memory: `${id}.mem`, out_record: `${id}.rec`,
    step_base: run.stepBase ?? 0, step_chunks: run.stepChunks ?? null, step_advance: run.stepAdvance ?? true,
  };
  if (run.resume) {
    writeFileSync(join(dir, `${id}.resume`), new Uint8Array(run.resume.buffer, run.resume.byteOffset, run.resume.byteLength));
    job.resume = `${id}.resume`;
  }
  const st = packState(m.manifest, lanes);
  if (st) { writeFileSync(join(dir, `${id}.state`), new Uint8Array(st.buffer)); job.state = `${id}.state`; }
  if (lanes.some((l) => l.budget !== undefined)) {
    writeFileSync(join(dir, `${id}.budgets`), new Uint8Array(Uint32Array.from(lanes, (l) => l.budget ?? 0).buffer));
    job.budgets = `${id}.budgets`;
  }
  jobs.push(job);
  const p = { c, job, machine: m, lanes, result: null };
  pending.push(p);
  return p;
}

/** Decode a job's outputs into per-lane objects using only the manifest. */
function decode(p) {
  const { manifest } = p.machine;
  const errFile = join(dir, `${p.job.out_record}.error`);
  if (existsSync(errFile)) throw new Error(readFileSync(errFile, "utf8"));
  const mem = new Uint8Array(readFileSync(join(dir, p.job.out_memory)));
  const recBuf = readFileSync(join(dir, p.job.out_record));
  const rec = new Uint32Array(recBuf.buffer, recBuf.byteOffset, recBuf.byteLength / 4);
  const R = manifest.record.wordsPerLane;
  const H = manifest.memory.hostBytesPerLane;
  const field = (n) => manifest.record.fields.find((f) => f.name === n);
  const bits = (words) => {
    const s = [];
    words.forEach((w, i) => { for (let b = 0; b < 32; b++) if ((w >>> b) & 1) s.push(i * 32 + b); });
    return s;
  };
  return p.lanes.map((_, i) => {
    const r = rec.subarray(i * R, (i + 1) * R);
    const out = { mem: mem.subarray(i * H, (i + 1) * H), raw: r };
    for (const f of manifest.record.fields) {
      const w = Array.from(r.subarray(f.offset, f.offset + f.words));
      if (f.name === "steps") out.steps = w[0];
      else if (f.name === "haltReason") out.halt = Object.keys(manifest.haltReasons).find((k) => manifest.haltReasons[k] === w[0]) ?? w[0];
      else if (f.name === "trapCause") out.trap = w[0] === 0 ? 0 : Object.keys(manifest.trapCauses).find((k) => manifest.trapCauses[k] === w[0]) ?? w[0];
      else if (f.name === "padding") out.padding = w;
      else if (f.name === "state") out.state = Object.fromEntries(f.items.map((n, k) => [n, w[k]]));
      else if (f.name === "writeCounts") out.writes = w;
      else if (f.name === "fetchMap") out.fetched = bits(w);
      else if (f.name === "startMap") out.starts = bits(w);
      else if (f.name === "regs16") out.regs16 = w;
    }
    void field;
    return out;
  });
}

const hex = (v) => (typeof v === "number" ? `0x${v.toString(16)}` : JSON.stringify(v));
function checkLane(exp, got) {
  const errs = [];
  if (!exp) return errs;
  if (exp.steps !== undefined && got.steps !== exp.steps) errs.push(`steps ${got.steps} != ${exp.steps}`);
  if (exp.halt !== undefined && got.halt !== exp.halt) errs.push(`halt ${got.halt} != ${exp.halt}`);
  if (exp.trap !== undefined && got.trap !== exp.trap) errs.push(`trapCause ${got.trap} != ${exp.trap}`);
  for (const [k, v] of Object.entries(exp.state ?? {})) {
    if (got.state?.[k] !== v) errs.push(`${k} ${hex(got.state?.[k])} != ${hex(v)}`);
  }
  for (const [pos, v] of Object.entries(exp.mem ?? {})) {
    if (got.mem[+pos] !== v) errs.push(`mem[${pos}] ${hex(got.mem[+pos])} != ${hex(v)}`);
  }
  if (exp.memAll && !exp.memAll.every((v, i) => got.mem[i] === v)) errs.push(`memory differs`);
  for (const k of ["writes", "fetched", "starts"]) {
    if (exp[k] !== undefined) {
      const a = JSON.stringify(got[k]);
      const b = JSON.stringify(k === "writes" ? exp[k] : [...exp[k]].sort((x, y) => x - y)); // maps are sets
      if (a !== b) errs.push(`${k} ${a} != ${b}`);
    }
  }
  return errs;
}

// --- collect -----------------------------------------------------------------------------------------------
const ctx = { Z, addJob };
const selected = CASES.filter((c) => !only || c.name.includes(only));
for (const c of selected) {
  try {
    c.jobs = c.setup(ctx);
  } catch (e) {
    c.setupError = e;
  }
}
writeFileSync(join(dir, "plan.json"), JSON.stringify({ jobs }));

// --- run ---------------------------------------------------------------------------------------------------
const t0 = Date.now();
const py = spawnSync(python, [join(here, "gpu_runner.py"), join(dir, "plan.json")], { encoding: "utf8" });
if (py.status !== 0) {
  console.error(py.stdout, py.stderr);
  console.error(`gpu_runner failed (python: ${python})`);
  process.exit(2);
}
process.stderr.write(py.stderr);

// --- check -------------------------------------------------------------------------------------------------
let pass = 0;
let failCount = 0;
for (const c of selected) {
  let errs = [];
  if (c.setupError) errs.push(`setup: ${c.setupError.stack ?? c.setupError}`);
  else {
    try {
      for (const p of pending.filter((q) => q.c === c)) p.result = decode(p);
      const jobsOfCase = Array.isArray(c.jobs) ? c.jobs : [c.jobs];
      for (const p of jobsOfCase) {
        p.result.forEach((got, i) => {
          for (const e of checkLane(p.lanes[i].expect, got)) errs.push(`lane ${i}${p.lanes[i].label ? ` (${p.lanes[i].label})` : ""}: ${e}`);
        });
      }
      if (c.check) errs = errs.concat(c.check(c.jobs, ctx) ?? []);
    } catch (e) {
      errs.push(String(e.stack ?? e));
    }
  }
  if (errs.length === 0) {
    pass++;
    console.log(`  ok    ${c.name}${c.note ? `  [${c.note(c.jobs)}]` : ""}`);
  } else {
    failCount++;
    console.log(`  FAIL  ${c.name}`);
    for (const e of errs.slice(0, 12)) console.log(`          ${e}`);
    if (errs.length > 12) console.log(`          … ${errs.length - 12} more`);
  }
}
console.log(`${pass} passed, ${failCount} failed (${jobs.length} GPU jobs, ${machines.size} machines, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (keep) console.log(`kept ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exit(failCount === 0 ? 0 : 1);
