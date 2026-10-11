"""Generic per-instruction vector runner (ISA-agnostic) and its ISA adapters.

  model.py    Field, Rule and the packed per-file batch (FileBatch)
  sst.py      parser for the SingleStepTests JSON layout, parameterised by an adapter
  host.py     the WGSL test host: sparse-table or full-64K memory, port tables, state record in and out
  runner.py   batching, dispatch, readback
  ledger.py   comparison, ignore masks / expected rules, the divergence ledger and its report
  z80.py      the Z80 adapter (SingleStepTests/z80 on the Zilion core)
  m6502.py    the 6502 adapter (SingleStepTests/65x02 6502/v1 on the Zilion NMOS core)
"""
