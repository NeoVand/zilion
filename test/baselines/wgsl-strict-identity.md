# WGSL strict-expression fix: semantic identity

Reference: `7f223de` (0.3.0). Only `src/cores/i8086/core.wgsl.ts` changes generated executable text. Package/core versions remain 0.3.0 until release. The [recorded results](wgsl-strict-identity.json) contain all per-world output digests, totals and all 16 i8086 hook-specific old/new core hashes.

## Grammar audit and parse evidence

[WGSL §8.19–8.20](https://www.w3.org/TR/WGSL/#operator-precedence-associativity) permits arithmetic precedence, a single shift between unary operands, a single comparison between shift/arithmetic operands, chains of one logical operator over comparisons, or chains of one bitwise operator over unary operands. It forbids unparenthesized mixing between these separate paths. In particular, shifts cannot mix with arithmetic or themselves; bitwise operators cannot mix with arithmetic, shifts, comparisons, logical operators or different bitwise operators; comparisons cannot chain, even with different comparison operators; `&&` and `||` cannot mix.

The stdlib-only checker tokenizes nested comments, parses declarations/types/attributes and all statement expressions, recognizes template closing tokens separately from shifts, and checks each unparenthesized binary AST edge against this grammar. Calls, subscripts, template arguments and parenthesized expressions are checked recursively. Unrecognized syntax fails rather than being skipped. It is a syntax/precedence check; compiler type, uniformity and resource validation remain the compiler's responsibility. Its positive/negative self-tests run with every invocation. Arbitrary user-supplied raw WGSL remains the user's code; representative valid hooks/expressions are included in the generated matrix.

The matrix checks 815 texts: all supported variants/compats of Z80, NMOS 6502, i8086 and BFF, all core hook masks, representative world features, kernel/library mode, every optional-output mask on three memory models, BFF literal parameters, and representative legacy kernels. The old texts produced 276 diagnostics, repeating these two expressions in 138 i8086 texts. The new texts produce zero. All other 677 texts are byte-identical. Each changed text is verified to differ only by the two exact parenthesis insertions and its core-hash provenance comment.

| Generator | Offending expressions | Fix |
| --- | ---: | --- |
| i8086 | 1 logical | `... || (op >= 196u && op <= 199u)` |
| i8086 | 1 bitwise | `((i8086_flags & 213u) | 2u)` |
| Z80 classic / zilog-nmos / compat 0.2 | 0 | No edit |
| NMOS 6502 | 0 | No edit |
| BFF | 0 | No edit |
| World / legacy generators | 0 | No edit |

[Naga v29.0.1's parser](https://github.com/gfx-rs/wgpu/blob/v29.0.1/naga/src/front/wgsl/parse/mod.rs#L694-L849) establishes the following precedence, lowest to highest:

`||`, `&&`, `|`, `^`, `&`, `== !=`, `< <= > >=`, `<< >>`, `+ -`, `* / %`, unary/postfix.

`expression` nests the logical and bitwise levels, `equality_expression` nests comparison/shift/arithmetic levels, and `parse_binary_op` builds a left-associative accumulator. Thus the inserted parentheses preserve the actual parse, including short-circuit behavior and operand evaluation. The installed wgpu-native version was 29.0.1.1 (wgpu-py 0.32.0).

An independent GPU probe evaluated the old expressions alongside the new groupings on 65,536 lanes, exhausting 16-bit FLAGS and all 256 opcode values, and repeating every Boolean truth-table row. Every old/new pair matched. The alternative `flags & (213u | 2u)` differed in 32,768 lanes; `(a || b) && c` differed from `a || b && c` in 16,384 lanes. This distinguishes the actual groupings rather than assuming C precedence. The range expression's alternative grouping happens to agree over opcode values, so the separate Boolean truth table provides the discriminating logical evidence.

## GPU identity

Apple M4, Metal, IntegratedGPU; wgpu-py 0.32.0, numpy 2.5.4. Both versions of every machine are compiled to compute pipelines and receive identical memory, seeds, state, budgets, ablation masks and step base. Memory's first byte also cycles through all 256 opcodes. The experiment compares every output byte: loaded memory and the entire record, including state, steps, halt reason, trap cause, fetch/start maps and write counts when enabled. Dials cross the 32-bit step boundary.

| Configuration | Paired lanes | Worlds | Differences |
| --- | ---: | ---: | ---: |
| Z80 0.3 classic | 262,144 | 8 | 0 |
| Z80 0.3 zilog-nmos | 262,144 | 8 | 0 |
| Z80 0.2 classic | 262,144 | 8 | 0 |
| NMOS 6502 | 262,144 | 8 | 0 |
| i8086 | 262,144 | 8 | 0 |
| BFF | 262,144 | 8 | 0 |
| Total | 1,572,864 | 48 machine pairs | 0 |

The eight worlds cover mask memory, odd rings with randomized registers, padded segments, uniform ablation, expression ablation with lethal/trap dials, fetch-byte budgets, per-lane state/budgets with ignored traps, and raw hooks including I/O. Dispatches use at most 4,096 lanes, with an equal-duration pause (minimum 10 ms) after each. The longest completed identity burst was 0.176680375 s; the runner fails if a completed burst reaches 60 s.

A preliminary run was terminated when its BFF generator randomized IP over 32 bits, allowing a backward bracket scan far beyond the tape. No result from that incomplete attempt is counted. The completed run randomizes BFF heads and constrains per-lane BFF IP/heads to tape positions. This is a test-input correction; generated emulator semantics are unchanged.

## Required suites and hardware vectors

All GPU suites were run sequentially with `ZILION_GPU_DUTY=0.5`, adding equal-duration pauses after dispatches.

- `npm test`: passed; 815 strict texts, 31 unit checks, 7 engine checks, 7 exporter checks, 173 world cases (306 GPU jobs / 245 machines), frozen-byte checks and 600,000 recorded compat-0.2 programs across six worlds (all 60 chunk digests identical).
- Frozen-byte references: git `v0.2.0` / `8557d3b` and installed npm `@neovand/zilion@0.2.0`; 66 legacy kernel configurations per reference plus the default kernel, all 16 recorded hook hashes, constants and error behavior.
- `npm run test:conformance`: 17/17 vectors plus 8,192 parallel lanes for each of three Z80 configurations.
- `npm run test:harness:offline`: 21 unit tests, host probes (15 cases × two memory models), bus-log probes (8 cases × two models), and all four planted rule cases; passed. The offline command intentionally omits vector-dependent mutant/invariance tests.
- 8086 hardware suite: stratified subset of the first 512 cases in each of all 336 opcode/reference files, 172,032 vectors total. 171,502 passed raw; 530 register-far-transfer cases used the unchanged `far-register-hidden-latch` rule. Zero unexpected differences. 168 dispatches of at most 1,024 lanes, 3.19 s total dispatch/readback/pause time and 15.66 s wall time. The full 3,137,000-vector suite was not rerun; the requested stratified subset was used to keep this validation bounded. Ledger SHA-256: `192686322386ca6dd96513c4be1ee393f02b9d236c83be7f1fc49b1624a38b28`.

The new `expected-0.3.1.json` changes only the 8086 core hash, retaining exactly the old rule content. Frozen core SHA-256 remains `8db4015dab560cd075b2f4da7de78b6cc5e2b120034bfbf62590eb49784b2955`. No 0.2 source or recording is edited.

This validation uses naga/Metal and the spec-derived syntax checker. Real browser/Tint verification remains with the coordinator before release.

## Reproduction

Build a separate reference from the pinned commit without switching any other branch:

```sh
mkdir -p build/wgsl-strict/reference
# Extract only the reference sources/configuration; share installed compiler deps.
git archive 7f223de src tsconfig.json package.json | tar -x -C build/wgsl-strict/reference
ln -s "$PWD/node_modules" build/wgsl-strict/reference/node_modules
node node_modules/typescript/bin/tsc -p build/wgsl-strict/reference/tsconfig.json
npm run build
node test/world/wgsl_strict_identity.mjs build/wgsl-strict/reference/dist
.venv/bin/python -I test/world/wgsl_strict_identity.py build/wgsl-strict/identity/plan.json
```

The Python environment needs `wgpu` and `numpy`. The emitter verifies all matrix text edits, audits old/new syntax and emits hash provenance; the runner writes `build/wgsl-strict/identity/report.json` and exits on the first byte difference or completed burst ≥ 60 s.

```sh
ZILION_PYTHON="$PWD/.venv/bin/python" ZILION_GPU_DUTY=0.5 npm test
ZILION_PYTHON="$PWD/.venv/bin/python" ZILION_GPU_DUTY=0.5 npm run test:conformance
ZILION_PYTHON="$PWD/.venv/bin/python" ZILION_GPU_DUTY=0.5 npm run test:harness:offline
ZILION_GPU_DUTY=0.5 .venv/bin/python -I tools/zt.py vectors 8086 \
  ../zilion-vectors/8088/v2 ../zilion-vectors/8088/v2_undefined \
  --limit-per-file 512 --mem-cap 768 --lanes 1024 --workers 1 \
  --json build/wgsl-strict/8086-vectors.json \
  --run-json build/wgsl-strict/8086-vectors.run.json
```
