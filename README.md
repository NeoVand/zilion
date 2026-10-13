<p align="center">
  <img src="assets/logo.png" width="160" alt="Zilion logo" />
</p>

<h1 align="center">Zilion</h1>

<p align="center"><b>Many small machines. One GPU. One shared world.</b></p>

Zilion is a **multi-ISA WebGPU batch emulator** for Z80, NMOS 6502, coherent-fetch 8086/8088 instruction semantics, and BFF. It executes independent programs in parallel, with one machine per GPU invocation and private memory per lane. A shared world specification makes memory mapping, initialization, budgets, halting, instruction ablation and measurements consistent across instruction sets.

It is intended for artificial life, genetic programming, program search and batch instruction testing. It generates WGSL compute shaders and manifests from TypeScript, runs batches through a WebGPU engine, and can export machines for other hosts, including Python. There are no JavaScript runtime dependencies. Zilion originated in [Algocell](https://github.com/NeoVand/algocell).

**Zilion 0.3.0 is the current npm release.** It includes the multi-ISA API. The accompanying paper is in preparation.

## Cores and compatibility

| Core | Semantics | Status and availability |
|---|---|---|
| Z80 | Documented and undocumented prefix pages, shadow registers, ports through optional hooks, WZ/MEMPTR and IM; `classic` or `zilog-nmos` with the Q latch | Stable; root export `z80` and `@neovand/zilion/z80` |
| NMOS 6502 | All 256 opcodes, decimal arithmetic, stable undocumented instructions, explicit unstable-opcode constants and JAM policies | Experimental; root export `m6502` and `@neovand/zilion/m6502` |
| 8086/8088 | Segmented 20-bit addressing, coherent instruction fetch, REP continuations, software/type-1 interrupts and hardware-validated aliases | Experimental; root export `i8086` and `@neovand/zilion/i8086`; [machine definition](docs/I8086.md) |
| BFF | Ring-native two-head tape machine, bracket matching, configurable alphabet, literal push and halt dials; equivalence to Algocell's `bff.py` | Stable core in this checkout; available to the machine-export CLI, currently excluded from npm exports and package files |

A Z80 machine must select **`compat: "0.2"` or `"0.3"` explicitly** throughout 0.3.x. Compat 0.2 is frozen: the bare core, legacy shader generator and recorded GPU outcomes are byte-identical to 0.2.0. The legacy `Zilion`, `buildComputeShader` and `Z80_CORE_WGSL` exports retain those semantics.

Compat 0.3 fixes wasted-prefix refresh counts, MEMPTR, IM, block-repeat flags and frozen host halts. `zilog-nmos` additionally models the Q latch. A manifest records the selected semantics and their core version, separately from the package version. The 6502 and Intel cores use compat 0.3; BFF uses compat `bff.py` and core version 1.0.0.

## Build and quick start

```sh
git clone --branch next https://github.com/NeoVand/zilion.git
cd zilion
npm ci
npm run build
```

Use a WebGPU-capable browser in a secure context or a host that supplies a `GPUDevice`. Node needs a WebGPU backend; Node alone does not provide one. The following runs in a browser module served from this checkout:

```js
import { createEngine, z80 } from "./dist/index.js";

const engine = await createEngine(); // or createEngine({ device: yourGPUDevice })
try {
  const machine = await engine.machine({
    core: { isa: z80, compat: "0.3", variant: "zilog-nmos" },
    world: {
      memory: { kind: "ring", bytes: 32 },
      init: { stack: { firstPushAt: "lastByte" } },
      budget: { unit: "steps", value: 16 },
      outputs: { state: true, memory: true },
    },
  });

  // LD A,0x42 ; INC A ; HALT. Each array is a separate lane.
  const result = await machine.run([[0x3e, 0x42, 0x3c, 0x76]]);
  console.log(result.stateOf(0).a); // 67 (0x43)
  console.log(result.haltReasonOf(0)); // "halt-insn"
  console.log(result.memoryOf(0)); // final 32-byte image
} finally {
  engine.destroy();
}
```

`Machine.run` accepts a flat `Uint8Array` of lane memories or an array of programs, and splits large batches against device limits. `machine.batch(n)` keeps a batch resident on the GPU and can encode into a host command encoder. Results expose memory, state, executed steps, halt reasons and trap causes; optional outputs include write counters and fetch/start maps.

The legacy API remains available for 0.2 semantics:

```js
import { Zilion } from "./dist/index.js";
const cpu = await Zilion.create({ memBytes: 256 });
try {
  const result = await cpu.run([[0x3e, 0x42, 0x3c, 0x76]], { steps: 16 });
  console.log(result.registers[0].af >> 8); // 67
} finally {
  cpu.destroy();
}
```

## IsaCore and the world specification

An **IsaCore** is WGSL plus a descriptor: state fields, a step function, address/fetch widths, decode pages, hooks, stack/entry conventions, traps, named semantics and optional compile-time parameters. Cores access bytes through the host and report every state value needed to resume execution. The world and engine operate through that descriptor.

A **world** defines:

- Memory: power-of-two masks, rings of any positive size, or named segments on a padded ring. ISA addresses wrap at the ISA width before world mapping; odd rings expose that seam.
- Initialization: reset values, explicit stack placement, selected fixed/random fields, or per-lane state. `firstPushAt` names the ring position of the first byte written by a push across ISAs.
- Budget: explicit steps or fetched instruction bytes. A step follows the core's declared convention; an Intel REP iteration is one step.
- Policies: native halts, traps, probabilistic halt dials and instruction ablation, either compiled expressions or per-run bitsets.
- Measurements: final memory/state, halt/trap codes, writes, fetched instruction bytes and instruction-start positions.

The stateless dial hash uses seed, global lane, step and salt. Chunked and resumed runs preserve it when the host supplies the corresponding lane/step bases and records. `buildMachine` emits WGSL and a `zilion.manifest/2` JSON manifest with buffer layouts, selected parameters and SHA-256 provenance. Library mode emits functions for a shader that owns its buffers.

Read [Architecture](docs/ARCHITECTURE.md) for the complete contract and [Adding a core](docs/ADDING_A_CORE.md) for the implementation and validation checklist. Export machines without a JavaScript GPU host:

```sh
node scripts/export-machines.mjs --list-cores
node scripts/export-machines.mjs machines.json --out build/exported
```

The input is an array of `{ "name", "core": { "isa", "compat" }, "world" }` selections. The exporter can select every built core by id, including BFF.

## Validation ledgers

These are instruction/state checks, not cycle-accuracy claims. Expected rules are explicit, narrowly scoped and tested with planted faults. **Zero unexpected divergences does not mean zero raw divergences.** Reports contain the full coverage, rules, input hashes and reproduction details.

| Configuration | Tests | Raw architectural passes | Unexpected divergences | Report |
|---|---:|---:|---:|---|
| Z80 compat 0.2 | 1,604,384 | 1,557,549 | 0; 14 expected rules | [Frozen baseline](test/baselines/z80-v0.2.0.md) |
| Z80 compat 0.3, classic | 1,604,470 | 1,602,260 | 0; Q, Q-XY and EI-P rules | [Classic baseline](test/baselines/z80-v0.3.0-dev.md) |
| Z80 compat 0.3, zilog-nmos | 1,604,470 | 1,604,470 | 0; EI-P rule for internal interrupt latches | [NMOS baseline](test/baselines/z80-v0.3.0-dev-zilog-nmos.md) |
| NMOS 6502 | 2,560,000 | 2,560,000 | 0; no expected rules | [6502 baseline](test/baselines/6502-v0.3.0-dev.md) |
| 8086 coherent fetch | 3,137,000 | 3,126,917 | 0; one hidden-latch rule covering 10,083 cases | [Architectural baseline](test/baselines/8086-architectural.md) |

The Z80 inputs are 1,604,000 upstream tests plus 384 locally derived wasted-prefix tests; 0.3 also includes 86 R/WZ probes. The 6502 set covers every opcode. Its [decimal gate](test/baselines/6502-decimal-clark.md) checks Clark's algorithm against 310,000 upstream cases, then checks all **1,310,720** inputs of five opcode forms across binary and decimal modes.

The Intel ledger comprises **2,657,000 documented**, **350,000 alias**, and **130,000 undefined-form** tests in 336 files. Every FLAGS bit and ordered memory write is compared. The one rule covers CS/IP and unlisted reads for four undefined register far-transfer forms whose initial hidden latch is absent from the hardware vectors. Queue state and cycle timing are excluded. Independent world probes cover small-ring aliasing, coherent self-modification, interrupt boundaries, REP resumes and the frozen bootstrap panel.

[BFF equivalence](test/baselines/bff-equivalence.md) checks **1,048,576 pairs in each of 20 configurations** (20,971,520 GPU comparisons), with zero differences against Algocell's GPU reference. The CPU reference covers every pair in the first 15 configurations and 65,536 pairs in each of the remaining five: **16,056,320 CPU comparisons**. All six negative controls are caught; **4,718,592** dial-hash draws match. BFF's external reference checkout is required for reproduction.

### Fetch and reproduce

Use Node 22+ and Python 3.11+ with `wgpu` and `numpy`; BFF reference tests also need `pytest`. For example:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install 'wgpu==0.32.0' 'numpy==2.5.3' pytest
export ZILION_PYTHON=.venv/bin/python

# No vector download is needed for these gates.
npm test
npm run test:conformance
npm run test:harness:offline
npm run typecheck
```

Datasets remain **outside the repository**. Fetch these pinned revisions; the fetchers verify Git blob hashes and write local manifests:

```sh
python3 -I tools/fetch-vectors.py SingleStepTests/z80 \
  ebe1875d48f374bcfd4b505d8eb8ee751568b5f7 v1/ ../zilion-vectors/z80
python3 -I tools/fetch-vectors.py SingleStepTests/65x02 \
  2f6980a2d95757486c7bee24355c360e40e2a224 6502/v1/ ../zilion-vectors/6502
python3 -I tools/fetch_8088.py --download --out ../zilion-vectors/8088
```

The Intel fetcher pins `aea84484abc79d09639d855b7b0ab32bc9e4dbeb`; its compressed vectors occupy **804,548,868 bytes** and are refused if the selected set exceeds 3 GB. Then run:

```sh
npm run test:vectors:0.2
npm run test:vectors
npm run test:vectors:nmos
npm run test:vectors:6502
npm run test:vectors:8086
npm run test:harness

# Requires an Algocell checkout; the default quick gate uses 131,072 pairs/config.
ALGOCELL_DIR=../algocell npm run test:bff
# Full recorded BFF baseline (CPU sampling follows the report):
"$ZILION_PYTHON" -I test/world/bff_equiv.py --algocell ../algocell \
  --pairs 1048576 --cpu 1.0
```

[Testing](docs/TESTING.md#baselines) gives commands to write canonical JSON ledgers and Markdown reports, including exact digest checks. Public ledgers use relative vector directories; removing local directory prefixes changes their metadata hashes while preserving core hashes, every vector comparison and GPU output digests. Use the documented directory spellings to reproduce canonical bytes. Dataset licences and reference attribution are in [THIRD_PARTY.md](THIRD_PARTY.md).

## Measured throughput

[Apple M4 measurements](test/baselines/8086-throughput.md): 262,144 lanes, random 32-byte pair rings, 128-step budget, median of five warm dispatches. Timing includes restoring pristine lane memory and a small queue fence, and excludes bulk upload/readback. Rates count **executed world steps**, including early halts; they are not chip cycles.

| Configuration | ms per dispatch | Million executed steps/s |
|---|---:|---:|
| Z80 compat 0.3 classic, native HALT | 28.96 | 1,091.4 |
| NMOS 6502, native JAM | 15.32 | 860.4 |
| NMOS 6502, JAM ignored | 20.98 | 1,599.7 |
| 8086 coherent fetch | 89.48 | 333.7 |

This is a local pilot workload. Different halt rates, memory sizes, instruction mixes, device limits and host overhead affect throughput. Reproduce after building:

```sh
node test/bench/bench-cores.mjs --lanes 262144 --reps 5 --budgets 128 \
  --json build/test/throughput.json
```

## Limitations

- Zilion is a batch interpreter, not a complete computer emulator. There is no cycle timing, external IRQ/NMI input, peripheral model or coprocessor execution. Budgets count steps or instruction-stream bytes; cycle budgets are unimplemented.
- **The Intel core has coherent fetch and no prefetch queue.** It reads consumed instruction bytes from current memory. This changes self-modifying-code behavior relative to a queued 8086/8088 and must be named in experiments. `prefetch: "8088"` is rejected. The deterministic `hidden_latch: "zero_ea"` policy is not a prediction of unspecified hardware latch state; register LEA/LES/LDS trap. See [I8086](docs/I8086.md).
- The Z80 has no interrupt delivery. Compat 0.2 retains its documented historical simplifications. Classic 0.3 leaves the Q latch unmodelled; use `zilog-nmos` for that behavior. Without port hooks, Z80 input reads zero and output is discarded; Intel input reads FF per byte and output is discarded.
- The 6502 is NMOS only. Unstable-opcode constants match the pinned vectors and need not describe every physical chip. Dummy reads and cycle timing are omitted; ordered writes are modelled.
- BFF is available in the checkout and exporter but currently omitted from the npm package interface. Full external-reference CPU validation is expensive, and Algocell has no repository licence file.
- GPU validation was measured on Apple M4/Metal. Cross-backend bit identity has not been measured; Linux software-adapter CI is documented but not configured. Real-device tests exercise the WGSL through wgpu-py; JavaScript engine handling is additionally checked with mocks and a browser test page.
- Worlds currently use private per-lane memory. Storage/sparse world memory, packed memory, storage ablation tables, a generic CPU twin and soup/population dynamics are not implemented. Raw hooks require host discipline; not every raw-hook machine can resume.

## Citation and licence

The paper introducing Zilion is **in preparation**; there is no paper DOI yet. Cite the software and the exact commit used. [CITATION.cff](CITATION.cff) provides machine-readable metadata:

> Mostafa 'Neo' Mohsenvand (MIT Media Lab). *Zilion: a multi-ISA WebGPU batch emulator*. Version 0.3.0. https://github.com/NeoVand/zilion.

Zilion is [MIT licensed](LICENSE). See [CHANGELOG](CHANGELOG.md) for release history and [third-party attribution](THIRD_PARTY.md) for separately downloaded validation data and semantic references.
