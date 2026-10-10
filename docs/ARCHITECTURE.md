# Zilion architecture (0.3.0-dev)

Zilion computes, for very many (machine, world) pairs at once, what a world does to its memory and which
addresses the machine visited. A **machine** is a byte-code interpreter with a program counter and some
registers (an ISA core). A **world** places programs in a ring of memory, sets the initial state, runs a
budget of steps, and keeps a record. The point of the architecture is that **the world is the same code for
every machine**: comparisons across ISAs (Z80, 6502, BFF, …) are only clean if the world does not change
when the machine does.

This document describes what is implemented on the `m1/architecture` branch. The design it follows is
Algocell's `experiments/planning/ZILION_DESIGN_2026-10-10.md`; the differences are listed at the end.

## Layers

```
 L4  research code (Algocell)       definitions, thresholds, analyses               not in Zilion
 L3  @neovand/zilion-soup           pairing, mutation, soups, genealogy             later (M3)
 ──────────────────────────────────────────────────────────────────────────────────────────────────
 L2  engine      src/engine/        createEngine · Machine · Batch · chunking · typed results
 L1  world       src/world/         buildMachine · memory models · init · budgets · halting · outputs
     manifest    src/manifest.ts    the JSON contract for hosts in any language
 L0  cores       src/cores/<isa>/   z80 (stable) · m6502, bff (skeletons)
     contract    src/contract/      IsaCore descriptor · host contract v2 · ring address math
 ──────────────────────────────────────────────────────────────────────────────────────────────────
     0.2 API     src/legacy/        Zilion · buildComputeShader (byte-identical 0.2 kernel)
```

**Dependency rule.** Lower layers never import higher ones. A core (L0) talks to the world only through the
hooks of the host contract; the world (L1) talks to a core only through its descriptor. `test/unit.mjs`
checks that no file in `src/world/` names a register, opcode or core function of any ISA.

**Packaging.** One package for now (`@neovand/zilion`, with the subpath `@neovand/zilion/z80`). The design
proposes a monorepo with a second package for the soup layer; that package does not exist yet (M3), and
moving every path now would churn the build and publish setup and collide with parallel work in other
branches. The directories above map one to one onto the future `packages/zilion/src/`, so the split is a move,
not a rewrite.

## L0: the IsaCore contract

A core is WGSL text plus a descriptor (`src/contract/isa.ts`). The builder derives everything else from the
descriptor, so a new core writes only its state variables and its step function.

| Descriptor field | Meaning |
|---|---|
| `id`, `name`, `coreVersion`, `status` | `status: 'skeleton'` cores validate the contract and must not be used for results |
| `addressBits` | 16 (Z80, 6502), 20, 32, or **0 for ring-native machines** (BFF), which compute positions themselves |
| `fetchUnitBytes` | width of the `unit` passed to `on_instruction_start`; `on_fetch` is always per byte |
| `state: StateField[]` | the state record, in order: `{ name, bits, wgsl (an lvalue), reset?, randomizable? }` |
| `internals` | per-instruction temporaries (u32 lvalues) the world reset also zeroes |
| `symbols` | `step` (WGSL function), `haltReason` (u32 expression), `pc` (u32 expression) |
| `hooks` | which optional hooks the core can call: `fetch`, `instructionStart`, `trap`, `io` |
| `decode` | the decode (ablation) hook: its WGSL name and parameters, page layouts, what a skip consumes |
| `conventions` | step definition; `stackTop(P, t)`; `entry(pos, P)`; trap causes with as-chip decisions; prose on halting and illegal opcodes |
| `variants`, `compat` | named semantics; `compat` selects historical semantics (the Z80 has only `'0.2'` in this milestone) |
| `wgsl({ variant, compat, hooks })` | the core text; a disabled hook is never called (WGSL has no default functions) |

From the descriptor the builder generates, identically for every ISA: the world reset (`zil_reset`: every
field at its `reset` value, every internal at 0, no reliance on WGSL zero-initialisation), the init
conventions, the state record store and load (`zil_store_state`, `zil_load_state`), the halt test of the run
loop, and the ablation tables.

### Host contract v2

The constants are emitted once per shader (`HOST_CONTRACT_PRELUDE_WGSL`, `src/contract/host.ts`).

| Hook (world side) | Called by | When |
|---|---|---|
| `mem_read(addr) -> u32`, `mem_write(addr, val)` | core | every byte access; `addr` is already reduced to the ISA width; multi-byte accesses are byte accesses at consecutive ISA addresses |
| `on_fetch(addr)` | core, if enabled | before every instruction-stream byte is read (opcode, prefix, operand, displacement) |
| `on_instruction_start(pc, unit) -> u32` | core, if enabled | once per step, after the first unit is fetched; returns `ZIL_CONTINUE`, `ZIL_HALT` (halt, PC stays on the instruction, reason `host`) or `ZIL_SKIP` (consume that unit as a no-op) |
| decode hook, `-> bool` | core, always | once per executed instruction after full decode; `true` skips it (what a skip consumes is per ISA) |
| `zil_trap(cause) -> u32` | core, if enabled | on a trap cause the core lists; returns `ZIL_TRAP_HALT`, `_IGNORE` or `_VECTOR`; without the hook the core does what the chip does |
| `io_in(port) -> u32`, `io_out(port, val)` | core, if enabled | port I/O (Z80 IN/OUT, block I/O) |
| `on_reset()` | world (`zil_begin`) | once per lane, after the reset and the init conventions |

Halt reasons (`haltReason`): 0 running (budget exhausted), 1 `halt-insn` (the ISA's halt instruction), 2
`host` (from `on_instruction_start`), 3 `trap`. Trap causes: `illegal`, `halt-insn`, `unmatched`, `bounds`,
`misaligned`, `div-zero`, `syscall`, `unimplemented`.

### The Z80 core

`src/cores/z80/core.wgsl.ts` generates the core text with `z80CoreText(hooks)`. With every hook off it is the
0.2.0 core **byte for byte** (`Z80_CORE_WGSL`; `npm run check:bytes`). Each hook only adds text at a fixed
insertion point. Order within `z80_step`:

1. `z80_fetch()` of the first byte → `on_fetch(pc)` → read → PC + 1; `r_inc()` (M1);
2. `on_instruction_start(pc, byte)`: `ZIL_HALT` sets `cpu_halted = 2` and backs PC onto the byte (exactly
   Algocell's lethal-tar hunk, with a distinguishable value); `ZIL_SKIP` returns;
3. DD/FD: the next byte (`on_fetch`), `r_inc()`; a wasted prefix returns here (PC backed up);
4. the decode hook `on_fetch_opcode(prefix, op)` for base-page opcodes; DDCB/FDCB fetch the displacement and
   the opcode first; CB and ED pages call it from their own dispatch;
5. execute (operands and displacements through `z80_fetch`, so `on_fetch` sees every instruction byte);
   HALT calls `zil_trap(ZIL_TRAP_HALT_INSN)` when the trap hook is on (`ignore` makes it a 1-byte no-op);
   IN/OUT call `io_in`/`io_out` when the io hooks are on (port `(A << 8) | n` for `IN A,(n)`/`OUT (n),A`,
   `BC` for the `(C)` forms, `BC` before B is decremented for INI/IND and after for OUTI/OUTD; the io hooks
   also add the `OUT (C),r` cases, which are no-ops without them).

Semantics are 0.2's in every configuration: no MEMPTR (WZ), a wasted DD/FD prefix adds 2 to R, IN reads 0
and OUT is a no-op unless the io hooks say otherwise. The fixes come in a separate, `compat`-gated step.

### Anchors

Algocell's shader generators patch the core text. These anchors occur exactly once in the default core **and**
in the core generated with each of the 16 hook combinations (checked by `scripts/check-byte-identity.mjs`); the
commitment holds through 0.3.x:

| Exact text | Used by (Algocell) |
|---|---|
| `"    var op = z80_fetch();\n    r_inc(); // M1: opcode (or prefix) fetch\n"` | `gen_lethal_shader.py`, `gen_dial_shader.py`, `optrace.py` |
| `"    let val = mem_read(cpu_pc);\n    cpu_pc = (cpu_pc + 1u) & 0xffffu;\n    return val;"` | `gen_trace_shader.py` |
| `"var<private> cpu_halted: u32;\n"` | `gen_dial_shader.py`, `gen_conv_shader.py`, `gen_trace_shader.py` |
| `"if (op == 0xddu \|\| op == 0xfdu) {"` before `"if (on_fetch_opcode(pfx, op)) { return; }"` | `gen_lethal_shader.py` |
| `cpu_pc = (cpu_pc + 1u) & 0xffffu`, `cpu_sp = (cpu_sp ± 1u) & 0xffffu`, `cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu` (present) | mutants in `z80difftest_ring.node.ts` |

## L1: the world spec

`buildMachine({ isa, world, mode?, workgroupSize?, variant?, compat?, bindingNames? })` returns
`{ wgsl, manifest }` (`src/world/spec.ts`, `src/world/build.ts`).

### Memory models and the seam

| Model | Positions | Loaded and stored |
|---|---|---|
| `{ kind: 'mask', bytes }` | `addr & (bytes − 1)`, power of two (0.2's model) | all bytes |
| `{ kind: 'ring', bytes: P }` | `addr mod P`, any P ≥ 1, odd included | all P bytes |
| `{ kind: 'segments', segments: [{ bytes, name? }…], ring?: P }` | `addr mod P`, segments back to back from 0, P ≥ their total | the segments; ring bytes after the last segment are **padding**: zeroed at the start of every run, never stored |

Each segment is stored word-padded (`ceil(bytes/4)` u32), as Algocell's `pair_data` is; the manifest gives the
host layout (segments back to back) and the storage layout.

**Seam.** The core forms every address at its own width (16 bits for the Z80); the world maps it. When P does
not divide 2¹⁶, address 0xFFFF sits at position 65535 mod P and 0x0000 at position 0, so a crossing of address
0 lands at (65536 + t) mod P. `seamOffset(P) = 65536 mod P` (16 for P = 40, 31 for P = 33). A ring whose
register arithmetic wraps modulo P is not offered: registers are numbers. Helpers: `ringPos(addr, P, bits)`,
`highestAlias(pos, P, bits)` = 2ʷ − 1 − ((2ʷ − 1 − pos) mod P), `lowestAlias`, `seamOffset`.

### Initial state

`init.state: 'zero'` (default): the world reset, then, in order, `init.stack` (`{ topAliases: t | 'lastByte' }`,
realised by `conventions.stackTop(P, t)`; the Z80's SP = `highestAlias(t, P)`, the 6502's S such that
`0x0100 | S` aliases t), `entry` (`{ position }`, the PC), `init.set` (constants by field name) and
`init.random` (`{ fields?, salt? }`: field k of lane l = `zil_hash(seed, l, k, salt ^ ZIL_SALT_INIT)` masked to
its width; default fields = the randomizable ones). Then the raw `onReset` hook. `'lastByte'` is the last byte
of the last segment (P − 1 without segments), so padding never moves the stack. `init.state: 'perLane'` reads
the whole state record per lane from a buffer instead.

### Budgets

`budget: { unit: 'steps' | 'fetchBytes', value: n | 'perLane' }`. A step is the core's step (Z80: one
instruction, one block-repeat iteration, or a wasted prefix). `fetchBytes` counts instruction-stream bytes
through `on_fetch`, so it is ISA-neutral; a step starts while fewer than `budget` bytes have been fetched.
A number is the default per run (a uniform, no recompile); `perLane` adds a per-lane budget buffer. The run
loop stops at the budget or when the halt reason is non-zero; `steps` counts every executed step, including
the one that halted.

### Halting, traps, dials, ablation

- **Native halt.** As the chip does (Z80 HALT parks PC on the opcode, reason `halt-insn`), or re-policied as a
  trap: `halting.traps['halt-insn'] = 'ignore'`.
- **Lethal first unit.** `halting.lethal: { firstUnit, probability?, salt? }` halts a lane whose instruction
  starts with that unit, judged on the raw unit before prefixes and ablation (Algocell's lethal tar is
  `firstUnit: 0`).
- **Dials.** A probabilistic halt draws `zil_hash(seed, lane, step, salt) < round(p · 2³²)`, a stateless
  counter-based hash; draws do not depend on chunking or order. With salt 0 it equals the BFF kernel's
  `hash32(p·0x9E3779B1 ^ (s+1)·0x85EBCA77 ^ roll_seed)`. Trap policies take the same dial:
  `traps: { unmatched: { halt: { probability: 0.1 } } }`.
- **Trap policies.** Per cause the core lists: `'as-chip' | 'halt' | 'ignore' | 'vector'` (vector only where the
  chip has one) or a dial. The trap hook is emitted only when some policy differs from the chip.
- **Ablation.** `{ expr }` (a WGSL boolean over the decode-hook parameters, 0.2's `fetchHook`) or
  `{ table: 'uniform', layout? }`: a bitset per decode page in the params, bit `key & 31` of word
  `page · wordsPerPage + (key >> 5)`, changed per run without recompiling (the Z80's `coarse` layout is
  Algocell's `params.suppress`, so its masks can be passed unchanged; `fine` has seven pages).

### Outputs and the lane record

Always: `steps`, `haltReason`. Optional: `state` (default on), `memory` (default on), `writeCounts` (one per
segment, then one for padding; `mask`/`ring`: total writes), `fetchMap` (T_S: positions fetched as instruction
stream, `ceil(P/32)` words, uncapped), `startMap` (positions where an instruction started). The record layout
is in the manifest.

### Raw hooks (escape hatch)

`world.hooks`: `declarations`, `onFetch`, `onInstructionStart` (may `return ZIL_HALT;`), `decode` (OR-ed with
the ablation), `trap`, `ioIn`, `ioOut`, `onReset`, with the world privates `zil_lane`, `zil_seed` and
`zil_step` in scope. Raw hooks are where ISA-specific or registered behaviour goes: `test/world/algocell.mjs`
reproduces Algocell's PCG lethality dial and its randreg/randsp conventions bit for bit with them.

### Generated shader

```
header (zilion version, core id/version/variant/compat/hooks, core/world/options SHA-256)
host-contract prelude · zil_hash · world constants (ZIL_MEM_P, ZIL_MEM_WORDS, ZIL_STATE_WORDS, ZIL_RECORD_WORDS)
[kernel] ZilParams { lane_count, lane_base, budget, seed, ablation? } and bindings 0..4
world privates (zil_lane, zil_seed, zil_step, counters, maps) · lane memory zil_m: array<u32, P>
mem_read / mem_write · the hooks the world needs · raw declarations
the core text
zil_reset · zil_init_state · zil_begin(lane, seed) · zil_run(budget) -> steps · memory, state and record I/O
[kernel] main: load memory, zil_begin(lane_base + i, seed), [load state], zil_run, store memory, store record
```

`mode: 'library'` emits only the functions, using `bindingNames` for host-owned buffers (`memory`, `out`,
`stateIn`, and an `ablation` expression such as `params.suppress`), so a soup shader with several entry points
can call `zil_load_memory`, `zil_begin`, `zil_run`, `zil_store_memory`. `zil_begin` resets everything a lane
owns, so a host may run several lanes in one invocation (tested).

## The manifest (L1/L2 boundary)

`ShaderManifest` (`src/manifest.ts`, schema `zilion.manifest/1`) is plain JSON: bindings with roles
(`params`, `memory`, `record`, `stateIn`, `budgetIn`) and per-lane sizes; the params struct as fields with roles
(`laneCount`, `laneBase`, `budget`, `seed`, `ablation`, `constant`, `pad`) and byte offsets; the memory layout
(ring size, position expression, segments with host and storage offsets, padding); the record layout; the state
fields; halt reasons; the ablation layout; budget and init flags; provenance (`zilion`, `hostContract`, core
id/version/status/variant/compat/hooks, SHA-256 of the WGSL, the core text, the world JSON and the options).
`test/world/gpu_runner.py` is a complete Python host that reads nothing else. `legacyMachine(memBytes)`
describes 0.2's `buildComputeShader` kernel the same way. Codegen stays in TypeScript:
`node scripts/export-machines.mjs worlds.json --out shaders/` writes `<name>.wgsl` and `<name>.manifest.json`
for each named spec, and `--check` verifies files already on disk (for CI).

## L2: the engine

```ts
const engine = await createEngine();                 // or { gpu } in Node, or { device }
const m = await engine.machine({ isa: z80, world });  // compile errors → ZilionShaderError with source lines
const r = await m.run(lanes, { budget: 128, seed: 1, ablation }); // any number of lanes
r.steps; r.haltReason; r.stateOf(i); r.memoryOf(i); r.writesOf(i); r.fetchedOf(i); r.startsOf(i);
const b = m.batch(1_000_000);                         // resident lanes in slabs
b.upload(lanes); b.encode(encoder, { budget: 128 }); /* … */ const r2 = await b.read();
```

- **Chunking.** A chunk is the largest lane count within `maxComputeWorkgroupsPerDimension × workgroupSize`,
  `maxStorageBufferBindingSize` and `maxBufferSize` for every per-lane binding (`maxLanesPerChunk`). 0.2's
  `run()` failed above 4,194,240 programs and at 128 MiB of memory; both are now chunked. Each chunk passes
  `lane_base`, so hashes see global lane indices and results are chunk-invariant (tested with a dial).
- **Buffers.** Slabs (one bind group, at most one chunk) are reused between runs and grow only; a read copies
  memory and records into one staging buffer and maps it once.
- **Batches.** `Machine.batch(capacity)` keeps lanes resident across runs (several slabs when needed), exposes
  the buffers for chaining with other kernels, and encodes into the caller's encoder. Params are written with
  `queue.writeBuffer` at encode time, so submit before encoding again with different options.
- **The 0.2 facade.** `Zilion.create/run/destroy` keeps its API and runs the byte-identical 0.2 kernel through
  the same runner, so it is chunked and reuses its buffers; an invalid `fetchHook` now rejects at `create`.

## Testing

| Command | What |
|---|---|
| `npm run check:bytes` | byte identity of the 0.2 configuration against the v0.2.0 tag (built from source) and the published 0.2.0 package; anchors in all hook combinations |
| `npm run test:unit` | address math, hash, SHA-256, validation, hook minimality, manifest invariants, chunk planner, packing, ISA neutrality |
| `npm run test:world` | the world spec on the GPU through `gpu_runner.py` (Python wgpu): hand-computed cases for odd and padded rings, the seam, stack conventions, budgets, halt and trap policies, dials, ablation, maps, init, io hooks; ring = mask, hook neutrality, library = kernel, chunk invariance, 0.2 kernel = mask world; the 6502 and BFF skeletons and one world on three ISAs. Set `ZILION_PYTHON` to an interpreter with `wgpu` and `numpy`. |
| `npm run test:algocell` | 33 conditions against the executors Algocell exported with 0.2.0 (20,000 random pairs each) |
| `test/engine.html` | the engine and the facade on browser WebGPU (`node scripts/serve.mjs`) |

## Differences from the design document

1. **No monorepo yet** (see Packaging).
2. **Fewer per-core WGSL obligations.** The design asks each core for `<id>_reset`, `<id>_store`, `<id>_load`,
   `<id>_halted` and `<id>_pc`. Here the descriptor's state fields (WGSL lvalues), `internals` and `symbols`
   let the builder generate all of them, the same way for every ISA.
3. **`on_reset` is called by the world** (`zil_begin`, after the init conventions), not by the core.
4. **Names.** The decode hook keeps the Z80's 0.2 name `on_fetch_opcode(prefix, op)`; the descriptor declares
   each core's decode-hook name and parameters (`on_decode(page, key)` for the skeletons). Port hooks are
   `io_in`/`io_out`. Library functions are `zil_begin`, `zil_run`, `zil_load_memory`, `zil_store_memory`,
   `zil_store_record`, `zil_load_state`.
5. **Trap causes** gained `halt-insn` (so a world can make HALT a no-op), `bounds` (BFF) and `unimplemented`
   (skeletons); the design's `illegal` policy is the `illegal` trap cause.
6. **Not yet implemented:** `storage` and `sparse` memory models and packed memory; `lethal.decode`; `storage`
   ablation tables; `cycles` budgets; many worlds per dispatch and a params ring for several encodes per submit;
   the CPU twin; `table()`, `disassemble()` and vector adapters on the descriptor.
7. **Write counts:** one counter per segment plus one for padding; Algocell counts padding writes as B's, which
   is the sum of the last two.
8. **The dial threshold** is `round(p · 2³²)` (BFF's convention); Algocell's Z80 dial floors it and uses a PCG
   stream, reproduced exactly through raw hooks.
