# Changelog

## 0.3.0 — 2026-10-12

### M1: shared contract, world and batch engine

- Introduce `IsaCore`, host contract v2 and a shared world specification: mask/ring/segmented memory, explicit stack and budget, fixed/random/per-lane initialization, halting and trap policies, dials, ablation and optional write/fetch/start measurements.
- Add `buildMachine`, `createEngine`, device-limit chunking, resident batches, typed results and WGSL compiler diagnostics. Library mode and the machine exporter support hosts that own their buffers.
- Add `zilion.manifest/2` with buffer/record layouts, trap causes, core parameters (including tables), SHA-256 provenance and resumable records with a 64-bit step base.
- Require explicit Z80 compat selection through 0.3.x. Freeze compat 0.2, the legacy API and shader text byte for byte. Check 600,000 recorded programs across six worlds.
- In compat 0.3, correct wasted-prefix R increments, full WZ/MEMPTR, IM, block-repeat flags, ports and frozen host halts. Add the `zilog-nmos` Q-latch variant.
- Validate Z80 classic and zilog-nmos on 1,604,470 instruction tests each with zero unexpected divergences. The frozen 0.2 baseline covers 1,604,384 tests with its 14 explicit historical rules.

### M2: full NMOS 6502 and BFF cores

- Implement all 256 NMOS 6502 opcodes, including decimal mode, undocumented forms, explicit unstable-opcode constants, page/zero-page wrapping, ordered stack accesses and read-modify-write bus writes. Export `m6502` from the root and `/m6502` subpath as experimental.
- Validate 2,560,000 SingleStepTests 6502 cases with zero divergences and zero expected rules. Independently check Clark's NMOS arithmetic algorithm against 310,000 cases and the core against all 1,310,720 inputs across five opcode forms in binary/decimal modes.
- Complete the ring-native BFF core, including brackets, alphabet tables, literal pushes and unmatched/bounds policies. It is available in source and the exporter, and remains excluded from npm exports and package files.
- Record 1,048,576 pairs in each of 20 BFF configurations: all 20,971,520 GPU comparisons and 16,056,320 sampled CPU comparisons match Algocell's `bff.py`; all six negative controls are caught and 4,718,592 dial draws match.

### M3: coherent-fetch 8086/8088 instruction semantics

- Add experimental `i8086` exports, segmented 20-bit addressing, ordered byte writes, REP continuation state, software/divide/type-1 interrupts, original-chip quirks and hardware-validated aliases.
- Declare `prefetch: 'coherent'`: consumed instruction bytes read current memory, with no prefetch queue or cycle timing. Reject queued `8088` mode. Declare `hidden_latch: 'zero_ea'` for deterministic undefined register far transfers; register LEA/LES/LDS trap.
- Validate 3,137,000 hardware vectors in 336 files: 2,657,000 documented and 350,000 alias cases match raw; 130,000 undefined-form cases include 10,083 differences explained by one restricted hidden-latch rule. Zero unexpected divergences; every FLAGS bit and ordered write is compared.
- Add world probes for seams, IVT/stack aliasing, coherent self-modification, REP resume, interrupt boundaries and the seeded bootstrap regression panel. Pin cyclic bootstrap matches of 13/16 at P=32 and 6/16 at P=64 without discarding failures.
- Record Apple M4 throughput on 262,144 random 32-byte pairs, budget 128: 1,091.4 million executed steps/s for Z80, 860.4 for native-JAM 6502, 1,599.7 with JAM ignored, and 333.7 for coherent-fetch Intel. These are warm dispatch measurements, excluding bulk transfers.

### Publication preparation and compatibility fixes

- Update the public README, architecture/testing/core guides, multi-ISA package metadata and lockfile identity. Add software citation metadata and attribution for separately fetched datasets and references; the paper is in preparation.
- Remove local path prefixes from unpublished history and use relative vector paths in public ledgers. Only metadata hashes change; core hashes, comparisons and GPU digests are preserved. Update recorded ledger hashes and reproduce them with the documented commands.
- Add a download-free harness script, ignore downloaded data/local environments and update the throughput runner to the named coherent-fetch selection.
- Preserve legacy outcomes while chunking large `Zilion.run` batches, serializing instance runs, reducing readback maps and reporting shader errors during creation.
- Keep the validation ledgers named `*-v0.3.0-dev.*`: they record the development build that was validated. The release version changes manifest provenance and generated shader headers, while core hashes, the frozen 0.2 shader text and recorded GPU outcomes remain unchanged.

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
