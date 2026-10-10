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
//   - Z80_CORE_WGSL, z80CoreText({}, { compat: '0.2' }) and z80.wgsl({ compat: '0.2', hooks: {} });
//   - buildComputeShader(memBytes, { fetchHook }) over 11 memory sizes x 6 hook strings, and its default argument;
//   - the errors thrown for invalid memBytes; REG_FIELDS and REGS_PER_PROGRAM.
// Then, once:
//   - the compat '0.2' core text with each of the 16 combinations of v2 hooks has the SHA-256 recorded when the hooks
//     were introduced (they add text to the 0.2.0 core; 0.2.0 itself has no hooks), and z80.wgsl gives the same text;
//   - every anchor Algocell's shader generators patch (docs/ARCHITECTURE.md, "Anchors") occurs exactly once, and the
//     mutant anchors are present, in the core of every semantics (compat '0.2'; compat '0.3' classic and zilog-nmos)
//     generated with each of the 16 hook combinations;
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
  same("z80CoreText({}, { compat: '0.2' })", refApi.Z80_CORE_WGSL, cur.z80CoreText({}, { compat: "0.2" }));
  same("z80.wgsl({ compat: '0.2', hooks: {} })", refApi.Z80_CORE_WGSL, cur.z80.wgsl({ compat: "0.2", hooks: {} }));
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

// --- the compat '0.2' text with hooks ---------------------------------------------------------------------------
// SHA-256 of z80CoreText(hooks) for hook mask 0..15 (bit 0 fetch, 1 instructionStart, 2 trap, 3 io), recorded at
// de3f24e (the merge of m1/architecture), before the 0.3 semantics existed. Mask 0 is the 0.2.0 core.
const HOOKED_02 = [
  "8db4015dab560cd075b2f4da7de78b6cc5e2b120034bfbf62590eb49784b2955", "f39d1bae1820aab4bfd7c43979f8763e3701bae37d02701c0206ca61cb0eac8c",
  "b6a24abe42ae8ecb1790fd42bdf1c667b1fc4bef1a8ca682df0c2a259a600cd7", "e6795a6a5718f9330f7a1fe3cb6373abd837121fb51c2068cff185579ec56e9a",
  "ccac41a7b4675ed713f0fc9324cb22e70ef97e46dbe0556bc80ad0e7d6aad489", "507b90281c28a2aaee977add765149969d6e0c43c2f526b19d981a95c34af8c8",
  "521fcd1292fc01c5eef100a6c3ee36268a3960d098b22aa2a696d76574e33249", "ae303c3364a0b4d54a1de0d3e36f1f3c0a65edc80a63e0b40e1c6b3736458eab",
  "91da408c4bf64eb6ad43bf27fac0e7b479e680bb62b0fdf1f49000409bcefa81", "d9d05a127489c1a93718eba9dcb3be489dee2b04746f5e5136089f704916a15e",
  "f7057384e3b8ca14d6bfa3fc20e520a7756313e81e4dde25729637c8bc1c40f6", "6a38afb610762b1a36190b70eeb1d2930c87831c7cf6d2768161ee9d8e438cf3",
  "f35ae0711e199c9311c649641eb6c87f1fdbda0a34177006c439a881265424e2", "0d571d8824215e9cd10a9f0561d0067678f13603bf65da59956ce028cf08929c",
  "7a1de7428b3eb9760cf8148f292261c4350b7c63d02c17dad434131cb21776ff", "2187e6f5614a81540dbc8af7e4f8665831cd0de7aa502e5c74332d46ad2f5376",
];
const hooksOf = (mask) => ({ fetch: !!(mask & 1), instructionStart: !!(mask & 2), trap: !!(mask & 4), io: !!(mask & 8) });
{
  const { createHash } = await import("node:crypto");
  let bad02 = 0;
  for (let mask = 0; mask < 16; mask++) {
    const h = hooksOf(mask);
    const text = cur.z80CoreText(h, { compat: "0.2" });
    const sha = createHash("sha256").update(text).digest("hex");
    if (sha !== HOOKED_02[mask]) { bad02++; bad(`compat '0.2' core with hooks ${JSON.stringify(h)} has SHA-256 ${sha}, recorded ${HOOKED_02[mask]}`); }
    if (cur.z80.wgsl({ compat: "0.2", hooks: h }) !== text) { bad02++; bad(`z80.wgsl({ compat: '0.2', hooks: ${JSON.stringify(h)} }) differs from z80CoreText`); }
  }
  if (bad02 === 0) ok("compat '0.2' core text: all 16 hook combinations match their recorded SHA-256 (z80.wgsl and z80CoreText)");
}

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
const SEMANTICS = [{ compat: "0.2" }, { compat: "0.3", variant: "classic" }, { compat: "0.3", variant: "zilog-nmos" }];
let anchorFail = 0;
for (const sem of SEMANTICS) {
  for (let mask = 0; mask < 16; mask++) {
    const h = hooksOf(mask);
    const text = cur.z80CoreText(h, sem);
    const where = `with hooks ${JSON.stringify(h)}, ${JSON.stringify(sem)}`;
    for (const a of ANCHORS) {
      const c = text.split(a).length - 1;
      if (c !== 1) { anchorFail++; bad(`anchor ${JSON.stringify(a.slice(0, 40))} occurs ${c} times ${where}`); }
    }
    const at = text.indexOf(ANCHORS[0]) + ANCHORS[0].length;
    if (!(text.indexOf(ANCHORS[3], at) < text.indexOf(ANCHORS[4], at))) {
      anchorFail++;
      bad(`prefix resolution does not precede the decode hook ${where}`);
    }
    for (const a of PRESENT) if (!text.includes(a)) { anchorFail++; bad(`mutant anchor ${JSON.stringify(a)} missing ${where}`); }
  }
}
if (anchorFail === 0) ok(`${ANCHORS.length} unique + ${PRESENT.length} present anchors, in all 16 hook combinations of ${SEMANTICS.length} semantics (compat '0.2'; '0.3' classic and zilog-nmos)`);

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
