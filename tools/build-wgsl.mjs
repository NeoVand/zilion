#!/usr/bin/env node
// Emit the WGSL that the headless harness (tools/zt.py) runs, from the
// TypeScript sources. This is the only step of the harness that needs Node:
//
//   1. compile src/ -> dist/ with the package's own tsconfig (plain `tsc`, no bundler);
//   2. import the built package and write, into the output directory (default build/wgsl/):
//        manifest.json              provenance: package version, git commit, core SHA-256s, toolchain
//        z80-core*.wgsl             the Z80 core of each configuration the vector harness runs (below)
//        conformance/plan.json      the vectors of test/conformance.js (programs, steps, hook index)
//        conformance/shader-N.wgsl  buildComputeShader(memBytes, { fetchHook }) for each distinct hook (the 0.2 API)
//        conformance/<config>/shader-N.wgsl  the same kernels with the core of a 0.3 configuration substituted
//
// Z80 configurations (manifest.coreConfigs.z80; tools/zt.py selects one with --compat / --variant):
//   z80                 compat '0.3', classic: z80.wgsl({ hooks: { io: true } }) (the default; ports through the host)
//   z80@zilog-nmos      compat '0.3', zilog-nmos: z80.wgsl({ variant: 'zilog-nmos', hooks: { io: true } })
//   z80@0.2             compat '0.2': Z80_CORE_WGSL (the 0.2.0 core, no hooks: the 0.2.0 baseline's core)
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
const Z80_CONFIGS = [
  { key: "z80", file: "z80-core.wgsl", variant: "classic", compat: "0.3", hooks: ["io"],
    export: "z80.wgsl({ hooks: { io: true } })", text: zilion.z80.wgsl({ hooks: { io: true } }) },
  { key: "z80@zilog-nmos", file: "z80-core-zilog-nmos.wgsl", variant: "zilog-nmos", compat: "0.3", hooks: ["io"],
    export: "z80.wgsl({ variant: 'zilog-nmos', hooks: { io: true } })",
    text: zilion.z80.wgsl({ variant: "zilog-nmos", hooks: { io: true } }) },
  { key: "z80@0.2", file: "z80-core-0.2.wgsl", variant: "classic", compat: "0.2", hooks: [],
    export: "Z80_CORE_WGSL", text: zilion.Z80_CORE_WGSL },
];
if (zilion.z80.wgsl({ compat: "0.2", hooks: {} }) !== zilion.Z80_CORE_WGSL) throw new Error("compat '0.2' is not Z80_CORE_WGSL");
const coreConfigs = {
  z80: Z80_CONFIGS.map(({ key, file, variant, compat, hooks, export: ex, text }) => ({
    key, export: ex, variant, compat, hooks, coreVersion: zilion.z80.coreVersion, ...write(file, text),
  })),
};
const cores = { z80: coreConfigs.z80[0] };

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
// The same kernels on the 0.3 cores: buildComputeShader embeds Z80_CORE_WGSL verbatim once; substitute the core of
// the configuration without hooks (the kernel's host has no I/O device), so the conformance programs run on it.
const substituted = Object.fromEntries(
  Z80_CONFIGS.filter((c) => c.compat !== "0.2").map((c) => {
    const core = zilion.z80.wgsl({ variant: c.variant, compat: c.compat, hooks: {} });
    return [c.key, hooks.map((fetchHook, i) => {
      const k = zilion.buildComputeShader(MEM_BYTES, fetchHook ? { fetchHook } : {});
      if (k.split(zilion.Z80_CORE_WGSL).length !== 2) throw new Error("the 0.2 kernel does not embed Z80_CORE_WGSL exactly once");
      return { fetchHook, ...write(`conformance/${c.key.replace("@", "-")}/shader-${i}.wgsl`, k.replace(zilion.Z80_CORE_WGSL, () => core)) };
    })];
  }),
);
const plan = {
  schema: 1,
  memBytes: MEM_BYTES,
  regFields: [...zilion.REG_FIELDS],
  shaders,
  configs: {
    "z80@0.2": { variant: "classic", compat: "0.2", kernel: "buildComputeShader (the 0.2 API, unchanged)", shaders },
    ...Object.fromEntries(Object.entries(substituted).map(([key, sh]) => {
      const c = Z80_CONFIGS.find((x) => x.key === key);
      return [key, { variant: c.variant, compat: c.compat, kernel: "buildComputeShader with the core replaced by z80.wgsl({ variant, compat, hooks: {} })", shaders: sh }];
    })),
  },
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
  coreConfigs,
  conformance: { plan: "conformance/plan.json" },
};
write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.error(
  `[build-wgsl] ${pkg.name}@${pkg.version} z80 cores ` +
    coreConfigs.z80.map((c) => `${c.key} ${c.sha256.slice(0, 12)}`).join(", ") +
    ` -> ${relative(process.cwd(), outDir) || "."}`,
);
