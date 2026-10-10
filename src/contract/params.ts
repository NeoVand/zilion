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
// where <NAME> and <VALUE> are the declared names upper-cased. Names and enum values are lower snake case.

import type { CoreParamDecl, CoreParamValue, IsaCore } from "./isa.js";

const NAME = /^[a-z][a-z0-9_]*$/;
const U32_MAX = 0xffffffff;

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
    default:
      throw new Error(`${core}: param '${name}' has unknown type '${(d as { type: string }).type}'`);
  }
}

/** Validate a descriptor's parameter declarations (names, types, defaults, enum values, constant names). */
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
 * with the given value or its default. Unknown names, wrong types and enum values outside `values` are errors.
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
  for (const [name, d] of Object.entries(decls)) out[name] = name in sel ? checkValue(isa.id, name, d, sel[name], "param") : d.default;
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
    else {
      d.values.forEach((x, k) => lines.push(`const ${coreParamConstant(name, x)}: u32 = ${k}u;`));
      lines.push(`const ${coreParamConstant(name)}: u32 = ${d.values.indexOf(v as string)}u; // '${v as string}'`);
    }
  }
  return lines.length ? `// === Core parameters (${isa.id}; compile-time constants, IsaCore.params) ===\n${lines.join("\n")}\n` : "";
}
