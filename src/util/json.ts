// Canonical JSON: object keys sorted recursively, undefined members dropped. Used for the provenance hashes of
// world specs and build options, so two specs that differ only in key order hash the same.

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined && typeof x !== "function") out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}
