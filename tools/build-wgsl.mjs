#!/usr/bin/env node
// Emit the WGSL that the headless harness (tools/zt.py) runs, from the
// TypeScript sources. This is the only step of the harness that needs Node:
//
//   1. compile src/ -> dist/ with the package's own tsconfig (plain `tsc`, no bundler);
//   2. import the built package and write, into the output directory (default build/wgsl/):
//        manifest.json              provenance: package version, git commit, core SHA-256, toolchain
//        z80-core.wgsl              Z80_CORE_WGSL exactly as exported
//        m6502-core.wgsl            HOST_CONTRACT_PRELUDE_WGSL + M6502_CORE_WGSL (the 6502 core, every hook off)
//        conformance/plan.json      the vectors of test/conformance.js (programs, steps, hook index)
//        conformance/shader-N.wgsl  buildComputeShader(memBytes, { fetchHook }) for each distinct hook
//
// Usage: node tools/build-wgsl.mjs [outDir]      (ZILION_SKIP_TSC=1 reuses an existing dist/)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(root, "build", "wgsl"));
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

if (!process.env.ZILION_SKIP_TSC) {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], {
    stdio: "inherit",
  });
}

const zilion = await import(pathToFileURL(join(root, "dist", "index.js")).href);
const { VECTORS, PARALLEL, MEM_BYTES } = await import(
  pathToFileURL(join(root, "test", "conformance.js")).href
);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const write = (rel, text) => {
  const p = join(outDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return { file: rel, sha256: sha256(text) };
};

// --- cores -------------------------------------------------------------------
// Keyed by the harness's ISA name (tools/zt.py vectors <isa>). The 6502 core's text uses the host-contract
// constants (ZIL_HALT_TRAP, ...), so its file is the prelude followed by the core with every hook off.
const m6502 = await import(pathToFileURL(join(root, "dist", "cores", "m6502", "index.js")).href);
const cores = {
  z80: { export: "Z80_CORE_WGSL", ...write("z80-core.wgsl", zilion.Z80_CORE_WGSL) },
  6502: {
    export: "HOST_CONTRACT_PRELUDE_WGSL + M6502_CORE_WGSL",
    core: "m6502",
    coreVersion: m6502.m6502.coreVersion,
    ...write("m6502-core.wgsl", zilion.HOST_CONTRACT_PRELUDE_WGSL + m6502.M6502_CORE_WGSL),
  },
};

// --- conformance plan (test/conformance.js, run headlessly) ------------------
const hooks = [];
const hookIndex = (h) => {
  const key = h ?? null;
  let i = hooks.indexOf(key);
  if (i < 0) i = hooks.push(key) - 1;
  return i;
};
hookIndex(undefined); // shader 0 = no hook (also used by the parallel batch)
const vectors = VECTORS.map((v, index) => ({
  index,
  name: v.name,
  program: Array.from(v.program, (b) => b & 0xff),
  steps: v.steps,
  shader: hookIndex(v.fetchHook),
}));
const shaders = hooks.map((fetchHook, i) => ({
  fetchHook,
  ...write(
    `conformance/shader-${i}.wgsl`,
    zilion.buildComputeShader(MEM_BYTES, fetchHook ? { fetchHook } : {}),
  ),
}));
const plan = {
  schema: 1,
  memBytes: MEM_BYTES,
  regFields: [...zilion.REG_FIELDS],
  shaders,
  vectors,
  parallel: {
    count: PARALLEL.count,
    program: Array.from(PARALLEL.program),
    steps: PARALLEL.steps,
    shader: 0,
  },
};
write("conformance/plan.json", JSON.stringify(plan, null, 2) + "\n");

// --- manifest ----------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tsPkg = JSON.parse(
  readFileSync(join(root, "node_modules", "typescript", "package.json"), "utf8"),
);
const status = git(["status", "--porcelain", "--untracked-files=no", "--", "src"]);
const manifest = {
  schema: 1,
  package: { name: pkg.name, version: pkg.version },
  git: {
    commit: git(["rev-parse", "HEAD"]),
    srcDirty: status === null ? null : status.length > 0,
  },
  toolchain: { node: process.version, typescript: tsPkg.version },
  cores,
  conformance: { plan: "conformance/plan.json" },
};
write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.error(
  `[build-wgsl] ${pkg.name}@${pkg.version} z80 core ${cores.z80.sha256.slice(0, 12)}, ` +
    `6502 core ${cores[6502].sha256.slice(0, 12)} -> ${relative(process.cwd(), outDir) || "."}`,
);
