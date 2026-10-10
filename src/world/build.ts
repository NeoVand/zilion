// buildMachine: (IsaCore, WorldSpec) → WGSL + manifest.
//
// Everything this file emits is ISA-neutral: it names no register, opcode or core function directly. It reaches
// the core only through the descriptor (state fields, symbols, conventions, decode layouts) and the hooks of the
// host contract, so one WorldSpec generates the same world code for every core. Hooks the world does not need
// are not emitted, and the core is generated without the calls, so generality costs nothing when unused.

import { HALT_REASONS, HOST_CONTRACT, HOST_CONTRACT_PRELUDE_WGSL, TRAP_CAUSES } from "../contract/host.js";
import type { TrapCause, TrapDecision } from "../contract/host.js";
import type { CoreHook, CoreParamValue, IsaCore, StateField } from "../contract/isa.js";
import { coreParamsWgsl, resolveCoreParams } from "../contract/params.js";
import {
  MANIFEST_SCHEMA,
  type BindingInfo,
  type ParamField,
  type RecordField,
  type SegmentLayout,
  type ShaderManifest,
  type StackInit,
} from "../manifest.js";
import { canonicalJson } from "../util/json.js";
import { sha256 } from "../util/sha256.js";
import { ZILION_VERSION } from "../version.js";
import { HASH_WGSL, ZIL_SALT_INIT, dialThreshold } from "./hash.js";
import type { BindingNames, CoreSelection, Dial, MachineSpec, MemoryModel, Position, TrapPolicy, WorldSpec } from "./spec.js";

export interface BuiltMachine {
  readonly wgsl: string;
  readonly manifest: ShaderManifest;
}

const U32_MAX = 0xffffffff;
const u = (n: number) => `${n >>> 0}u`;
const hex = (n: number) => `0x${(n >>> 0).toString(16)}u`;
const fieldMax = (bits: number) => (bits >= 32 ? U32_MAX : 2 ** bits - 1);
const masked = (expr: string, bits: number) => (bits >= 32 ? expr : `${expr} & ${hex(fieldMax(bits))}`);

function fail(msg: string): never {
  throw new Error(`buildMachine: ${msg}`);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEMBER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * A user-supplied WGSL expression, emitted on lines of its own inside parentheses, so a trailing `//` comment
 * cannot swallow the code that follows it.
 */
function exprTerm(what: string, e: string): string {
  if (typeof e !== "string" || e.trim() === "") fail(`${what} must be a non-empty WGSL expression`);
  return `(\n        ${e.trim().split("\n").join("\n        ")}\n    )`;
}

function checkU32(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > U32_MAX) fail(`${name} must be a u32 (got ${String(v)})`);
  return v;
}

// --- memory ---------------------------------------------------------------------------------------------------

interface MemPlan {
  readonly model: MemoryModel["kind"];
  readonly P: number;
  readonly position: (addr: string) => string;
  readonly segments: readonly SegmentLayout[];
  readonly padding: { from: number; to: number } | null;
  readonly hostBytes: number;
  readonly storageWords: number;
  readonly lastByte: number;
  readonly counters: readonly string[];
}

function planMemory(m: MemoryModel): MemPlan {
  if (!m || typeof m !== "object") fail("world.memory is required");
  if (m.kind === "mask" || m.kind === "ring") {
    const P = m.bytes;
    if (!Number.isInteger(P) || P < 1) fail(`memory.bytes must be a positive integer (got ${P})`);
    if (m.kind === "mask" && (P & (P - 1)) !== 0) fail(`mask memory needs a power of two (got ${P}); use kind 'ring'`);
    const words = Math.ceil(P / 4);
    return {
      model: m.kind,
      P,
      position: m.kind === "mask" ? (a) => `${a} & ${hex(P - 1)}` : (a) => `${a} % ${u(P)}`,
      segments: [{ name: "memory", position: 0, bytes: P, hostOffset: 0, storageWord: 0, storageWords: words }],
      padding: null,
      hostBytes: P,
      storageWords: words,
      lastByte: P - 1,
      counters: ["writes"],
    };
  }
  if (m.kind === "segments") {
    if (!Array.isArray(m.segments) || m.segments.length === 0) fail("segments memory needs at least one segment");
    const segs: SegmentLayout[] = [];
    let pos = 0;
    let word = 0;
    const names = new Set<string>();
    m.segments.forEach((s, i) => {
      if (!Number.isInteger(s.bytes) || s.bytes < 1) fail(`segment ${i} needs a positive integer byte count`);
      const name = s.name ?? `s${i}`;
      if (typeof name !== "string" || !IDENT.test(name)) fail(`segment name ${JSON.stringify(name)} must be an identifier ([A-Za-z_][A-Za-z0-9_]*)`);
      if (names.has(name) || name === "padding") fail(`duplicate or reserved segment name '${name}'`);
      names.add(name);
      const w = Math.ceil(s.bytes / 4);
      segs.push({ name, position: pos, bytes: s.bytes, hostOffset: pos, storageWord: word, storageWords: w });
      pos += s.bytes;
      word += w;
    });
    const P = m.ring ?? pos;
    if (!Number.isInteger(P) || P < pos) fail(`ring ${P} is smaller than the segments' ${pos} bytes`);
    const padding = P > pos ? { from: pos, to: P } : null;
    return {
      model: "segments",
      P,
      position: (a) => `${a} % ${u(P)}`,
      segments: segs,
      padding,
      hostBytes: pos,
      storageWords: word,
      lastByte: pos - 1,
      counters: [...segs.map((s) => s.name), ...(padding ? ["padding"] : [])],
    };
  }
  fail(`unknown memory model '${(m as { kind: string }).kind}'`);
}

function resolvePosition(p: Position, mem: MemPlan, what: string): number {
  const t = p === "lastByte" ? mem.lastByte : p;
  if (!Number.isInteger(t) || t < 0 || t >= mem.P) fail(`${what} position ${String(p)} is not on the ring of ${mem.P}`);
  return t;
}

/** The core and its compile-time choices, from either form of the MachineSpec (never both). */
function selectCore(spec: MachineSpec): CoreSelection {
  const s = spec as { core?: CoreSelection; isa?: IsaCore; variant?: string; compat?: string; params?: unknown };
  if (s.params !== undefined) fail("core parameters go in core: { isa, params }, not beside isa");
  if (s.core !== undefined) {
    if (s.isa !== undefined || s.variant !== undefined || s.compat !== undefined) {
      fail("give the core either as core: { isa, variant?, compat?, params? } or as isa (with variant and compat beside it), not both");
    }
    if (!s.core || typeof s.core !== "object") fail("core must be { isa, variant?, compat?, params? }");
    return s.core;
  }
  return { isa: s.isa as IsaCore, variant: s.variant, compat: s.compat };
}

function attempt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    fail((e as Error).message);
  }
}

// --- the build ------------------------------------------------------------------------------------------------

export function buildMachine(spec: MachineSpec): BuiltMachine {
  if (!spec || typeof spec !== "object") fail("a MachineSpec { isa | core, world } is required");
  const sel = selectCore(spec);
  const isa: IsaCore = sel.isa;
  if (!isa || typeof isa.wgsl !== "function") fail("spec.isa (or spec.core.isa) must be an IsaCore");
  for (const k of ["step", "haltReason", "pc", "trapCause"] as const) {
    const v = isa.symbols?.[k];
    if (typeof v !== "string" || v.trim() === "") fail(`${isa.id}: symbols.${k} must be a WGSL ${k === "step" ? "function name" : "expression"}`);
  }
  for (const k of ["stackTop", "firstPushAt"] as const) {
    const v = isa.conventions?.[k];
    if (v !== null && typeof v !== "function") fail(`${isa.id}: conventions.${k} must be a function, or null for an ISA without a stack`);
  }
  const world: WorldSpec = spec.world;
  if (!world) fail("spec.world is required");
  const mode = spec.mode ?? "kernel";
  if (mode !== "kernel" && mode !== "library") fail(`unknown mode '${mode}'`);
  const wg = spec.workgroupSize ?? 64;
  if (!Number.isInteger(wg) || wg < 1 || wg > 1024) fail(`workgroupSize must be an integer in 1..1024 (got ${wg})`);
  const variant = sel.variant ?? isa.defaultVariant;
  if (!(variant in isa.variants)) fail(`${isa.id} has no variant '${variant}'`);
  const compat = sel.compat ?? isa.compat[0];
  if (!isa.compat.includes(compat)) fail(`${isa.id} has no compat '${compat}' (known: ${isa.compat.join(", ")})`);
  const coreParams: Record<string, CoreParamValue> = attempt(() => resolveCoreParams(isa, sel.params));
  const declaresParams = isa.params !== undefined && Object.keys(isa.params).length > 0;
  if (mode === "kernel" && spec.bindingNames) fail("bindingNames apply to library mode only");
  const names: BindingNames = spec.bindingNames ?? {};

  const mem = planMemory(world.memory);
  const P = mem.P;
  const fields = isa.state;
  const fieldByName = new Map<string, { f: StateField; k: number }>(fields.map((f, k) => [f.name, { f, k }]));
  const field = (name: string, what: string) => {
    const e = fieldByName.get(name);
    if (!e) fail(`${what}: ${isa.id} has no state field '${name}' (fields: ${fields.map((f) => f.name).join(", ")})`);
    return e;
  };

  // outputs
  const out = {
    memory: world.outputs?.memory ?? true,
    state: world.outputs?.state ?? true,
    fetchMap: world.outputs?.fetchMap ?? false,
    startMap: world.outputs?.startMap ?? false,
    writeCounts: world.outputs?.writeCounts ?? false,
  };
  const raw = world.hooks ?? {};

  // budget: required, both fields (no silent default)
  const budget = world.budget as Partial<WorldSpec["budget"]> | undefined;
  if (budget === undefined) fail("world.budget is required: give { unit: 'steps' | 'fetchBytes', value: n | 'perLane' }");
  if (!budget || typeof budget !== "object") fail("world.budget must be { unit, value }");
  if (budget.unit === undefined) fail("world.budget.unit is required: 'steps' or 'fetchBytes'");
  const unit = budget.unit;
  if (unit !== "steps" && unit !== "fetchBytes") fail(`unknown budget unit '${unit}'`);
  if (budget.value === undefined) fail("world.budget.value is required: a number of steps (or fetched bytes) per run, or 'perLane'");
  const budgetValue = budget.value;
  const perLaneBudget = budgetValue === "perLane";
  if (!perLaneBudget) checkU32("world.budget.value (a number or 'perLane')", budgetValue);

  // initial state
  const init = world.init ?? {};
  const perLaneState = init.state === "perLane";
  if (init.state !== undefined && init.state !== "zero" && !perLaneState) fail(`unknown init.state '${init.state}'`);
  if (perLaneState && (init.stack || init.set || init.random || world.entry)) {
    fail("init.state 'perLane' loads the whole state record; it excludes stack, set, random and entry");
  }
  const initLines: string[] = [];
  const assign = (values: Readonly<Record<string, number>>, what: string, comment: string) => {
    for (const [name, v] of Object.entries(values)) {
      const { f } = field(name, what);
      if (!Number.isInteger(v) || v < 0 || v > fieldMax(f.bits)) fail(`${what}: ${name} = ${v} does not fit ${f.bits} bits`);
      initLines.push(`    ${f.wgsl} = ${hex(v)}; // ${comment}`);
    }
  };
  const conv = isa.conventions;
  if ((conv.stackTop === null) !== (conv.firstPushAt === null)) {
    fail(`${isa.id}: conventions.stackTop and conventions.firstPushAt must both be functions or both be null`);
  }
  const hasStack = conv.stackTop !== null;
  // init.stack is validated the same way on every ISA (one world spec may serve a stack machine and a stackless one);
  // on an ISA without a stack it is then not applied, and the manifest says so (init.stack.notApplicable).
  let stackConv: { kind: "firstPushAt" | "topAliases"; t: number } | null = null;
  if (init.stack !== undefined) {
    const st = init.stack as { firstPushAt?: Position; topAliases?: Position };
    if (!st || typeof st !== "object") fail("init.stack must be { firstPushAt: t | 'lastByte' } or { topAliases: t | 'lastByte' }");
    const extra = Object.keys(st).filter((k) => k !== "firstPushAt" && k !== "topAliases");
    if (extra.length) fail(`init.stack has unknown field(s) ${extra.join(", ")} (give firstPushAt or topAliases)`);
    const first = st.firstPushAt !== undefined;
    const top = st.topAliases !== undefined;
    if (first && top) fail("init.stack gives both firstPushAt and topAliases; give exactly one");
    if (!first && !top) fail("init.stack needs firstPushAt or topAliases");
    stackConv = first
      ? { kind: "firstPushAt", t: resolvePosition(st.firstPushAt!, mem, "init.stack.firstPushAt") }
      : { kind: "topAliases", t: resolvePosition(st.topAliases!, mem, "init.stack.topAliases") };
  }
  const randomFields = init.random ? (init.random.fields ?? fields.filter((f) => f.randomizable).map((f) => f.name)) : [];
  let stackInit: StackInit;
  if (!hasStack) {
    stackInit = { notApplicable: "no stack", ...(init.stack !== undefined ? { given: { ...init.stack } } : {}) };
    if (stackConv) initLines.push(`    // init.stack (${stackConv.kind} ${stackConv.t}): not applicable, ${isa.id} has no stack`);
  } else if (perLaneState) {
    stackInit = { notApplicable: "per-lane state" };
  } else {
    // The stack fields are the fields the stack conventions assign (probed on a ring of one byte, where every
    // position is reachable). init.set and init.random covering all of them count as giving the stack.
    let stackFields: string[] = [];
    try {
      stackFields = [...new Set([...Object.keys(conv.firstPushAt!(1, 0)), ...Object.keys(conv.stackTop!(1, 0))])];
    } catch (e) {
      fail(`${isa.id}: conventions.firstPushAt(1, 0) and stackTop(1, 0) must succeed, they name the stack fields (${(e as Error).message})`);
    }
    const bySet = stackFields.filter((f) => init.set !== undefined && Object.prototype.hasOwnProperty.call(init.set, f));
    const byRandom = stackFields.filter((f) => randomFields.includes(f));
    const covered = stackFields.length > 0 && stackFields.every((f) => bySet.includes(f) || byRandom.includes(f));
    if (!stackConv && !covered) {
      fail(
        `world.init.stack is required: ${isa.id} has a stack (${stackFields.join(", ")}). Give init.stack = { firstPushAt: t | ` +
          "'lastByte' } (the first byte pushed lands at t, on every ISA) or { topAliases: t | 'lastByte' }, set every stack field " +
          "with init.set or init.random, or load the state with init.state = 'perLane'",
      );
    }
    let convention: StackInit["convention"];
    if (stackConv) {
      const values = stackConv.kind === "firstPushAt" ? conv.firstPushAt!(P, stackConv.t) : conv.stackTop!(P, stackConv.t);
      const what = stackConv.kind === "firstPushAt" ? "first push lands at" : "stack top aliases";
      assign(values, "init.stack", `${what} position ${stackConv.t} of ${P}`);
      convention = { kind: stackConv.kind, position: stackConv.t, values: { ...values } };
    }
    // in the order they apply: the convention, then init.set, then init.random
    stackInit = {
      ...(convention ? { convention } : {}),
      ...(bySet.length ? { set: bySet } : {}),
      ...(byRandom.length ? { random: byRandom } : {}),
    };
  }
  if (world.entry) {
    const t = resolvePosition(world.entry.position, mem, "entry");
    assign(isa.conventions.entry(t, P), "entry", `entry at position ${t}`);
  }
  if (init.set) assign(init.set, "init.set", "init.set");
  if (init.random) {
    const salt = checkU32("init.random.salt", init.random.salt ?? 0);
    const drawn = randomFields;
    if (drawn.length === 0) fail("init.random: no fields to draw");
    for (const name of drawn) {
      const { f, k } = field(name, "init.random");
      initLines.push(`    ${f.wgsl} = ${masked(`zil_hash(zil_seed, zil_lane, ${u(k)}, ${hex(salt ^ ZIL_SALT_INIT)})`, f.bits)}; // random ${name}`);
    }
  }

  // halting
  const maxUnit = 2 ** (8 * isa.fetchUnitBytes) - 1;
  const lethal = world.halting?.lethal;
  let lethalCode = "";
  if (lethal) {
    const first = lethal.firstUnit;
    if (!Number.isInteger(first) || first < 0 || first > maxUnit) fail(`halting.lethal.firstUnit must be in 0..${maxUnit}`);
    const p = lethal.probability ?? 1;
    const t = dialThreshold(p);
    const salt = checkU32("halting.lethal.salt", lethal.salt ?? 0);
    if (p >= 1) lethalCode = `    if (unit == ${hex(first)}) { return ZIL_HALT; } // lethal first unit\n`;
    else if (p > 0) {
      lethalCode =
        `    if (unit == ${hex(first)} && zil_draw(${hex(salt)}) < ${hex(t)}) { return ZIL_HALT; } // lethal first unit, p = ${p}\n`;
    }
  }
  const trapCases: string[] = [];
  let trapActive = raw.trap !== undefined;
  const policies = world.halting?.traps ?? {};
  for (const [cause, asChip] of Object.entries(isa.conventions.traps) as [TrapCause, TrapDecision][]) {
    const policy: TrapPolicy = policies[cause] ?? "as-chip";
    const code = TRAP_CAUSES[cause];
    let body: string;
    let note = "";
    if (policy === "as-chip" || policy === asChip) {
      body = `d = ${decisionConst(asChip)};`;
      note = " (as-chip)";
    }
    else {
      trapActive = true;
      if (typeof policy === "string") {
        if (policy === "vector" && asChip !== "vector") fail(`${isa.id} has no vector for trap '${cause}'`);
        if (policy !== "halt" && policy !== "ignore" && policy !== "vector") fail(`unknown trap policy '${policy}'`);
        body = `d = ${decisionConst(policy)};`;
      } else {
        body = dialTrapBody(policy.halt, cause);
        note = ` (halts with p = ${policy.halt.probability})`;
      }
    }
    trapCases.push(`        case ${u(code)}: { ${body} } // ${cause}${note}`);
  }
  for (const cause of Object.keys(policies)) {
    if (!(cause in isa.conventions.traps)) fail(`${isa.id} never raises trap '${cause}' (it raises: ${Object.keys(isa.conventions.traps).join(", ") || "none"})`);
  }

  // hooks the core must call
  const need: Record<CoreHook, boolean> = {
    fetch: out.fetchMap || unit === "fetchBytes" || raw.onFetch !== undefined,
    instructionStart: out.startMap || lethalCode !== "" || raw.onInstructionStart !== undefined,
    trap: trapActive,
    io: raw.ioIn !== undefined || raw.ioOut !== undefined,
  };
  const why: Record<CoreHook, string> = {
    fetch: "fetchMap, the fetchBytes budget or hooks.onFetch",
    instructionStart: "startMap, halting.lethal or hooks.onInstructionStart",
    trap: "halting.traps or hooks.trap",
    io: "hooks.ioIn / hooks.ioOut",
  };
  for (const h of Object.keys(need) as CoreHook[]) {
    if (need[h] && !isa.hooks.includes(h)) fail(`${isa.id} does not call the '${h}' hook, needed by ${why[h]}`);
  }

  // ablation
  const ab = world.ablation;
  let ablation: ShaderManifest["ablation"] = { kind: "none" };
  let ablationVec4 = 0;
  const decodeTerms: string[] = [];
  if ((ab || raw.decode !== undefined) && !isa.decode) fail(`${isa.id} has no decode hook (ablation)`);
  if (ab && "expr" in ab) {
    decodeTerms.push(exprTerm("ablation.expr", ab.expr));
    ablation = { kind: "expr" };
  } else if (ab && "table" in ab) {
    if (ab.table !== "uniform") fail(`unknown ablation table '${String(ab.table)}'`);
    const layoutName = ab.layout ?? isa.decode!.defaultLayout;
    const layout = isa.decode!.layouts[layoutName];
    if (!layout) fail(`${isa.id} has no decode layout '${layoutName}'`);
    const keyBits = layout.pages[0].keyBits;
    if (layout.pages.some((p) => p.keyBits !== keyBits)) fail("ablation tables need equal keyBits on every page");
    const wordsPerPage = Math.max(1, 2 ** keyBits / 32);
    const words = layout.pages.length * wordsPerPage;
    ablationVec4 = Math.ceil(words / 4);
    if (mode === "library" && !names.ablation) fail("library mode with an ablation table needs bindingNames.ablation");
    decodeTerms.push(`zil_ablated(${layout.pageExpr}, ${layout.keyExpr})`);
    ablation = { kind: "uniform", layout: layoutName, pages: layout.pages, wordsPerPage, words };
  } else if (ab) fail("ablation needs `expr` or `table`");
  if (raw.decode !== undefined) decodeTerms.push(exprTerm("hooks.decode", raw.decode));

  // library binding names
  if (mode === "library") {
    for (const [k, v] of Object.entries(names)) {
      const ok = typeof v === "string" && (k === "ablation" ? MEMBER : IDENT).test(v);
      if (!ok) fail(`bindingNames.${k} = ${JSON.stringify(v)} must be ${k === "ablation" ? "an identifier or a member access (params.suppress)" : "an identifier"}`);
    }
  }
  const MEM = mode === "kernel" ? "zil_mem" : names.memory;
  const OUT = mode === "kernel" ? "zil_out" : names.out;
  const STATE_IN = mode === "kernel" ? (perLaneState ? "zil_state_in" : undefined) : names.stateIn;
  const ABL = mode === "kernel" ? "zil_params.ablation" : names.ablation;

  // Resumable: a lane can continue from its record and memory. Needs a step budget (fetched-byte budgets would
  // need the per-lane fetch count and step index carried too), the state in the record, and stored memory; and no
  // per-lane state of the raw hooks' own (a `var<private>` in hooks.declarations), which no record carries.
  const hookPrivates = /\bvar\s*<\s*private\s*>/.test(raw.declarations ?? "");
  const resumable = unit === "steps" && out.state && !hookPrivates && (mode === "kernel" ? out.memory : !!MEM && !!OUT);
  const padBytes = mem.padding ? mem.padding.to - mem.padding.from : 0;
  const padWords = resumable ? Math.ceil(padBytes / 4) : 0;

  // record layout
  const recordFields: RecordField[] = [];
  let rw = 0;
  const addField = (name: RecordField["name"], words: number, items?: readonly string[]) => {
    recordFields.push({ name, offset: rw, words, ...(items ? { items } : {}) });
    rw += words;
  };
  addField("steps", 1);
  addField("haltReason", 1);
  addField("trapCause", 1);
  if (out.state) addField("state", fields.length, fields.map((f) => f.name));
  if (out.writeCounts) addField("writeCounts", mem.counters.length, mem.counters);
  const mapWords = Math.ceil(P / 32);
  if (out.fetchMap) addField("fetchMap", mapWords);
  if (out.startMap) addField("startMap", mapWords);
  if (padWords) addField("padding", padWords);
  const recordOffset = (n: RecordField["name"]) => recordFields.find((f) => f.name === n)!.offset;

  // --- emit -----------------------------------------------------------------------------------------------
  const coreText = isa.wgsl({ variant, compat, hooks: need, ...(declaresParams ? { params: coreParams } : {}) });
  const coreHooks = (Object.keys(need) as CoreHook[]).filter((h) => need[h]);
  const options = {
    variant,
    compat,
    ...(declaresParams ? { params: coreParams } : {}),
    mode,
    workgroupSize: wg,
    bindingNames: mode === "library" ? names : undefined,
  };
  const shaCore = sha256(coreText);
  const shaWorld = sha256(canonicalJson(world));
  const shaOptions = sha256(canonicalJson(options));

  const s: string[] = [];
  s.push(`// Generated by @neovand/zilion ${ZILION_VERSION} buildMachine (host contract v${HOST_CONTRACT}). Do not edit.
// core    ${isa.id} ${isa.coreVersion} (${isa.status}; variant ${variant}; compat ${compat}; hooks: ${coreHooks.join(", ") || "none"}) sha256 ${shaCore}
// world   sha256 ${shaWorld}
// options sha256 ${shaOptions}
`);
  s.push(HOST_CONTRACT_PRELUDE_WGSL);
  s.push(HASH_WGSL);

  s.push(`// === World (L1): ${mem.model} memory, ${P} positions per lane ===
const ZIL_MEM_P: u32 = ${u(P)};
const ZIL_MEM_WORDS: u32 = ${u(mem.storageWords)};
const ZIL_STATE_WORDS: u32 = ${u(fields.length)};
const ZIL_RECORD_WORDS: u32 = ${u(rw)};
`);
  const paramsText = coreParamsWgsl(isa, coreParams);
  if (paramsText) s.push(paramsText);

  if (mode === "kernel") {
    s.push(`struct ZilParams {
    lane_count: u32,
    lane_base: u32,
    budget: u32,
    seed: u32,
    step_base: vec2<u32>,   // 64-bit step base (low, high): the dial index of the dispatch's first step
    ${resumable ? "resume: u32,            // 0: lanes begin; 1: lanes continue from their record and memory" : "_pad0: u32,"}
    _pad1: u32,${ablationVec4 ? `\n    ablation: array<vec4<u32>, ${ablationVec4}>,` : ""}
};
@group(0) @binding(0) var<uniform> zil_params: ZilParams;
@group(0) @binding(1) var<storage, read_write> zil_mem: array<u32>;
@group(0) @binding(2) var<storage, read_write> zil_out: array<u32>;
${perLaneState ? "@group(0) @binding(3) var<storage, read> zil_state_in: array<u32>;\n" : ""}${perLaneBudget ? "@group(0) @binding(4) var<storage, read> zil_budget_in: array<u32>;\n" : ""}`);
  }

  s.push(`var<private> zil_lane: u32;   // global lane index
var<private> zil_seed: u32;   // run seed
var<private> zil_step: u32;   // index of the step being executed: low word of step base + steps run (64-bit)
var<private> zil_step_hi: u32;   // its high word
var<private> zil_step_base: vec2<u32>;   // the step base (low, high) of this run
var<private> zil_steps_total: u32;   // steps executed since zil_begin (or zil_resume)
var<private> zil_steps_prev: u32;   // steps a resumed lane had run before (from its record); 0 after zil_begin
${unit === "fetchBytes" ? "var<private> zil_fetched: u32; // instruction-stream bytes fetched\n" : ""}${out.writeCounts ? `var<private> zil_writes: array<u32, ${mem.counters.length}>; // ${mem.counters.join(", ")}\n` : ""}${out.fetchMap ? `var<private> zil_fetch_map: array<u32, ${mapWords}>;\n` : ""}${out.startMap ? `var<private> zil_start_map: array<u32, ${mapWords}>;\n` : ""}var<private> zil_m: array<u32, ${P}>; // lane memory, one byte per u32
// The dial draw at the current step: zil_hash(seed, lane, step, salt) with the 64-bit step's high word folded into
// the seed (zil_mix32(0) = 0, so below 2^32 steps this is exactly zil_hash(zil_seed, zil_lane, zil_step, salt)).
fn zil_draw(salt: u32) -> u32 { return zil_hash(zil_seed ^ zil_mix32(zil_step_hi), zil_lane, zil_step, salt); }
`);

  // memory access
  let count = "";
  if (out.writeCounts) {
    if (mem.counters.length === 1) count = "    zil_writes[0] += 1u;\n";
    else {
      const bounds = mem.segments.map((sg) => sg.position + sg.bytes);
      const parts: string[] = [];
      mem.counters.forEach((_, k) => {
        if (k === mem.counters.length - 1) parts.push(`{ zil_writes[${k}] += 1u; }`);
        else parts.push(`if (p < ${u(bounds[k])}) { zil_writes[${k}] += 1u; }`);
      });
      count = `    ${parts.join(" else ")}\n`;
    }
  }
  s.push(`fn zil_pos(addr: u32) -> u32 { return ${mem.position("addr")}; }
fn mem_read(addr: u32) -> u32 { return zil_m[zil_pos(addr)]; }
fn mem_write(addr: u32, val: u32) {
    let p = zil_pos(addr);
    zil_m[p] = val & 0xffu;
${count}}
`);

  // hooks
  const hooks: string[] = ["// === Host contract hooks (world side) ==="];
  if (need.fetch) {
    hooks.push(`fn on_fetch(addr: u32) {
${out.fetchMap ? "    { let fp = zil_pos(addr); zil_fetch_map[fp >> 5u] |= (1u << (fp & 31u)); }\n" : ""}${unit === "fetchBytes" ? "    zil_fetched += 1u;\n" : ""}${indent(raw.onFetch)}}`);
  }
  if (need.instructionStart) {
    hooks.push(`fn on_instruction_start(pc: u32, unit: u32) -> u32 {
${out.startMap ? "    { let sp = zil_pos(pc); zil_start_map[sp >> 5u] |= (1u << (sp & 31u)); }\n" : ""}${lethalCode}${indent(raw.onInstructionStart)}    return ZIL_CONTINUE;
}`);
  }
  if (isa.decode) {
    const [a, b] = isa.decode.params;
    if (ablation.kind === "uniform") {
      hooks.push(`fn zil_ablated(page: u32, key: u32) -> bool {
    let w = page * ${u(ablation.wordsPerPage!)} + (key >> 5u);
    return ((${ABL}[w >> 2u][w & 3u] >> (key & 31u)) & 1u) != 0u;
}`);
    }
    hooks.push(`fn ${isa.decode.fn}(${a}: u32, ${b}: u32) -> bool {
    return ${decodeTerms.length ? decodeTerms.join(" || ") : "false"};   // terms on their own lines
}`);
  }
  if (need.trap) {
    hooks.push(`fn zil_trap(cause: u32) -> u32 {
${indent(raw.trap)}    var d = ZIL_TRAP_HALT;
    switch (cause) {
${trapCases.join("\n")}
        default: {}
    }
    return d;
}`);
  }
  if (need.io) {
    hooks.push(`fn io_in(port: u32) -> u32 {
${indent(raw.ioIn?.trim() ? raw.ioIn : "return 0u;")}}
fn io_out(port: u32, val: u32) {
${indent(raw.ioOut)}}`);
  }
  hooks.push(`fn on_reset() {
${indent(raw.onReset)}}`);
  s.push(hooks.join("\n") + "\n");
  if (raw.declarations) s.push(`// === Raw declarations (world.hooks.declarations) ===\n${raw.declarations.trim()}\n`);

  s.push(`// === Core (L0): ${isa.name} ===`);
  s.push(coreText);

  // lane lifecycle
  const resetLines = [
    ...fields.map((f) => `    ${f.wgsl} = ${hex(f.reset ?? 0)};`),
    ...isa.internals.map((x) => `    ${x} = 0u;`),
  ];
  const fns: string[] = [`// === World (L1): lane lifecycle ===
fn zil_reset() {   // the world reset: every state field at its reset value
${resetLines.join("\n")}
}
fn zil_init_state() {   // init conventions (stack, entry, set, random)
${initLines.join("\n")}${initLines.length ? "\n" : ""}}
fn zil_halt_reason() -> u32 { return ${isa.symbols.haltReason}; }
fn zil_trap_cause() -> u32 { return ${isa.symbols.trapCause}; }   // 0, or the trap cause that halted the lane
fn zil_pc() -> u32 { return ${isa.symbols.pc}; }
fn zil_reset_lane(lane: u32, seed: u32) {   // a fresh lane: privates, counters, maps, state, init conventions
    zil_lane = lane;
    zil_seed = seed;
    zil_step = 0u;
    zil_step_hi = 0u;
    zil_step_base = vec2<u32>(0u, 0u);
    zil_steps_total = 0u;
    zil_steps_prev = 0u;
${unit === "fetchBytes" ? "    zil_fetched = 0u;\n" : ""}${out.writeCounts ? `    for (var i = 0u; i < ${u(mem.counters.length)}; i++) { zil_writes[i] = 0u; }\n` : ""}${out.fetchMap ? `    for (var i = 0u; i < ${u(mapWords)}; i++) { zil_fetch_map[i] = 0u; }\n` : ""}${out.startMap ? `    for (var i = 0u; i < ${u(mapWords)}; i++) { zil_start_map[i] = 0u; }\n` : ""}    zil_reset();
    zil_init_state();
}
fn zil_set_step_base(step_base: vec2<u32>) {   // the dial index of the next step (zil_run continues from it)
    zil_step_base = step_base;
    zil_step = step_base.x;
    zil_step_hi = step_base.y;
}
fn zil_begin_at(lane: u32, seed: u32, step_base: vec2<u32>) {   // zil_reset_lane, the step base, then on_reset (last word on the state)
    zil_reset_lane(lane, seed);
    zil_set_step_base(step_base);
    on_reset();
}
fn zil_begin(lane: u32, seed: u32) {   // zil_begin_at with step base 0
    zil_begin_at(lane, seed, vec2<u32>(0u, 0u));
}
// Runs up to \`budget\` more ${unit === "fetchBytes" ? "fetched bytes" : "steps"} and returns the steps executed. It may be called again on
// the same lane: the step index the dials see (zil_step, zil_step_hi) is the step base plus the steps run since zil_begin.
fn zil_run(budget: u32) -> u32 {
    var steps = 0u;
${unit === "fetchBytes" ? "    let fetched0 = zil_fetched;\n" : ""}    loop {
        if (${unit === "fetchBytes" ? "zil_fetched - fetched0" : "steps"} >= budget) { break; }
        if (zil_halt_reason() != ZIL_RUNNING) { break; }
        zil_step = zil_step_base.x + zil_steps_total;
        zil_step_hi = zil_step_base.y + select(0u, 1u, zil_step < zil_step_base.x);
        ${isa.symbols.step}();
        steps = steps + 1u;
        zil_steps_total = zil_steps_total + 1u;
    }
    return steps;
}`];
  const libFns = [
    "zil_begin(lane, seed)",
    "zil_begin_at(lane, seed, step_base: vec2<u32>)",
    "zil_reset_lane(lane, seed)",
    "zil_set_step_base(step_base: vec2<u32>)",
    "on_reset()",
    "zil_run(budget) -> steps",
    "zil_reset()",
    "zil_init_state()",
    "zil_halt_reason()",
    "zil_trap_cause()",
    "zil_pc()",
    "zil_hash(seed, lane, step, salt)",
    "zil_draw(salt)",
  ];

  if (MEM) {
    const load: string[] = [];
    const store: string[] = [];
    for (const sg of mem.segments) {
      load.push(`    for (var b = 0u; b < ${u(sg.bytes)}; b++) { zil_m[${u(sg.position)} + b] = (${MEM}[base + ${u(sg.storageWord)} + (b >> 2u)] >> ((b & 3u) * 8u)) & 0xffu; } // ${sg.name}`);
      store.push(`    for (var w = 0u; w < ${u(sg.storageWords)}; w++) { // ${sg.name}
        var v = 0u;
        for (var k = 0u; k < 4u; k++) {
            let b = w * 4u + k;
            if (b < ${u(sg.bytes)}) { v = v | (zil_m[${u(sg.position)} + b] << (k * 8u)); }
        }
        ${MEM}[base + ${u(sg.storageWord)} + w] = v;
    }`);
    }
    if (mem.padding) load.push(`    for (var p = ${u(mem.padding.from)}; p < ${u(mem.padding.to)}; p++) { zil_m[p] = 0u; } // padding: zero at the start of every run, never stored in memory`);
    fns.push(`fn zil_load_memory(base: u32) {   // ${MEM}[base ..] (word-padded segments) -> lane memory
${load.join("\n")}
}
fn zil_store_memory(base: u32) {   // lane memory -> ${MEM}[base ..]; padding is never stored in memory
${store.join("\n")}
}`);
    libFns.push("zil_load_memory(base)", "zil_store_memory(base)");
  }
  if (OUT) {
    fns.push(`fn zil_store_state(o: u32) {
${fields.map((f, k) => `    ${OUT}[o + ${u(k)}] = ${masked(f.wgsl, f.bits)}; // ${f.name}`).join("\n")}
}`);
    const rec: string[] = [
      `    ${OUT}[o] = zil_steps_prev + steps;`,
      `    ${OUT}[o + 1u] = zil_halt_reason();`,
      `    ${OUT}[o + 2u] = zil_trap_cause();`,
    ];
    if (out.state) rec.push(`    zil_store_state(o + ${u(recordOffset("state"))});`);
    if (out.writeCounts) rec.push(`    for (var i = 0u; i < ${u(mem.counters.length)}; i++) { ${OUT}[o + ${u(recordOffset("writeCounts"))} + i] = zil_writes[i]; }`);
    if (out.fetchMap) rec.push(`    for (var i = 0u; i < ${u(mapWords)}; i++) { ${OUT}[o + ${u(recordOffset("fetchMap"))} + i] = zil_fetch_map[i]; }`);
    if (out.startMap) rec.push(`    for (var i = 0u; i < ${u(mapWords)}; i++) { ${OUT}[o + ${u(recordOffset("startMap"))} + i] = zil_start_map[i]; }`);
    if (padWords) {
      rec.push(`    for (var w = 0u; w < ${u(padWords)}; w++) { // padding (resumable worlds carry it in the record)
        var v = 0u;
        for (var k = 0u; k < 4u; k++) {
            let b = w * 4u + k;
            if (b < ${u(padBytes)}) { v = v | (zil_m[${u(mem.padding!.from)} + b] << (k * 8u)); }
        }
        ${OUT}[o + ${u(recordOffset("padding"))} + w] = v;
    }`);
    }
    fns.push(`fn zil_store_record(o: u32, steps: u32) {   // the lane record (manifest.record); steps: run since zil_begin / zil_resume
${rec.join("\n")}
}`);
    libFns.push("zil_store_state(o)", "zil_store_record(o, steps)");
  }
  if (STATE_IN) {
    fns.push(`fn zil_load_state(o: u32) {
${fields.map((f, k) => `    ${f.wgsl} = ${masked(`${STATE_IN}[o + ${u(k)}]`, f.bits)}; // ${f.name}`).join("\n")}
}`);
    libFns.push("zil_load_state(o)");
  }
  if (resumable) {
    // Everything a lane carries from one dispatch to the next besides its loaded segments: the state record, the
    // steps already run, the write counters, the maps and the padding, all read back from its own record.
    const so = recordOffset("state");
    const res: string[] = [
      "    zil_reset_lane(lane, seed);",
      "    zil_set_step_base(step_base);",
      `    zil_steps_prev = ${OUT}[o];`,
      ...fields.map((f, k) => `    ${f.wgsl} = ${masked(`${OUT}[o + ${u(so + k)}]`, f.bits)}; // ${f.name}`),
    ];
    if (out.writeCounts) res.push(`    for (var i = 0u; i < ${u(mem.counters.length)}; i++) { zil_writes[i] = ${OUT}[o + ${u(recordOffset("writeCounts"))} + i]; }`);
    if (out.fetchMap) res.push(`    for (var i = 0u; i < ${u(mapWords)}; i++) { zil_fetch_map[i] = ${OUT}[o + ${u(recordOffset("fetchMap"))} + i]; }`);
    if (out.startMap) res.push(`    for (var i = 0u; i < ${u(mapWords)}; i++) { zil_start_map[i] = ${OUT}[o + ${u(recordOffset("startMap"))} + i]; }`);
    if (padWords) {
      res.push(`    for (var b = 0u; b < ${u(padBytes)}; b++) { zil_m[${u(mem.padding!.from)} + b] = (${OUT}[o + ${u(recordOffset("padding"))} + (b >> 2u)] >> ((b & 3u) * 8u)) & 0xffu; } // padding`);
    }
    fns.push(`// Continue a lane from its record at ${OUT}[o ..] (load its memory with zil_load_memory first). The raw on_reset hook
// does not run again: the lane is not starting, it is resuming. Raw-hook private state does not carry over.
fn zil_resume(lane: u32, seed: u32, step_base: vec2<u32>, o: u32) {
${res.join("\n")}
}`);
    libFns.push("zil_resume(lane, seed, step_base: vec2<u32>, o)");
  }
  s.push(fns.join("\n") + "\n");

  if (mode === "kernel") {
    const begin = perLaneState
      ? [
          "zil_reset_lane(zil_params.lane_base + i, zil_params.seed);",
          "zil_set_step_base(zil_params.step_base);",
          "zil_load_state(i * ZIL_STATE_WORDS);",
          "on_reset();",
        ]
      : ["zil_begin_at(zil_params.lane_base + i, zil_params.seed, zil_params.step_base);"];
    const start = resumable
      ? `    if (zil_params.resume != 0u) {
        zil_resume(zil_params.lane_base + i, zil_params.seed, zil_params.step_base, i * ZIL_RECORD_WORDS);
    } else {
${begin.map((l) => `        ${l}`).join("\n")}
    }
`
      : begin.map((l) => `    ${l}\n`).join("");
    s.push(`@compute @workgroup_size(${wg})
fn main(@builtin(global_invocation_id) zil_gid: vec3u) {
    let i = zil_gid.x;
    if (i >= zil_params.lane_count) { return; }
    zil_load_memory(i * ZIL_MEM_WORDS);
${start}    let steps = zil_run(${perLaneBudget ? "zil_budget_in[i]" : "zil_params.budget"});
${out.memory ? "    zil_store_memory(i * ZIL_MEM_WORDS);\n" : ""}    zil_store_record(i * ZIL_RECORD_WORDS, steps);
}
`);
  }

  const wgsl = s.join("\n");

  // --- manifest ---------------------------------------------------------------------------------------------
  const params: ParamField[] =
    mode === "kernel"
      ? [
          { name: "lane_count", role: "laneCount", offset: 0, words: 1 },
          { name: "lane_base", role: "laneBase", offset: 4, words: 1 },
          { name: "budget", role: "budget", offset: 8, words: 1 },
          { name: "seed", role: "seed", offset: 12, words: 1 },
          { name: "step_base", role: "stepBase", offset: 16, words: 2 },
          resumable ? { name: "resume", role: "resume", offset: 24, words: 1 } : { name: "_pad0", role: "pad", offset: 24, words: 1 },
          { name: "_pad1", role: "pad", offset: 28, words: 1 },
          ...(ablationVec4 ? [{ name: "ablation", role: "ablation" as const, offset: 32, words: ablationVec4 * 4 }] : []),
        ]
      : [];
  const bindings: BindingInfo[] =
    mode === "kernel"
      ? [
          { group: 0, binding: 0, name: "zil_params", role: "params", type: "uniform" },
          { group: 0, binding: 1, name: "zil_mem", role: "memory", type: "storage", wordsPerLane: mem.storageWords },
          { group: 0, binding: 2, name: "zil_out", role: "record", type: "storage", wordsPerLane: rw },
          ...(perLaneState ? [{ group: 0 as const, binding: 3, name: "zil_state_in", role: "stateIn" as const, type: "read-only-storage" as const, wordsPerLane: fields.length }] : []),
          ...(perLaneBudget ? [{ group: 0 as const, binding: 4, name: "zil_budget_in", role: "budgetIn" as const, type: "read-only-storage" as const, wordsPerLane: 1 }] : []),
        ]
      : [];
  const manifest: ShaderManifest = {
    schema: MANIFEST_SCHEMA,
    zilion: ZILION_VERSION,
    hostContract: HOST_CONTRACT,
    mode,
    entryPoint: mode === "kernel" ? "main" : null,
    workgroupSize: wg,
    core: {
      id: isa.id,
      name: isa.name,
      coreVersion: isa.coreVersion,
      status: isa.status,
      variant,
      compat,
      addressBits: isa.addressBits,
      fetchUnitBytes: isa.fetchUnitBytes,
      hooks: coreHooks,
      params: coreParams,
    },
    world: JSON.parse(canonicalJson(world)),
    sha256: { wgsl: sha256(wgsl), core: shaCore, world: shaWorld, options: shaOptions },
    params: { bytes: mode === "kernel" ? 32 + ablationVec4 * 16 : 0, fields: params },
    bindings,
    memory: {
      model: mem.model,
      ringBytes: P,
      position: mem.position("addr"),
      hostBytesPerLane: mem.hostBytes,
      storageWordsPerLane: mem.storageWords,
      packing: "little-endian bytes",
      segments: mem.segments,
      padding: mem.padding,
      stored: mode === "kernel" ? out.memory : !!MEM,
    },
    record: { wordsPerLane: rw, fields: recordFields },
    state: fields.map((f, k) => ({ name: f.name, bits: f.bits, offset: k })),
    haltReasons: HALT_REASONS,
    trapCauses: TRAP_CAUSES,
    resumable,
    ablation,
    budget: { unit, perLane: perLaneBudget, default: typeof budgetValue === "number" ? budgetValue : null },
    init: { perLane: perLaneState, stateWords: fields.length, stack: stackInit },
    ...(mode === "library" ? { functions: libFns } : {}),
  };
  return { wgsl, manifest };
}

function decisionConst(d: TrapDecision): string {
  return d === "halt" ? "ZIL_TRAP_HALT" : d === "ignore" ? "ZIL_TRAP_IGNORE" : "ZIL_TRAP_VECTOR";
}

function dialTrapBody(dial: Dial, cause: string): string {
  if (!dial || typeof dial.probability !== "number") fail(`trap '${cause}': a dial needs { halt: { probability } }`);
  const p = dial.probability;
  const t = dialThreshold(p);
  const salt = checkU32(`trap '${cause}' salt`, dial.salt ?? 0);
  if (p >= 1) return "d = ZIL_TRAP_HALT;";
  if (p <= 0) return "d = ZIL_TRAP_IGNORE;";
  return `d = select(ZIL_TRAP_IGNORE, ZIL_TRAP_HALT, zil_draw(${hex(salt)}) < ${hex(t)});`;
}

function indent(body: string | undefined): string {
  if (!body || !body.trim()) return "";
  return body.trim().split("\n").map((l) => `    ${l}`).join("\n") + "\n";
}
