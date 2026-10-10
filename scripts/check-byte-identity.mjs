#!/usr/bin/env node
// Byte-identity proof for the 0.2 configuration.
//
//   npm run build && node scripts/check-byte-identity.mjs [--ref v0.2.0] [--npm <installed @neovand/zilion dir>]
//                                                       [--algocell <algocell checkout>]
//
// References (each one that is available is checked):
//   git  — src/z80-core.wgsl.ts and src/shader.ts at the tag (default v0.2.0), extracted with `git show`,
//          compiled with the repo's TypeScript into a temporary directory;
//   npm  — the published package as installed (default <algocell>/node_modules/@neovand/zilion, version 0.2.0).
// Against each reference, byte for byte, with the current build (dist/):
//   - Z80_CORE_WGSL, z80CoreText({}) and z80.wgsl({ hooks: {} });
//   - buildComputeShader(memBytes, { fetchHook }) over 11 memory sizes x 6 hook strings, and its default argument;
//   - the errors thrown for invalid memBytes; REG_FIELDS and REGS_PER_PROGRAM.
// Then, once:
//   - every anchor Algocell's shader generators patch (docs/ARCHITECTURE.md, "Anchors") occurs exactly once in the
//     default core AND in the core generated with each of the 16 combinations of v2 hooks;
//   - (with an Algocell checkout) how many of its exported shaders embed the current Z80_CORE_WGSL verbatim.
// Exit status 0 only if every comparison is identical.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const ref = opt("--ref", "v0.2.0");
const algocell = opt("--algocell", process.env.ALGOCELL_DIR ?? resolve(root, "../algocell"));
const npmDir = opt("--npm", join(algocell, "node_modules/@neovand/zilion"));

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

function firstDiff(a, b, label) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}:\n    ${label}: ${JSON.stringify(la[i])}\n    now: ${JSON.stringify(lb[i])}`;
  }
  return "(texts differ only in a trailing newline)";
}

const cur = await import(pathToFileURL(join(root, "dist/index.js")).href);

function compare(label, refApi) {
  const same = (what, a, b) => {
    if (a === b) ok(`${what} (${b.length} bytes)`);
    else bad(`${what}: ${firstDiff(a, b, label)}`);
  };
  same("Z80_CORE_WGSL", refApi.Z80_CORE_WGSL, cur.Z80_CORE_WGSL);
  same("z80CoreText({})", refApi.Z80_CORE_WGSL, cur.z80CoreText({}));
  same("z80.wgsl({ hooks: {} })", refApi.Z80_CORE_WGSL, cur.z80.wgsl({ hooks: {} }));
  same("z80.wgsl({ compat: '0.2', variant: 'classic', every hook false })", refApi.Z80_CORE_WGSL,
    cur.z80.wgsl({ compat: "0.2", variant: "classic", hooks: { fetch: false, instructionStart: false, trap: false, io: false } }));

  const sizes = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096, 65536];
  const hooks = [undefined, "", "   ", "false",
    "(prefix == 0xedu && op == 0xb0u) || (prefix == 0u && (op & 0xcfu) == 0xc5u)", "  op == 0x3eu  "];
  let n = 0;
  let diffs = 0;
  for (const m of sizes) {
    for (const h of hooks) {
      const o = h === undefined ? {} : { fetchHook: h };
      const a = refApi.buildComputeShader(m, o);
      const b = cur.buildComputeShader(m, o);
      n++;
      if (a !== b) {
        diffs++;
        bad(`buildComputeShader(${m}, ${JSON.stringify(o)}): ${firstDiff(a, b, label)}`);
      }
    }
  }
  if (diffs === 0) ok(`buildComputeShader: ${n} configurations (${sizes.length} sizes x ${hooks.length} hook strings) identical`);
  same("buildComputeShader(256) with the default options argument", refApi.buildComputeShader(256), cur.buildComputeShader(256));
  for (const m of [0, 3, 6, 100]) {
    let ea = "";
    let eb = "";
    try { refApi.buildComputeShader(m); } catch (e) { ea = String(e.message); }
    try { cur.buildComputeShader(m); } catch (e) { eb = String(e.message); }
    if (ea && ea === eb) ok(`buildComputeShader(${m}) throws the same error`);
    else bad(`buildComputeShader(${m}) errors differ: ${JSON.stringify(ea)} vs ${JSON.stringify(eb)}`);
  }
  same("REG_FIELDS", JSON.stringify(refApi.REG_FIELDS), JSON.stringify(cur.REG_FIELDS));
  same("REGS_PER_PROGRAM", String(refApi.REGS_PER_PROGRAM), String(cur.REGS_PER_PROGRAM));
}

// --- reference 1: the git tag --------------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "zilion-ref-"));
let checked = 0;
try {
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    console.log(`git: no ref ${ref}; skipped`);
  }
  if (commit) {
    const srcDir = join(tmp, "src");
    const outDir = join(tmp, "out");
    mkdirSync(srcDir);
    for (const f of ["z80-core.wgsl.ts", "shader.ts"]) {
      writeFileSync(join(srcDir, f), execFileSync("git", ["show", `${ref}:src/${f}`], { cwd: root, encoding: "utf8" }));
    }
    execFileSync(
      join(root, "node_modules/.bin/tsc"),
      ["--outDir", outDir, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler",
        "--skipLibCheck", join(srcDir, "shader.ts"), join(srcDir, "z80-core.wgsl.ts")],
      { cwd: root, stdio: "inherit" },
    );
    writeFileSync(join(outDir, "package.json"), '{"type":"module"}');
    const shader = await import(pathToFileURL(join(outDir, "shader.js")).href);
    const core = await import(pathToFileURL(join(outDir, "z80-core.wgsl.js")).href);
    console.log(`Reference git ${ref} (commit ${commit}), compiled from source:`);
    compare(`git ${ref}`, { ...shader, Z80_CORE_WGSL: core.Z80_CORE_WGSL });
    checked++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- reference 2: the published npm package -------------------------------------------------------------------
const npmPkg = join(npmDir, "package.json");
if (existsSync(npmPkg)) {
  const version = JSON.parse(readFileSync(npmPkg, "utf8")).version;
  const api = await import(pathToFileURL(join(npmDir, "dist/index.js")).href);
  console.log(`Reference npm @neovand/zilion@${version} (${npmDir}):`);
  if (version !== "0.2.0") console.log(`  info  installed version is ${version}, not 0.2.0`);
  compare(`npm ${version}`, api);
  checked++;
} else {
  console.log(`npm: no installed package at ${npmDir}; skipped`);
}
if (checked === 0) bad("no reference available (need the git tag or an installed 0.2.0 package)");

// --- anchors -------------------------------------------------------------------------------------------------
console.log("Anchors Algocell's generators patch:");
const ANCHORS = [
  "    var op = z80_fetch();\n    r_inc(); // M1: opcode (or prefix) fetch\n",
  "    let val = mem_read(cpu_pc);\n    cpu_pc = (cpu_pc + 1u) & 0xffffu;\n    return val;",
  "var<private> cpu_halted: u32;\n",
  "if (op == 0xddu || op == 0xfdu) {",
  "if (on_fetch_opcode(pfx, op)) { return; }",
];
const PRESENT = ["cpu_pc = (cpu_pc + 1u) & 0xffffu", "cpu_sp = (cpu_sp + 1u) & 0xffffu", "cpu_sp = (cpu_sp - 1u) & 0xffffu",
  "cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu"];
let anchorFail = 0;
for (let mask = 0; mask < 16; mask++) {
  const h = { fetch: !!(mask & 1), instructionStart: !!(mask & 2), trap: !!(mask & 4), io: !!(mask & 8) };
  const text = cur.z80CoreText(h);
  for (const a of ANCHORS) {
    const c = text.split(a).length - 1;
    if (c !== 1) { anchorFail++; bad(`anchor ${JSON.stringify(a.slice(0, 40))} occurs ${c} times with hooks ${JSON.stringify(h)}`); }
  }
  const at = text.indexOf(ANCHORS[0]) + ANCHORS[0].length;
  if (!(text.indexOf(ANCHORS[3], at) < text.indexOf(ANCHORS[4], at))) {
    anchorFail++;
    bad(`prefix resolution does not precede the decode hook with hooks ${JSON.stringify(h)}`);
  }
  for (const a of PRESENT) if (!text.includes(a)) { anchorFail++; bad(`mutant anchor ${JSON.stringify(a)} missing with hooks ${JSON.stringify(h)}`); }
}
if (anchorFail === 0) ok(`${ANCHORS.length} unique + ${PRESENT.length} present anchors, in all 16 hook combinations`);

// --- Algocell's exported shaders (information) --------------------------------------------------------------
const shaderDir = join(algocell, "experiments/algocell_exp/shader");
if (existsSync(shaderDir)) {
  const files = readdirSync(shaderDir).filter((f) => f.endsWith(".wgsl"));
  let embed = 0;
  for (const f of files) if (readFileSync(join(shaderDir, f), "utf8").includes(cur.Z80_CORE_WGSL)) embed++;
  console.log(`  info  ${embed} of ${files.length} shaders in ${shaderDir} embed the current Z80_CORE_WGSL verbatim` +
    " (the others are derived from them by Algocell's patchers)");
}

console.log(failures === 0 ? `BYTE-IDENTICAL: every comparison matched (${checked} reference(s)).` : `${failures} comparison(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
