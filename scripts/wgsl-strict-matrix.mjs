// Shared, deterministic generation coverage for the strict syntax check and the
// old/new GPU identity experiment. Imports built modules; no third-party tools.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function loadAPI(dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')) {
  const api = await import(pathToFileURL(resolve(dist, 'index.js')).href);
  const { bff, BFF_ASCII_LITERAL } = await import(pathToFileURL(resolve(dist, 'cores/bff/index.js')).href);
  return { ...api, bff, BFF_ASCII_LITERAL };
}

export function selections(Z) {
  return [Z.z80, Z.m6502, Z.i8086, Z.bff].flatMap(isa =>
    isa.compat.flatMap(compat => Object.keys(isa.variants)
      .filter(variant => !(isa.id === 'z80' && compat === '0.2' && variant !== 'classic'))
      .map(variant => ({ isa, compat, variant }))));
}
export const selectionLabel = c => `${c.isa.id}@${c.compat}/${c.variant}`;
const outputs = { memory: true, state: true, fetchMap: true, startMap: true, writeCounts: true };

export function worlds(core) {
  const key = core.decode.params[1];
  const base = { memory: { kind: 'mask', bytes: 64 }, init: { stack: { firstPushAt: 'lastByte' } }, budget: { unit: 'steps', value: 128 } };
  const measured = { ...base, outputs };
  const traps = Object.fromEntries(Object.keys(core.conventions.traps).map(cause => [cause, { halt: { probability: 0.37, salt: 71 } }]));
  const ignore = Object.fromEntries(Object.keys(core.conventions.traps).map(cause => [cause, 'ignore']));
  return [
    ['mask', base],
    ['ring', { ...measured, memory: { kind: 'ring', bytes: 67 }, init: { stack: { topAliases: 'lastByte' }, random: { salt: 29,
      fields: core.state.some(f => f.randomizable) ? core.state.filter(f => f.randomizable).map(f => f.name) : ['h0', 'h1'] } } }],
    ['segments', { ...measured, memory: { kind: 'segments', segments: [{ bytes: 19, name: 'A' }, { bytes: 21, name: 'B' }], ring: 47 } }],
    ['ablation', { ...measured, ablation: { table: 'uniform' } }],
    ['expr-lethal', { ...measured, ablation: { expr: `${key} == 1u || (${key} >= 8u && ${key} <= 10u)` }, halting: { lethal: { firstUnit: 0, probability: 0.41, salt: 43 }, traps } }],
    ['fetch-budget', { ...measured, budget: { unit: 'fetchBytes', value: 128 }, halting: { lethal: { firstUnit: 255 } } }],
    ['per-lane', { ...measured, init: { state: 'perLane' }, budget: { unit: 'steps', value: 'perLane' }, halting: { traps: ignore } }],
    ['raw-hooks', { ...measured, hooks: { onFetch: 'let seen = addr;', onInstructionStart: 'let first = unit;', decode: `${key} == 253u`, trap: 'let raised = cause;', onReset: 'let lane = zil_lane;', ...(core.hooks.includes('io') ? { ioIn: 'return port & 255u;', ioOut: 'let written = val;' } : {}) } }],
    ['zero-dials', { ...measured, halting: { lethal: { firstUnit: 0, probability: 0 }, traps: Object.fromEntries(Object.keys(traps).map(cause => [cause, { halt: { probability: 0 } }])) } }],
    ['one-dials', { ...measured, halting: { lethal: { firstUnit: 0, probability: 1 }, traps: Object.fromEntries(Object.keys(traps).map(cause => [cause, { halt: { probability: 1 } }])) } }],
    ...Object.keys(core.decode.layouts).map(layout => [`layout-${layout}`, { ...measured, ablation: { table: 'uniform', layout } }]),
    ...Object.entries(core.conventions.traps).filter(([, policy]) => policy === 'vector').map(([cause]) => [`vector-${cause}`, { ...measured, halting: { traps: { [cause]: 'vector' } } }]),
  ];
}

export async function shaderMatrix(dist) {
  const Z = await loadAPI(dist);
  const texts = [];
  for (const core of selections(Z)) {
    const label = selectionLabel(core);
    for (let mask = 0; mask < 2 ** core.isa.hooks.length; mask++) {
      const hooks = Object.fromEntries(core.isa.hooks.map((h, i) => [h, !!(mask & (1 << i))]));
      texts.push({ label: `${label}/core-hooks-${mask}`, wgsl: core.isa.wgsl({ ...core, hooks }) });
    }
    for (const [name, world] of worlds(core.isa)) {
      for (const mode of ['kernel', 'library']) {
        texts.push({ label: `${label}/${name}/${mode}`, ...Z.buildMachine({ core, world, mode,
          ...(mode === 'library' ? { bindingNames: { memory: 'host_memory', out: 'host_record', stateIn: 'host_state', ablation: 'host_ablation' } } : {}) }) });
      }
    }
    // Exercise every optional-output combination on each memory model, including
    // memory/state disabled, and maps which require hooks even without state.
    for (const memory of [ { kind: 'mask', bytes: 4 }, { kind: 'ring', bytes: 1 },
      { kind: 'segments', segments: [{ bytes: 3 }, { bytes: 5 }], ring: 11 } ]) {
      for (let mask = 0; mask < 32; mask++) {
        const output = Object.fromEntries(Object.keys(outputs).map((key, i) => [key, !!(mask & (1 << i))]));
        texts.push({ label: `${label}/${memory.kind}/outputs-${mask}`, ...Z.buildMachine({ core, world: { ...worlds(core.isa)[0][1], memory, outputs: output } }) });
      }
    }
    if (core.isa.id === 'bff') {
      for (const lit_rep of [1, 3]) texts.push({ label: `${label}/literal-${lit_rep}`, ...Z.buildMachine({
        core: { ...core, params: { alphabet: Z.BFF_ASCII_LITERAL, literal: true, lit_rep } }, world: worlds(core.isa)[2][1] }) });
    }
  }
  for (const bytes of [4, 8, 32, 256, 65536]) {
    for (const fetchHook of [undefined, 'false', '(prefix == 0xedu && op == 0xb0u) || (prefix == 0u && (op & 0xcfu) == 0xc5u)'])
      texts.push({ label: `legacy/${bytes}/${fetchHook ?? 'default'}`, wgsl: Z.buildComputeShader(bytes, { fetchHook }) });
  }
  return texts;
}
