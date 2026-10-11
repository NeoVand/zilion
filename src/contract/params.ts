// Core parameters (L0): compile-time constants a core declares in its descriptor (`IsaCore.params`) and a machine
// selects (`core: { isa, params }`). The builder validates the selection, emits one WGSL constant per parameter
// ahead of the core text and records the resolved values in the manifest. A parameter is never a uniform:
// changing one is a recompile, so a core may branch on it for free.
//
// Naming scheme (fixed; a core's text relies on it):
//   u32   `const ZIL_PARAM_<NAME>: u32 = <value>u;`
//   bool  `const ZIL_PARAM_<NAME>: bool = <true|false>;`
//   enum  `const ZIL_PARAM_<NAME>_<VALUE>: u32 = <index>u;` for every value, in declaration order, then
//         `const ZIL_PARAM_<NAME>: u32 = <index of the selected value>u;`
//   table `const ZIL_PARAM_<NAME>: array<u32, <length>> = array<u32, <length>>(<v0>u, <v1>u, …);`
//         (a module-scope constant; a core may index it with a runtime index)
// where <NAME> and <VALUE> are the declared names upper-cased. Names and enum values are lower snake case.

import type { CoreParamDecl, CoreParamValue, IsaCore } from "./isa.js";

const NAME = /^[a-z][a-z0-9_]*$/;
const U32_MAX = 0xffffffff;
/** Largest table a descriptor may declare (the constant is emitted into the shader text). */
export const MAX_TABLE_LENGTH = 65536;

const isU32 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= U32_MAX;

/** The WGSL constant of parameter `name` (or of one value of an enum parameter). */
export function coreParamConstant(name: string, enumValue?: string): string {
  return `ZIL_PARAM_${name.toUpperCase()}${enumValue === undefined ? "" : `_${enumValue.toUpperCase()}`}`;
}

function checkValue(core: string, name: string, d: CoreParamDecl, v: unknown, what: string): CoreParamValue {
  switch (d.type) {
    case "u32":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > U32_MAX) {
        throw new Error(`${core}: ${what} '${name}' must be a u32 (got ${JSON.stringify(v)})`);
      }
      return v;
    case "bool":
      if (typeof v !== "boolean") throw new Error(`${core}: ${what} '${name}' must be a boolean (got ${JSON.stringify(v)})`);
      return v;
    case "enum":
      if (typeof v !== "string" || !d.values.includes(v)) {
        throw new Error(`${core}: ${what} '${name}' must be one of ${d.values.map((x) => `'${x}'`).join(", ")} (got ${JSON.stringify(v)})`);
      }
      return v;
    case "table": {
      // an array or a typed array (not a DataView) of exactly `length` integers in [0, max]; resolved to a frozen copy
      const arrayLike = Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));
      if (!arrayLike) throw new Error(`${core}: ${what} '${name}' must be an array of ${d.length} integers (got ${typeof v})`);
      const a = Array.from(v as ArrayLike<unknown>);
      if (a.length !== d.length) throw new Error(`${core}: ${what} '${name}' must have ${d.length} entries (got ${a.length})`);
      const bad = a.findIndex((x) => !isU32(x) || (x as number) > d.max);
      if (bad >= 0) throw new Error(`${core}: ${what} '${name}' entry ${bad} must be an integer in 0..${d.max} (got ${JSON.stringify(a[bad])})`);
      return Object.freeze(a as number[]);
    }
    default:
      throw new Error(`${core}: param '${name}' has unknown type '${(d as { type: string }).type}'`);
  }
}

/** Validate a descriptor's parameter declarations (names, types, defaults, enum values, table shapes, constant names). */
export function checkCoreParamDecls(isa: Pick<IsaCore, "id" | "params">): void {
  const decls = isa.params ?? {};
  const constants = new Map<string, string>();
  const claim = (c: string, by: string) => {
    const prev = constants.get(c);
    if (prev) throw new Error(`${isa.id}: params ${prev} and ${by} both emit ${c}`);
    constants.set(c, by);
  };
  for (const [name, d] of Object.entries(decls)) {
    if (!NAME.test(name)) throw new Error(`${isa.id}: param name '${name}' must be lower snake case ([a-z][a-z0-9_]*)`);
    if (!d || typeof d !== "object") throw new Error(`${isa.id}: param '${name}' needs a declaration`);
    if (d.type === "table") {
      if (!Number.isInteger(d.length) || d.length < 1 || d.length > MAX_TABLE_LENGTH) {
        throw new Error(`${isa.id}: table param '${name}' needs an integer length in 1..${MAX_TABLE_LENGTH} (got ${JSON.stringify(d.length)})`);
      }
      if (!isU32(d.max)) throw new Error(`${isa.id}: table param '${name}' needs a u32 max (got ${JSON.stringify(d.max)})`);
    }
    if (d.type === "enum") {
      if (!Array.isArray(d.values) || d.values.length === 0) throw new Error(`${isa.id}: enum param '${name}' needs values`);
      if (new Set(d.values).size !== d.values.length) throw new Error(`${isa.id}: enum param '${name}' repeats a value`);
      for (const v of d.values) {
        if (typeof v !== "string" || !NAME.test(v)) throw new Error(`${isa.id}: value '${v}' of param '${name}' must be lower snake case`);
        claim(coreParamConstant(name, v), `'${name}' (value '${v}')`);
      }
    }
    checkValue(isa.id, name, d, d.default, "the default of param");
    claim(coreParamConstant(name), `'${name}'`);
  }
}

/**
 * Resolve a machine's parameter selection against the descriptor: every declared parameter, in declaration order,
 * with the given value or its default. Unknown names, wrong types, enum values outside `values` and tables of the
 * wrong length or with an entry outside [0, max] are errors. A table resolves to a frozen plain array.
 */
export function resolveCoreParams(isa: Pick<IsaCore, "id" | "params">, given: unknown): Record<string, CoreParamValue> {
  checkCoreParamDecls(isa);
  const decls = isa.params ?? {};
  if (given !== undefined && (given === null || typeof given !== "object" || Array.isArray(given))) {
    throw new Error(`${isa.id}: core.params must be an object of parameter values`);
  }
  const sel = (given ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(sel)) {
    if (!(name in decls)) {
      const known = Object.keys(decls);
      throw new Error(`${isa.id} has no param '${name}' (${known.length ? `params: ${known.join(", ")}` : "it declares none"})`);
    }
  }
  const out: Record<string, CoreParamValue> = {};
  for (const [name, d] of Object.entries(decls)) {
    // a default goes through the same check, so a table default is copied too (the manifest never aliases the descriptor)
    out[name] = name in sel ? checkValue(isa.id, name, d, sel[name], "param") : checkValue(isa.id, name, d, d.default, "the default of param");
  }
  return out;
}

/** The WGSL constants of resolved parameters (empty when the core declares none). */
export function coreParamsWgsl(isa: Pick<IsaCore, "id" | "params">, resolved: Readonly<Record<string, CoreParamValue>>): string {
  const decls = isa.params ?? {};
  const lines: string[] = [];
  for (const [name, d] of Object.entries(decls)) {
    const v = resolved[name];
    if (d.type === "u32") lines.push(`const ${coreParamConstant(name)}: u32 = ${(v as number) >>> 0}u;`);
    else if (d.type === "bool") lines.push(`const ${coreParamConstant(name)}: bool = ${v ? "true" : "false"};`);
    else if (d.type === "table") {
      const t = v as readonly number[];
      const rows: string[] = [];
      for (let i = 0; i < t.length; i += 32) rows.push(`    ${t.slice(i, i + 32).map((x) => `${x >>> 0}u`).join(", ")},`);
      lines.push(`const ${coreParamConstant(name)}: array<u32, ${t.length}> = array<u32, ${t.length}>(\n${rows.join("\n")}\n);`);
    } else {
      d.values.forEach((x, k) => lines.push(`const ${coreParamConstant(name, x)}: u32 = ${k}u;`));
      lines.push(`const ${coreParamConstant(name)}: u32 = ${d.values.indexOf(v as string)}u; // '${v as string}'`);
    }
  }
  return lines.length ? `// === Core parameters (${isa.id}; compile-time constants, IsaCore.params) ===\n${lines.join("\n")}\n` : "";
}
