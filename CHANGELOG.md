# Changelog

## 0.3.0-dev — unreleased (branch `m1/architecture`)

Architecture milestone M1 (work items 4, 5, 7 and 8 of the design). **No behaviour change for the 0.2 API**:
`Z80_CORE_WGSL` and `buildComputeShader` emit the 0.2.0 text byte for byte (`npm run check:bytes`, against the
v0.2.0 tag and the published package), and the Z80's semantics are unchanged in every configuration (no MEMPTR;
a wasted DD/FD prefix still adds 2 to R). Not published.

**Added**

- `IsaCore`: the plug-in contract for instruction-set cores (state record, symbols, hooks, decode pages,
  conventions, variants, `compat`). The Z80 is one core behind it (`z80`, also at `@neovand/zilion/z80`).
- Host contract v2 (opt-in, `z80CoreText(hooks)`): `on_fetch`, `on_instruction_start` (continue, halt, skip),
  `zil_trap` (the HALT instruction can be re-policied), `io_in`/`io_out` (with the `OUT (C),r` cases), and
  `on_reset` from the world. Every anchor Algocell patches stays byte-stable in all hook combinations.
- `buildMachine({ isa, world })` → WGSL + JSON manifest. The world spec: mask, ring (any P, odd included) and
  segments-on-a-padded-ring memory; the 16-bit seam semantics and helpers (`ringPos`, `highestAlias`,
  `seamOffset`); init conventions (world reset from the descriptor, stack top, entry, constants, counter-based
  random fields, per-lane state); budgets in steps or fetched bytes, uniform or per lane; native halt, lethal
  first unit, dials from a stateless hash, per-cause trap policies; ablation by expression or uniform bitset;
  outputs (steps, halt reason, state record, writes per segment and padding, fetch map, instruction-start map);
  kernel and library modes; raw hooks as an escape hatch.
- The engine: `createEngine`, `Machine.run` (any batch size), resident `Batch`es, typed `MachineResult`s,
  `ZilionShaderError` with the offending source lines, `legacyMachine` (a manifest for the 0.2 kernel).
- Skeleton 6502 (NMOS) and BFF cores that validate the contract (not exported; not for results).
- Provenance: `ZILION_VERSION`, `HOST_CONTRACT`, SHA-256 of the WGSL, core text, world and options in every
  manifest and shader header.
- Docs: `docs/ARCHITECTURE.md`, `docs/ADDING_A_CORE.md`; the README options table now lists `fetchHook`.

**Contract decisions of 2026-10-10 (branch `m1/contract`; docs/ARCHITECTURE.md, the decisions)**

- *Breaking (0.3-dev API):* a world must state its budget (`budget: { unit, value }`, both fields) and, on an ISA
  with a stack, `init.stack` (or load the state per lane); the build fails and names the missing field. Presets
  `compat02World` (0.2's `Zilion.run` world) and `algocellPairWorld` state both. `scripts/export-machines.mjs` also
  requires the ISA to be named.
- `init.stack: { firstPushAt: t | 'lastByte' }`: the first byte pushed lands at t on every ISA (descriptor
  `conventions.firstPushAt`). `topAliases` keeps its per-ISA meaning; giving both is an error.
- Follow-up: `init.set` or `init.random` covering every stack field (Z80 `sp`, 6502 `s`) counts as giving the stack;
  a stackless ISA (BFF) accepts `init.stack`, validates it and does not apply it, so one world spec serves every
  ISA; `manifest.init.stack` records how the stack was set (convention, set, random) or why it was not
  (`notApplicable: 'no stack' | 'per-lane state'`). The defaults that remain are listed in docs/ARCHITECTURE.md.
- The lane record carries `trapCause` (word 2; 0 when the lane did not halt on a trap), from the descriptor's
  `symbols.trapCause`; codes in `manifest.trapCauses`. The skeletons gain a `trap` state field.
- Core parameters: a descriptor may declare `params` (u32, bool, enum); a machine selects them with
  `core: { isa, params }`; the builder validates them, emits `ZIL_PARAM_*` constants ahead of the core text and
  records them in `manifest.core.params`.
- Resumable runs: a 64-bit `stepBase` in the params reaches every dial draw (`zil_draw`, CPU mirror `zilDraw`), and
  a `resume` flag continues lanes from their record and memory (state, steps, write counts, maps, padding).
  Engine: `run(memory, { resume, stepBase })`, `Batch.encode({ resume, stepBase })`, `Batch.uploadRecords`;
  `MachineResult.trapCause`/`trapCauseOf`. Library: `zil_begin_at`, `zil_resume`, `zil_set_step_base`.
- Manifest schema `zilion.manifest/2`: the record's `trapCause` (later fields move by one word) and `padding`;
  params `stepBase` and `resume` (the ablation table moved from byte 16 to 32); `trapCauses`, `resumable`,
  `core.params`.
- Unchanged: the 0.2 kernel and the Z80 core text, byte for byte (`npm run check:bytes`), and the anchors.

**Z80 fixes (work item 3; branch `m1/z80-fixes`; docs/ARCHITECTURE.md, "The Z80 core")**

- *Behaviour changes (the Z80 of `buildMachine`; `compat: '0.2'` restores 0.2.0 exactly):* the current Z80 is
  `compat: '0.3'` (`coreVersion` 0.3.0), which a machine names explicitly (see below). A wasted DD/FD prefix adds 1 to R (0.2: 2). MEMPTR (WZ) is modelled in
  full and `BIT n,(HL)` takes F3/F5 from it. IM is modelled. A repeating block instruction takes X/Y from its own
  address (INxR/OTxR also adjust H and P/V) and sets WZ = PC + 1. `OUT (C),r` and `OUT (C),0` exist without the io
  hooks. A lane halted by the host is frozen (0.2 kept adding 1 to R per further step). The state record gains
  `wz` and `im` (appended; compat `'0.2'` keeps its 25 fields).
- *Unchanged:* the 0.2 API (`Zilion`, `buildComputeShader`, `Z80_CORE_WGSL`) and the compat `'0.2'` text in every
  hook combination, byte for byte (`npm run check:bytes`, now with the SHA-256 of all 16 hooked 0.2 texts); the
  anchors, in all three semantics.
- *Added:* variant `zilog-nmos` (the Q latch: SCF/CCF X/Y = ((Q ⊕ F) | A); state field `q`); `z80_reset()` and
  `z80_run(budget)` in the core text; halt-reason constants (`Z80_HALT_INSN` …, equal to the contract's);
  `z80CoreText(hooks, { compat, variant })` and the `Z80Semantics` type; the optional descriptor method
  `stateFor({ variant, compat })` (the state record per selection), used by the builder.
- *Fixed:* the 0.2 kernel's manifest (`legacyMachine`) hashes the core it embeds (`Z80_CORE_WGSL`) and reports
  `coreVersion` 0.2.0.
- *Breaking (0.3-dev API), follow-up decisions:* a Z80 machine must name its compat (`'0.3'` or `'0.2'`) in the core
  selection or run a world that states it; there is no default through 0.3.x (descriptor `compatRequired`). Worlds
  may state the semantics they were written for (`world.compat: { z80: '0.2' }`); the presets `compat02World` and
  `algocellPairWorld` state `'0.2'`, and a core selection that names a compat takes precedence. Manifests report the
  semantics that ran: `core.coreVersion` is 0.2.0 under compat `'0.2'` (descriptor `coreVersionFor`). A host halt in
  `zilog-nmos` leaves Q as it was (the halting step executes no instruction); a skipped unit clears it.
- *Validation:* SingleStepTests/z80 (1,604,000 tests) plus 384 wasted-prefix vectors and 86 R/WZ probes: 0
  unexpected with only the rules Q, Q-XY (not modelled by `classic`) and EI-P (no interrupts); `zilog-nmos`: 0 unexpected with EI-P only; `--compat 0.2` reproduces the
  0.2.0 ledger byte for byte. 86 hand-derived R and WZ probes (`tools/z80-probe-vectors.py`). Baselines
  `test/baselines/z80-v0.3.0-dev.*` and `z80-v0.3.0-dev-zilog-nmos.*`.
- *Tests and harness:* `tools/zt.py vectors|conformance --compat --variant` (recorded in the run record); conformance
  on all three semantics; self-test mutants for each fix (the 0.2 behaviour of each must be caught) and for the Q
  latch; `npm run test:compat` (design §5.5: 600,000 random programs against outputs recorded from 0.2.0);
  `test/world/cases_z80.mjs`.

**Fixed (0.2 API, same results)**

- `Zilion.run` no longer fails above 4,194,240 programs (the dispatch limit) or 128 MiB of lane memory: batches
  are chunked against the device limits.
- `Zilion.run` reads each chunk back with a single map (0.2 mapped twice). Its lifecycle is unchanged: each run
  owns its buffers and releases them before it resolves, runs may overlap, and `destroy()` does not affect a run
  already called.
- `Zilion.create` rejects with the compiler's message (and the offending line) when `fetchHook` does not compile,
  instead of failing later.

**Tests**

- `npm run test:world` (GPU via wgpu-py): world semantics with hand-computed expectations, metamorphic and
  invariance checks, the skeleton cores. `npm run test:algocell`: 33 conditions against Algocell's exported 0.2.0
  executors. `npm run test:unit`. `npm run test:engine` (mock device: read snapshots, lifecycle, limits).
  `test/engine.html` (browser WebGPU).

**Internal**

- Sources moved: `src/cores/z80/` (core and descriptor), `src/contract/`, `src/world/`, `src/engine/`,
  `src/legacy/` (`Zilion`, `buildComputeShader`). Root exports are unchanged plus the new API.

## 0.2.0 — 2026-10-07

**Breaking:** the host hook is now prefix-aware.

- `on_fetch_opcode(prefix: u32, op: u32) -> bool` replaces `on_fetch_opcode(op: u32)`.
  It fires once per executed instruction after full prefix resolution, so CB-, ED-,
  DD/FD- and DDCB/FDCB-page instructions can be ablated individually. Previously the
  hook only ever saw the first opcode byte, so e.g. `LDIR` (`ED B0`) could not be
  targeted without removing the whole ED page.
- Prefix bytes are no longer reported to the hook. A skipped CB/ED opcode is a 2-byte
  NOP; a skipped DDCB/FDCB opcode is a 4-byte NOP; base-page semantics are unchanged.
- New `fetchHook` option on `Zilion.create` / `buildComputeShader`: a WGSL boolean
  expression over `prefix` and `op` for instruction ablation.
- Conformance suite gains five hook vectors (`test/conformance.js`).

## 0.1.2

- Complete the ED page: `IN r,(C)` flags and block I/O.

## 0.1.1

- Model the `R` refresh register and `HALT` semantics.

## 0.1.0

- First scoped release as `@neovand/zilion`.
