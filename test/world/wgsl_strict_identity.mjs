#!/usr/bin/env node
// Reproducible old/new experiment. Build the reference separately from 7f223de,
// then: node test/world/wgsl_strict_identity.mjs <reference dist> [output dir]
// GPU runner: python -I test/world/wgsl_strict_identity.py <output dir>/plan.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAPI, selections, selectionLabel, worlds, shaderMatrix } from '../../scripts/wgsl-strict-matrix.mjs';
import { checkWGSL } from '../../scripts/check-wgsl-strict.mjs';

const [reference, output = 'build/wgsl-strict/identity'] = process.argv.slice(2);
if (!reference) throw new Error('usage: wgsl_strict_identity.mjs <reference dist> [output dir]');
const dir = resolve(output);
mkdirSync(dir, { recursive: true });
const old = await loadAPI(reference), current = await loadAPI();
const oldMatrix = await shaderMatrix(reference), newMatrix = await shaderMatrix();
assert.equal(oldMatrix.length, newMatrix.length);
const strictText = s => s.replace('op == 143u || op >= 196u && op <= 199u', 'op == 143u || (op >= 196u && op <= 199u)')
  .replace('(i8086_flags & 213u | 2u)', '((i8086_flags & 213u) | 2u)');
const withoutCoreHashComment = s => s.replace(/(^\/\/ core .+ sha256 )[a-f0-9]{64}$/m, '$1<core hash>');
let changedTexts = 0;
let originalErrors = 0;
for (let i = 0; i < oldMatrix.length; i++) {
  assert.equal(oldMatrix[i].label, newMatrix[i].label);
  assert.equal(withoutCoreHashComment(strictText(oldMatrix[i].wgsl)), withoutCoreHashComment(newMatrix[i].wgsl),
    `unexpected text edit: ${newMatrix[i].label}`);
  if (!newMatrix[i].label.startsWith('i8086@')) assert.equal(oldMatrix[i].wgsl, newMatrix[i].wgsl);
  const issues = checkWGSL(oldMatrix[i].wgsl);
  assert.equal(issues.length, oldMatrix[i].label.startsWith('i8086@') ? 2 : 0, oldMatrix[i].label);
  assert.equal(checkWGSL(newMatrix[i].wgsl).length, 0, newMatrix[i].label);
  originalErrors += issues.length;
  if (oldMatrix[i].wgsl !== newMatrix[i].wgsl) changedTexts++;
}
const hash = s => createHash('sha256').update(s).digest('hex');
const cores = selections(current).map((c, i) => {
  const before = selections(old)[i];
  const hooks = (c.isa.id === 'z80' && c.compat !== '0.2') || c.isa.id === 'i8086' ? { io: true } : {};
  // Match the instruction harness's published hashes for the hardware ISAs.
  const prelude = c.isa.id === 'm6502' || c.isa.id === 'i8086' ? current.HOST_CONTRACT_PRELUDE_WGSL : '';
  return { core: selectionLabel(c), old: hash(prelude + before.isa.wgsl({ ...before, hooks })),
    new: hash(prelude + c.isa.wgsl({ ...c, hooks })) };
});
const coreTextHashChanges = Array.from({ length: 16 }, (_, mask) => {
  const hooks = Object.fromEntries(['fetch', 'instructionStart', 'trap', 'io'].map((h, i) => [h, !!(mask & (1 << i))]));
  return { mask, hooks, old: hash(old.i8086.wgsl({ hooks })), new: hash(current.i8086.wgsl({ hooks })) };
});
const jobs = [];
for (let i = 0; i < selections(current).length; i++) {
  const before = selections(old)[i], after = selections(current)[i];
  // 8 worlds x 32768 = 262144 lanes for EACH variant/compat, including BFF.
  for (const [worldName, world] of worlds(after.isa).slice(0, 8)) {
    const machines = [old.buildMachine({ core: before, world }), current.buildMachine({ core: after, world })];
    const id = `m${jobs.length}`;
    machines.forEach((m, k) => {
      writeFileSync(`${dir}/${id}-${k}.wgsl`, m.wgsl);
      writeFileSync(`${dir}/${id}-${k}.manifest.json`, JSON.stringify(m.manifest));
    });
    jobs.push({ id, core: selectionLabel(after), world: worldName, lanes: 32768,
      seed: (0x5eed0000 + jobs.length) >>> 0,
      old: { wgsl: `${id}-0.wgsl`, manifest: `${id}-0.manifest.json` },
      new: { wgsl: `${id}-1.wgsl`, manifest: `${id}-1.manifest.json` } });
  }
}
writeFileSync(`${dir}/plan.json`, JSON.stringify({ reference: '7f223de (0.3.0)', cores, coreTextHashChanges,
  matrix: { texts: oldMatrix.length, originalErrors, changedTexts, exactEditsVerified: true }, jobs }, null, 2) + '\n');
console.log(`Exact text edits verified across ${oldMatrix.length} shaders (${changedTexts} changed); ${jobs.length} GPU identity pairs emitted to ${dir}`);
console.log(JSON.stringify(cores, null, 2));
