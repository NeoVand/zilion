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

**Fixed (0.2 API, same results)**

- `Zilion.run` no longer fails above 4,194,240 programs (the dispatch limit) or 128 MiB of lane memory: batches
  are chunked against the device limits.
- `Zilion.run` reuses its GPU buffers across runs and reads each chunk back with a single map.
- `Zilion.create` rejects with the compiler's message (and the offending line) when `fetchHook` does not compile,
  instead of failing later.

**Tests**

- `npm run test:world` (GPU via wgpu-py): world semantics with hand-computed expectations, metamorphic and
  invariance checks, the skeleton cores. `npm run test:algocell`: 33 conditions against Algocell's exported 0.2.0
  executors. `npm run test:unit`. `test/engine.html` (browser WebGPU).

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
