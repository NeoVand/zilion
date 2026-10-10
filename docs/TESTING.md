# Testing Zilion

Zilion's test suites run headlessly on a real WebGPU device. Node turns the TypeScript sources into WGSL; Python
runs that WGSL through [wgpu-py](https://github.com/pygfx/wgpu-py) and does everything else.

| Suite | Command | What it checks | GPU |
|---|---|---|---|
| Conformance | `npm run test:conformance` | the 17 known-answer programs and the 8,192-program batch of `test/conformance.js` | yes |
| Vectors | `npm run test:vectors` | every instruction against per-instruction golden vectors (SingleStepTests/z80, plus analytic vectors) | yes |
| Harness self-test | `npm run test:harness` | the harness itself: unit tests, planted divergences, mutated cores, memory-model invariance, determinism | yes |

The browser page `test/index.html` still runs `test/conformance.js` through `Zilion.run`. It is a demo, not a gate.

## Requirements

- **Node 22 or later** (tested with v24.21.0) and the package's dev dependencies (`npm ci`). Only `typescript` is
  used; there is no bundler.
- **Python 3.11 or later** (tested with 3.12.12) with `wgpu` (tested 0.32.0) and `numpy` (tested 2.5.3). Nothing
  else is needed.
- **A WebGPU adapter.** Metal on macOS; Vulkan on Linux, where CI uses Mesa's lavapipe (see
  [Linux CI](#linux-ci-documented-not-set-up)).

The npm scripts call `${ZILION_PYTHON:-python3}`. Point `ZILION_PYTHON` at the interpreter that has wgpu-py, for
example Algocell's `experiments/.venv/bin/python`. Every harness command runs Python with `-I` (isolated mode):
neither the current directory nor `PYTHONPATH` is on the import path. The scripts add their own directory
explicitly.

| Variable | Meaning |
|---|---|
| `ZILION_PYTHON` | Python used by the npm scripts (default `python3`) |
| `ZILION_NODE` | Node used by the harness to emit WGSL (default: `node` on `PATH`) |
| `ZILION_Z80_VECTORS` | SingleStepTests/z80 directory for `test:vectors` and `test:harness` (default `../zilion-vectors/z80`) |
| `ZILION_ALLOW_CPU_ADAPTER=1` | permit a CPU adapter (lavapipe, llvmpipe, SwiftShader, WARP); refused otherwise |
| `ZILION_ADAPTER=<text>` | only consider adapters whose device name or backend contains `<text>` (e.g. `vulkan`, `llvmpipe`) |
| `ZILION_SKIP_TSC=1` | `tools/build-wgsl.mjs` reuses the existing `dist/` instead of running `tsc` |

## How the pieces fit

```
src/*.ts ──tsc──▶ dist/ ──tools/build-wgsl.mjs──▶ build/wgsl/  manifest.json, z80-core.wgsl, conformance/*
                                                      │
                     tools/zt.py  (Python, wgpu-py) ◀─┘
                       ├─ conformance ─▶ GPU ─▶ results ─▶ tools/conformance-check.mjs (the original checks)
                       ├─ vectors     ─▶ test host + core ─▶ GPU ─▶ ledger (JSON, Markdown)
                       └─ selftest
```

- **Emission** (`tools/build-wgsl.mjs`). Runs `tsc -p tsconfig.json` into `dist/`, imports the built package, and
  writes `Z80_CORE_WGSL`, the conformance shaders (`buildComputeShader(256, { fetchHook })` for each distinct hook)
  and `manifest.json`. The manifest records the package version, the git commit and whether `src/` was modified, the
  core's SHA-256, and the Node and TypeScript versions. The harness checks the SHA-256 of every WGSL file it reads.
  Every `tools/zt.py` command emits first unless given `--no-emit`.
- **GPU layer** (`tools/ztest/gpu.py`). A real GPU is preferred: discrete, then integrated, then virtual; Metal or
  Vulkan before D3D12 before GL. A CPU adapter is used only with `ZILION_ALLOW_CPU_ADAPTER=1`. The device is
  requested with the WebGPU **default limits**, so whatever passes here fits on lavapipe too. Bind-group layouts are
  explicit, and WGSL compiler errors are raised with the compiler's message (exit code 2).

**Why wgpu-py and not Node + Dawn.** Design §6.1 named Node + Dawn (`webgpu` on npm) as the primary engine. That is
a new native dependency. wgpu-py is already what Algocell's runs use, locally and on Modal. Codegen stays in
TypeScript, as design §2.2 asks. A Dawn engine can be added later by replacing the dispatch layer: the WGSL, the
data layout and the ledger do not depend on the host language.

## Conformance

`python -I tools/zt.py conformance` runs the vectors of `test/conformance.js` unchanged:

1. it compiles the shaders emitted from the public `buildComputeShader`;
2. it runs each vector as its own one-program batch, as the browser page does. `tools/ztest/conformance.py` is a
   Python twin of `Zilion.run`'s packing: memory zero-padded to `memBytes`; registers all 0 except SP = 0xFFFF;
   `Params {count, memBytes, steps, 0}`; bindings 0–3; `ceil(count/64)` workgroups;
3. it runs the 8,192-program parallel batch (`PARALLEL` in `test/conformance.js`);
4. it passes the raw registers and memory to `tools/conformance-check.mjs`, which applies the **original `check`
   functions** in Node.

The vectors and checks therefore have a single source. What the port cannot cover is `Zilion.run`'s own buffer
handling in TypeScript. Only a WebGPU host runs that code: the browser page now, or Node + Dawn later.

## Per-instruction vectors

```sh
python -I tools/zt.py vectors z80 ../zilion-vectors/z80 test/vectors/z80/analytic \
    --json build/test/z80.json --md build/test/z80.md
python -I tools/zt.py vectors z80 ../zilion-vectors/z80 --files 'ed b?' 'cb 4?'     # some opcode files
python -I tools/zt.py vectors z80 ../zilion-vectors/z80 --files 'ed 70' --test 'ed 70 0012'   # one test
```

Options: `--files` (fnmatch patterns over opcode keys), `--test` (test names), `--limit-per-file N`,
`--memory sparse|full`, `--repeat N`, `--lanes`, `--mem-cap`, `--port-cap`, `--workers`, `--expected <rules.json>`,
`--json`, `--run-json`, `--md`, `--analysis <included.md>`, `--dump-wgsl <file>` (the composed test shader).

Exit codes: **0**, every divergence is explained by an expected rule; **1**, at least one unexpected divergence;
**2**, harness error (bad data, capacity exceeded, WGSL that does not compile, adapter missing).

### The vector data is untrusted

- The vectors live **outside the repository** (for example `../zilion-vectors/z80`). They are not committed, not in
  npm `files`, and the harness never writes into their directory.
- They are parsed only as JSON, gzip-decompressed when the name ends in `.gz`, by `tools/ztest/vectors/sst.py`.
  Every state value must be a JSON integer inside its field's width; RAM entries must be `[address, byte]` within
  the address width; port entries must be `[port, byte, "r"|"w"]`. Anything else is a harness error, never a test
  result.
- Nothing in a vector file is executed, used as a path or used as a format string. Opcode keys come from file names
  and are matched against patterns only.
- The ledger records each file's SHA-256 and a digest over all files, so a baseline names its exact inputs. Design
  §6.2 adds a fetch script that pins a commit and a SHA-256 per file; until then the digests are the record.

### The test host

`tools/ztest/vectors/host.py` composes one WGSL module: the host, the ISA glue from the adapter, then the unchanged
core text. One invocation (lane) runs one test:

```
zt_mem_begin(); zt_load_state(lane); for (s < steps) { <isa>_step(); } zt_store_state(lane); zt_mem_end();
```

- **State record.** One u32 per field, in the adapter's field order. Fields the core does not model are copied from
  input to output by the glue (*passed through*). Their divergences then show exactly where the instruction changes
  the field.
- **Memory, `sparse` (default).** Each lane has a table of (address, word) where word = value | READABLE | WRITTEN.
  The table is pre-filled with every address the vector lists, the initial RAM together with the final RAM, sorted;
  READABLE marks the initial-RAM ones. Reads and writes search the table linearly. A write to an unlisted address is
  appended and flagged as a *stray write*. Any address width works.
- **Memory, `full`.** Each lane gets 64 KiB plus READABLE/WRITTEN bitmaps in a storage buffer, cleared before every
  dispatch. The listed initial RAM is scattered in before the run. Afterwards the listed addresses are gathered back
  into the same table, and the WRITTEN bitmap is scanned for stray writes, so both models produce the same table
  (stray writes are appended in write order by `sparse` and in address order by `full`). It is limited to 16-bit
  address spaces and 1,024 lanes per dispatch (128 MiB default binding limit). The self-test requires the two models
  to give identical ledgers.
- **Unlisted reads.** A read of an address that is neither in the initial RAM nor written earlier in the step
  returns 0 and sets ST_UNLISTED_READ. The vectors list every address the reference touched, so this means the core
  read something the reference did not.
- **Ports.** `io_read(port)` consumes the vector's `"r"` entries in order (unlisted: 0xFF and ST_UNLISTED_PORT);
  `io_write(port, value)` appends to a log that is compared with the `"w"` entries. These are the host-contract hooks
  of design §1.3(b); a core that does not call them (Zilion 0.2.0) simply never reaches them.
- **Capacity.** 32 table slots and 8 port slots per lane by default (`--mem-cap`, `--port-cap`). The parser keeps at
  least 8 slots free for stray writes. Overflowing either is a harness error, never a divergence.

Default batches are 65,536 lanes per dispatch (`sparse`) and 1,024 (`full`). `--repeat N` runs every dispatch N
times and fails unless the outputs are byte-identical.

### Comparison and the ledger

For every test the ledger forms one divergence row:

- **state fields:** `expected XOR actual`, masked to the field's width. For F, the set bits name the flags that differ;
- **`mem`:** 1 = a listed address ends with the wrong value (or the reference wrote a final-only address and the
  core did not); 2 = stray write; 4 = unlisted read;
- **`ports`:** 1 = the port-write log differs (count, order, port or value); 2 = a listed port read never happened;
  4 = a read of an unlisted port.

Fields are grouped into **columns**. Architectural columns: `regs`, `f`, `r`, `iff`, `im`, `mem`, `ports`.
Internal columns: `wz` (MEMPTR), `q`, `ei/p`. They are reported separately, so "architectural pass" never depends on
internal latches.

**Expected rules** (`test/vectors/<isa>/expected-<version>.json`) are the ignore masks. Each rule has an `id`,
`files` (fnmatch patterns over opcode keys), `fields`, an optional bit `mask`, an optional `when` predicate, a
`reason` and a `source`. A rule *explains* the masked bits of its fields, in its files, for the tests where its
predicate holds. Whatever no rule explains is **unexpected**. The rules file also declares which fields the core
passes through (`passthrough`). If that does not match what the adapter detects in the core text, the run stops: the
rules then describe a different core.

Predicates keep rules honest. The Z80 rules for Q-XY, BIT-HL-XY and R-WASTED use **model-checking predicates**: a
divergence is explained only if the vector follows the documented hardware formula *and* Zilion follows its known
0.2.0 formula. A different error in the same bits stays unexpected; the self-test plants exactly such mutants to
prove it.

Per opcode file and field, the ledger keeps:

- the number of diverging tests;
- the OR of the differing bits;
- the number of unexpected tests and their bits;
- the rules that explained the rest;
- up to three **minimal examples** of anything unexpected, ordered by the fewest unexpected fields, then the fewest
  differing bits, then file order.

The report groups unexpected divergences into classes (prefix group × set of unexpected fields). For each class it
gives one reproducer: the instruction bytes, the full initial state and RAM, the diff, and the command that re-runs
that single test. A rule that explains nothing in the files that ran is listed as having no hits, which means stale
or not exercised.

Outputs:

- `--json`: the canonical ledger, with sorted keys and no timestamps. It is byte-identical across runs on the same
  inputs, core and harness;
- `--run-json`: adapter, timings, dispatch counts and the ledger's SHA-256;
- `--md`: the report. `--analysis` includes a hand-written section verbatim, so the report can be regenerated
  without losing it.

### The Z80 adapter

`tools/ztest/vectors/z80.py` maps SingleStepTests/z80 onto `Z80_CORE_WGSL`:

- **State.** pc sp a b c d e f h l i r ix iy af_ bc_ de_ hl_ iff1 iff2 im ei p wz q, plus the host-only `halted`.
  The registers, I, R and IFF1/2 load into the core's `cpu_*` variables; the shadow pairs split into
  `cpu_a2`/`cpu_f2` and so on. `wz`, `im` and `q` map to `cpu_wz`, `cpu_im` and `cpu_q` when the core declares
  them; otherwise they are passed through. `ei` and `p` (the EI-delay and LD A,I/R interrupt latches) are always
  passed through. Before the step, `cpu_halted` and the per-instruction `idx_*` state are cleared. No core semantics
  change; the host only sets and reads state.
- **One test = one `z80_step()`**: one instruction including its prefixes, one iteration of a block instruction, or
  one wasted DD/FD prefix. SingleStepTests' `cycles` are not compared: Zilion is not cycle-accurate.
- **HALT-PC.** Zilion parks PC on the HALT opcode; a Z80, and the vectors, leave PC after it. When the core reports
  `halted`, the adapter reports PC + 1. The ledger counts every test where it did (`mapped.halt_pc`), and a
  self-test mutant shows that a core which fails to halt is still caught.
- **Hooks.** The 0.2.0 `on_fetch_opcode` hook is stubbed to "never ablate".
- **Reference set.** SingleStepTests/z80 v1 has 1,604 files: base (252; every opcode except CB/DD/ED/FD), CB (256),
  ED (80: 40–7F and the block group), DD and FD (252 each), DDCB and FDCB (256 each, named `dd cb __ xx`). The report
  lists which of them were absent.
- **Analytic vectors** (`test/vectors/z80/analytic/`, written by `tools/z80-analytic-vectors.py`). SingleStepTests
  has no wasted-prefix tests (DD or FD followed by DD, FD or ED). These 384 vectors encode the documented rule: one
  M1 cycle, R + 1 in the low 7 bits, PC + 1, nothing else changes. The interrupt latches and Q are 0 before and after,
  so the vectors make no claim about them.

### Adding an ISA

An adapter is a class with:

- `isa`, `addr_bits`, `fields` (a tuple of `Field(name, bits, column, architectural, compare, key)`), `columns`,
  `group_order`, `step_call`, `file_glob`;
- `key_of(path)`, `group(key)`, `sort_key(key)` and, optionally, `reference_keys()`;
- `state_values(json_state)`: the default is a flat key lookup; override it for nested layouts;
- `glue(core_text)`: the WGSL `zt_load_state` / `zt_store_state`, plus stubs for any hooks the core calls that the
  host does not provide; it sets `passthrough`;
- `postprocess(batch, outputs)`: convention mappings, returning counts;
- `predicate(name, batch, outputs)`: named conditions for rules;
- `instruction_bytes(test)` and `compact_state(state)`, for reports.

Register it in `ADAPTERS` (`tools/ztest/vectors/session.py`) and the `vectors` command's `isa` choices, and write
`test/vectors/<isa>/expected-<version>.json`. For the planned targets:

- **6502 (SingleStepTests/65x02).** Flat state `pc s a x y p` and 16-bit RAM: the default parser fits. JAM opcodes
  need a halted convention, like HALT-PC.
- **8086/8088 (hardware-generated).** Registers are nested under `regs`, so override `state_values`. Addresses are
  20-bit (`addr_bits = 20`), so only `sparse` memory applies. The prefetch queue fields are not architectural state
  and are not compared.

`tools/ztest/selftest.py`'s probe core is a complete minimal adapter, about 30 lines.

## Baselines

`test/baselines/<isa>-v<version>.md` and `.json` record a core's divergences. The Z80 baseline for 0.2.0 was made
with:

```sh
python -I tools/zt.py vectors z80 ../zilion-vectors/z80 test/vectors/z80/analytic \
    --json test/baselines/z80-v0.2.0.json --run-json build/test/z80-v0.2.0.run.json \
    --md test/baselines/z80-v0.2.0.md --analysis test/baselines/z80-v0.2.0.analysis.md
```

**Workflow for the Z80 fixes (work item 3).**

1. Copy `expected-0.2.0.json` to `expected-<new version>.json`.
2. Delete the rules the change fixes, and update `passthrough` (for example, remove `wz` once the core declares
   `cpu_wz`).
3. Run the vectors. A fix that works leaves no unexpected divergences and no stale rules; a regression shows up as
   an unexpected class with a reproducer.

A future CI gate should fail on any unexpected divergence (exit 1) and on any rule with no hits whose files ran.

## Self-tests and unit tests

- `python -I -m unittest discover -s test/harness` runs the GPU-free unit tests: parser validation of malformed
  data, rule patterns, the rules files, WGSL symbol detection, the reference file set.
- `python -I tools/zt.py selftest --vectors <z80 dir>` checks the harness itself:
  1. **host-probe.** A probe core drives every host path with 15 planted cases (listed, unlisted and final-only
     memory; stray writes; wrap at 0xFFFF; port reads and writes) in both memory models. The ledger must report
     exactly the planted divergences.
  2. **mutants.** Single-line mutations of the Z80 core: R not incremented, wrong PUSH byte, wrong INC flags, a wrong
     SCF X/Y that is not the Q effect, a wrong BIT n,(HL) X/Y that is not the WZ effect, DJNZ never branching, HALT
     not halting, a NOP that reads or writes memory. Each must produce unexpected divergences in the field it breaks.
     Mutants whose vector files are absent are skipped and say so.
  3. **memory-model invariance.** `sparse` and `full` give identical ledgers on real vectors.
  4. **determinism.** Two sessions give the same canonical ledger, and repeated dispatches give identical bytes.

## Determinism

- Every lane is independent and integer-only, with no atomics and no shared memory, so GPU outputs are a pure
  function of the inputs.
- The ledger is aggregated in file order with deterministic tie-breaks and serialised canonically.
- Two digests are recorded:
  - the **ledger SHA-256**, over the canonical JSON;
  - the **GPU output digest**, a SHA-256 over the raw per-file outputs taken before the HALT-PC mapping.
- Checks: `--repeat 2` compares bytes across dispatches. The self-test compares two whole sessions. Re-running the
  baseline command must reproduce the ledger SHA-256 printed in the report.
- Across backends (Metal versus lavapipe), an integer-only core should give identical digests. Any difference is a
  compiler or driver bug worth reporting. This has not been measured yet, because no Vulkan machine was available.

## Linux CI (documented, not set up)

Nothing here is configured in the repository. This is how CI would run the suites on Linux with a software Vulkan
driver (design §6.7):

```yaml
# .github/workflows/test.yml (sketch)
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-24.04, macos-14]          # lavapipe (Vulkan, CPU) and Metal
    runs-on: ${{ matrix.os }}
    env:
      ZILION_PYTHON: python3
      ZILION_Z80_VECTORS: ${{ github.workspace }}/vectors/z80
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - name: Software Vulkan (Linux)
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y mesa-vulkan-drivers libvulkan1   # lavapipe + the Vulkan loader
          echo "VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json" >> "$GITHUB_ENV"
          echo "ZILION_ALLOW_CPU_ADAPTER=1" >> "$GITHUB_ENV"     # lavapipe reports adapter_type CPU
          echo "ZILION_ADAPTER=vulkan" >> "$GITHUB_ENV"          # never fall back to GL/llvmpipe
      - run: npm ci
      - run: pip install "wgpu==0.32.*" "numpy==2.*"            # CI only; prebuilt wheels bundle wgpu-native
      - name: Vectors (cached, pinned commit, SHA-256 checked)
        uses: actions/cache@v4
        with: { path: vectors, key: sst-z80-<pinned commit> }
      # - run: <fetch script: pinned commit, per-file SHA-256; design §6.2>   (only on a cache miss)
      - run: npm run test:conformance
      - run: npm run test:harness
      - run: python3 -I tools/zt.py vectors z80 "$ZILION_Z80_VECTORS" test/vectors/z80/analytic --limit-per-file 100
```

Notes:

- **lavapipe** is Mesa's CPU Vulkan driver. wgpu-py's Linux wheels bundle wgpu-native, which loads the system
  Vulkan loader (`libvulkan1`) and the ICD named by `VK_ICD_FILENAMES`. Its adapter reports `adapter_type: CPU`,
  hence `ZILION_ALLOW_CPU_ADAPTER=1`. `ZILION_ADAPTER=vulkan` keeps the harness off a GL adapter if one is also
  enumerated.
- **Default limits.** The harness requests no extra limits, and lavapipe meets the WebGPU defaults.
- **Per pull request:** conformance, harness self-test, unit tests, and the vectors at `--limit-per-file 100`
  (about 160,000 tests). **Nightly:** the full vector set, plus `--memory full` as a second memory model.
- **Runtime.** On an Apple M4 the full Z80 set (1.6 M tests) is dominated by JSON parsing, not by the GPU (see the
  baseline's Runtime row). lavapipe's GPU share will be larger; it is unmeasured.
- The vector data is fetched in CI, never vendored. A cache keyed by the pinned commit avoids refetching.
