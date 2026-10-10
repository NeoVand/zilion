# Adding a core

A core is WGSL text plus an `IsaCore` descriptor (`src/contract/isa.ts`). The world (`buildMachine`) and the
engine use nothing else, so a core that satisfies this checklist runs in every world: rings of any size,
padded pairs, budgets, dials, ablation, fetch and start maps, the Python host. Read `docs/ARCHITECTURE.md`
first. The two skeletons in `src/cores/m6502/` and `src/cores/bff/` are short, complete examples of the shape.

## Checklist

### 1. WGSL

- **State** as `var<private>` variables with the core's prefix (`m6502_a`, `bff_ip`; the Z80 keeps its 0.2
  `cpu_*` names). Every value the next step depends on must be a **state field**. Internals (below) are
  per-instruction temporaries: a step must not depend on their value at its start, because a resumed lane
  continues from its state record with every internal at 0 (the Z80 clears its index-prefix internals at the top
  of every step).
- **A step function** (`<id>_step()`), executing exactly one step as the descriptor defines it. It returns at
  once when the core is halted.
- **Memory only through the host**: `mem_read(addr) -> u32` and `mem_write(addr, val)`, one byte each, with
  `addr` reduced to the ISA width. Decompose multi-byte accesses into byte accesses at consecutive ISA-masked
  addresses (never a word read at a position). Ring-native cores (`addressBits: 0`) pass positions and compute
  them modulo `ZIL_MEM_P`.
- **Hooks only at the canonical points**, and only when `o.hooks` enables them (WGSL has no default
  functions, so a disabled hook must not be called):
  - `on_fetch(addr)` before reading every instruction-stream byte;
  - `on_instruction_start(pc, unit)` once per step after the first unit: `ZIL_HALT` sets the halt reason to
    `ZIL_HALT_HOST` with PC on the instruction, `ZIL_SKIP` consumes that unit as a no-op;
  - the decode hook (always, if the descriptor has `decode`) once per executed instruction after full decode;
    `true` skips the instruction. What a skip consumes is documented in `decode.skip`; the rule is opcode units
    only, operands run as code;
  - `zil_trap(ZIL_TRAP_<CAUSE>)` for every trap cause, with as-chip behaviour inline when the hook is off;
    **every path that halts on a trap records the cause** in state (see `symbols.trapCause` below): with the hook
    on and off, as-chip and re-policied alike;
  - `io_in(port)` / `io_out(port, val)` for port I/O.
- **Halt reasons** in a u32 the descriptor names: `ZIL_RUNNING`, `ZIL_HALT_INSN` (the ISA's halt instruction),
  `ZIL_HALT_HOST`, `ZIL_HALT_TRAP`.
- **The trap cause** that halted the core, as a `ZIL_TRAP_<CAUSE>` code (0 otherwise), recoverable from state
  fields alone. A core whose only halting trap is evident from its halt state can derive it (the Z80:
  `select(0u, ZIL_TRAP_HALT_INSN, cpu_halted == 1u)`); otherwise keep a state field for it (the skeletons'
  `trap`, set next to `halted` in every trap path) and report it only while the halt reason says trap
  (`select(0u, m6502_trap, m6502_halted == ZIL_HALT_TRAP)`), so a running lane never reports a cause.
- **Core parameters**, if the descriptor declares any, are read only through the builder's constants
  `ZIL_PARAM_<NAME>` (and `ZIL_PARAM_<NAME>_<VALUE>` for enum values; see docs/ARCHITECTURE.md, Core parameters).
  They are compile-time constants, so branching on them costs nothing. Never turn one into a uniform.
- Use the prelude constants (`ZIL_*`), never their numeric values. Stay inside the WGSL subset a CPU twin can
  transpile (u32/i32/bool, `select`, `switch`, `if`/`for`/`loop`, private scalars and arrays).

### 2. Descriptor

Fill every field of `IsaCore`: identity and `status` (`skeleton` until the core is conformance-tested);
`addressBits`; `fetchUnitBytes`; `state` (record order, widths, WGSL lvalues, non-zero `reset` values,
`randomizable`); `internals`; `symbols` (`step`, `haltReason`, `pc` and `trapCause`, the last an expression over
state fields); the hooks it can call; `decode` (hook name and parameters, page layouts as WGSL expressions over
them, the skip rule); `conventions` (step definition; the two stack conventions, both functions or both null:
`firstPushAt(P, t)`, the state that makes the first byte pushed land at ring position t, and `stackTop(P, t)`, the
state whose stack pointer aliases t, with the ISA's own meaning; `entry(pos, P)`; trap causes with the chip's
decision; prose on halting and illegal opcodes); `variants` and `compat`; optional `params` (name →
`{ type: 'u32' | 'bool' | 'enum', default, values? }`, names and enum values lower snake case, checked by
`checkCoreParamDecls`); `wgsl(options)` (which also receives the resolved `params`). Keep `firstPushAt` a small
function of its own (`z80FirstPushAt`, `m6502FirstPushAt`): it is the cross-ISA meaning of the stack, and worlds
compared across ISAs rely on it. Both stack conventions must succeed on a ring of one byte (`P = 1, t = 0`): the
builder calls them there to learn the stack fields (the keys they assign), so that a world that sets every stack
field with `init.set` or `init.random` may omit `init.stack`. Add a new trap cause to `TRAP_CAUSES` (`src/contract/host.ts`) only if no
existing cause fits; the list is shared by every ISA.

### 3. Tests

- **World tests** (`test/world/cases_cores.mjs` shows the pattern): instantiate the shared families with the
  core's own probe programs — a jump to an absolute address, a relative branch, a push, a store and a load —
  on odd and padded rings, across the seam, with every halting policy and the maps, with hand-computed
  expectations, including the trap cause of every trap path. Add the core to the `firstPushAt` case (the first
  push lands on the last byte on rings of 32 and 33 bytes and on a padded pair) and to the "one world, three ISAs"
  case, and run a split run (`stepChunks`, k = 1, 2, 7) against one dispatch: it catches state the record misses.
- **Conformance vectors** (separate work item: the generic per-instruction runner): data-only vectors with a
  divergence ledger; the state record and `zil_load_state`/`zil_store_state` are generated from the
  descriptor, so the adapter only maps field names.
- **Conventions document**: step, reset state, stack-top rule, halting, illegal opcodes and traps, skip
  semantics, unstable opcodes.

## What the 6502 (NMOS) still needs

The skeleton runs LDA/LDX/LDY #, STA zp/abs, INX, PHA, PLA, JMP abs, NOP, BRK and the 12 JAM opcodes, and traps
`unimplemented` on everything else. Its tests pass on the GPU, including the page-1 stack convention, a BRK
vector read through positions 65534 mod P and 65535 mod P, and JAM re-policied as a no-op. The contract needed
**no change** for it. A full core needs:

1. **The instruction set**: all 151 documented opcodes and every addressing mode, with the NMOS address
   quirks inside the core: zero-page indexed modes and the `(zp,X)` / `(zp),Y` pointer fetch wrap within page 0;
   `JMP ($xxFF)` reads its high byte from `$xx00`; page crossings change no result. Decimal-mode ADC/SBC with
   NMOS flag behaviour. `PHP`/`BRK` push B and bit 5 set; `PLP`/`RTI` ignore them.
2. **Undocumented opcodes**: the stable ones (LAX, SAX, DCP, ISC, SLO, RLA, SRE, RRA, ANC, ALR, ARR, SBX, the
   multi-byte NOPs) and the unstable ones (ANE/XAA, LXA, SHA, SHX, SHY, TAS) with their magic constant pinned as
   a named variant; the vectors decide.
3. **A `cmos` variant** (65C02): undefined opcodes are NOPs of defined lengths (trap `illegal` as-chip `ignore`
   with the right length), BRK clears D, the `JMP ($xxFF)` fix, the new opcodes.
4. **Conformance**: SingleStepTests/65x02 through the generic vector runner (needs a `sparse` memory model,
   not in this milestone; state I/O already comes from the descriptor).
5. **Points found by the skeleton**:
   - *Stack-top meaning* (resolved, decision 1): `init.stack.firstPushAt: t` makes the first push land at t on
     every ISA; the 6502's `m6502FirstPushAt` is the same S as its `stackTop`, the Z80's is one above. The full
     core keeps `m6502FirstPushAt` as is.
   - *Halt-cause detail* (resolved, decision 2): the record's `trapCause` says `illegal` for JAM and
     `unimplemented` for an opcode the skeleton lacks. The full core keeps the `trap` state field and sets it in
     every trap path (`symbols.trapCause: "m6502_trap"`).
   - *Decimal mode* is a candidate core parameter (decision 4).
   - *Cycle budgets* (M4) need a per-opcode table including page-crossing penalties.

## What BFF still needs

The skeleton is ring-native: it runs `< > { } + - . ,` with heads modulo `ZIL_MEM_P`, maps bytes to op ids
through the ASCII alphabet before the decode hook, ends an encounter with trap `bounds` when the instruction
pointer leaves the ring (`ignore` wraps it: Algocell's `ip_wrap`), and stubs the brackets. Its tests pass,
including the shared pair world. The contract needed **no change** for it. To be bit-identical to Algocell's
`experiments/micro/bff.py` (the M2 exit criterion) the core needs:

1. **Brackets**: `[` with a zero under head 0 scans forward for the matching `]` by op id (depth counting),
   `]` with a non-zero byte scans backward; both scans stay inside [0, P) and do not wrap, as bff.py does. The
   scan reads bytes with `mem_read` and does **not** call `on_fetch` (it inspects code, it does not execute
   it). An unmatched bracket calls `zil_trap(ZIL_TRAP_UNMATCHED)`; one step includes the whole scan.
2. **The halting dial maps exactly**: bff.py's `bracket_halts(p, s)` is
   `hash32(p·0x9E3779B1 ^ (s+1)·0x85EBCA77 ^ roll_seed) < halt_q` with `halt_q = round(p · 2³²)`. The world's
   trap dial with salt 0, `seed = roll_seed`, lane = pair index and step = loop index is the same formula and
   threshold (`test/unit.mjs` checks the hash). `nohalt` is the policy `ignore`; the published rule is `halt`.
3. **The bounds check stays at the end of a step** (as in the skeleton), so `steps` equals bff.py's `executed`
   (bff.py breaks before counting when the pointer is out of range at the top of the next iteration).
4. **Variant parameters.** `density_map(k)` and the literal-push switch (`literal`, `lit_rep`) are parameters,
   not names. The contract now has core parameters (decision 4): declare them in `params` (for example
   `density: { type: 'u32', … }`, `literal: { type: 'bool', … }`), read them through `ZIL_PARAM_*` in the core
   text, and tables that depend on them can be generated in `wgsl(o)` from `o.params`. The mechanism is in place and
   tested with a test-only core; the BFF semantics are not written yet.
5. **Records**: bff.py's `writesB` counts writes at positions ≥ 64; on the pair world [64, 64] on ring 128 that
   is the world's write counter for segment B. Its `entered` ("an op executed in B") and `max_pc` are over the
   positions of executed ops, which is the **start map**, not the fetch map: the literal-push op reads its two
   operand bytes as instruction stream (fetched) but never executes them.
6. **Resolved points**: the halt cause (`trapCause`: `bounds`, `unmatched`, `unimplemented`; the skeleton keeps a
   `trap` state field); resumable runs (the params' `stepBase` reaches every dial draw, so bff.py's step index `s`
   is `stepBase` plus the steps run; tested on the skeleton with the bounds dial for k = 1, 2, 7). BFF has no
   stack: a world may still give `init.stack` (so one spec serves every ISA); BFF validates it, does not apply it and
   lists it as `notApplicable: 'no stack'` in the manifest.
