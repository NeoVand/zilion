# Changelog

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
