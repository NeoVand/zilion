# Zilion architecture (0.3.0-dev)

Zilion computes, for very many (machine, world) pairs at once, what a world does to its memory and which
addresses the machine visited. A **machine** is a byte-code interpreter with a program counter and some
registers (an ISA core). A **world** places programs in a ring of memory, sets the initial state, runs a
budget of steps, and keeps a record. The point of the architecture is that **the world is the same code for
every machine**: comparisons across ISAs (Z80, 6502, BFF, …) are only clean if the world does not change
when the machine does.

This document describes what is implemented on the `m1/architecture` branch, with the contract decisions of
2026-10-10 implemented on `m1/contract` (see the end). The design it follows is
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
| `symbols` | `step` (WGSL function), `haltReason` (u32 expression), `pc` (u32 expression), `trapCause` (u32 expression over state fields: the code of the trap that halted the core, else 0) |
| `hooks` | which optional hooks the core can call: `fetch`, `instructionStart`, `trap`, `io` |
| `decode` | the decode (ablation) hook: its WGSL name and parameters, page layouts, what a skip consumes |
| `conventions` | step definition; `firstPushAt(P, t)` and `stackTop(P, t)` (both null without a stack); `entry(pos, P)`; trap causes with as-chip decisions; prose on halting and illegal opcodes |
| `variants`, `compat` | named semantics; `compat` selects historical semantics (the Z80: `'0.3'`, the default, and `'0.2'`) |
| `stateFor({ variant, compat })` (optional) | the state record and internals for that selection, when they differ from `state` and `internals` (the Z80's 0.2 record has no `wz`/`im`, its `zilog-nmos` record adds `q`) |
| `params` (optional) | compile-time parameters: name → `{ type: 'u32' \| 'bool' \| 'enum', default, values? }` (see Core parameters) |
| `wgsl({ variant, compat, hooks, params? })` | the core text; a disabled hook is never called (WGSL has no default functions) |

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
| `on_reset()` | world | once per lane, last: after the reset and the init conventions, or after the per-lane state load |

Halt reasons (`haltReason`): 0 running (budget exhausted), 1 `halt-insn` (the ISA's halt instruction), 2
`host` (from `on_instruction_start`), 3 `trap`. Trap causes (`TRAP_CAUSES`, codes 1..8): `illegal`, `halt-insn`,
`unmatched`, `bounds`, `misaligned`, `div-zero`, `syscall`, `unimplemented`.

**Trap cause.** The lane record carries `trapCause`: the code of the trap that halted the lane, whether the chip
halts on it (as-chip) or a world policy or dial made it halt, and 0 when the lane did not halt on a trap (still
running, for instance after an ignored trap, or halted by the host). Each core names it with `symbols.trapCause`, a
u32 expression over its state fields, so it survives a state store and load: the Z80 derives it from `halted`
(HALT is its only halting trap: `halt-insn` exactly when `halted` = 1), and the skeletons keep a `trap` state field
that every trap path sets as it halts, reported only while `halted` says trap
(`select(0u, m6502_trap, m6502_halted == ZIL_HALT_TRAP)`). A core with a real vector continues after a vectored
trap and reports 0; the skeletons have none and halt on any decision but `ignore`. A Z80 HALT, a 6502 JAM
(`illegal`), an unimplemented opcode and a BFF run-off (`bounds`) are therefore told apart in the outputs;
`haltReason` keeps its four codes.

### The Z80 core

`src/cores/z80/core.wgsl.ts` generates the core text with `z80CoreText(hooks, { compat, variant })` (the
descriptor's `wgsl` calls it). Two semantics:

| `compat` | Text | State record | Use |
|---|---|---|---|
| `'0.3'` (default) | the current core (`core.wgsl.ts`) | the 25 fields of 0.2, then `wz` (16 bits) and `im` (2); `zilog-nmos` adds `q` (8) | new work |
| `'0.2'` | the frozen 0.2 generator (`core-0.2.wgsl.ts`); with every hook off the 0.2.0 core **byte for byte** (`Z80_CORE_WGSL`) | the 25 fields of 0.2.0 | registered work, Algocell's executors |

The record differs by semantics, so the descriptor gives it per selection (`stateFor({ variant, compat })`, an
optional descriptor method the builder uses when present); new fields are appended, so 0.2 offsets are unchanged.
`npm run check:bytes` proves the 0.2 text against the v0.2.0 tag and the published package and pins the 0.2 text of
every hook combination by SHA-256; `test/world/compat02.mjs` checks the outputs of 600,000 random programs against a
recording made from the 0.2.0 core before any fix (design §5.5). `Z80_CORE_WGSL` and `buildComputeShader` (the 0.2
API) stay the 0.2.0 text.

**Semantics 0.3** (design §5.2–§5.4). Validated against all 1,604,000 SingleStepTests/z80 vectors, 384 analytic
wasted-prefix vectors and 86 hand-derived R and WZ probes (docs/TESTING.md); what remains unmodelled is listed in
`test/vectors/z80/expected-0.3.0.json`.

- **R.** A wasted DD/FD prefix (followed by DD, FD or ED) is one step and one M1: R + 1 (0.2 counted the follower's
  M1 too, R + 2). The follower is still fetched in the wasted step (`on_fetch`, fetch maps), as before.
- **MEMPTR (WZ)** in full, per the design's §5.3 table: `LD A,(rp)` rp + 1; `LD (rp),A` and `LD (nn),A`
  (A ≪ 8) | ((addr + 1) & 0xFF); 16-bit loads and stores through (nn) nn + 1; `ADD/ADC/SBC HL,rr` the old HL + 1;
  RLD/RRD HL + 1; JR, DJNZ, RET cc taken: the target (not taken: unchanged); JP cc and CALL cc nn **taken or not**;
  RET, RETN, RETI, RST, EX (SP),HL: the new PC or HL; every (IX+d)/(IY+d) instruction (DDCB included, after the
  decode hook) IX/IY + d; `IN A,(n)` port + 1; `OUT (n),A` (A ≪ 8) | ((n + 1) & 0xFF); `IN r,(C)`, `OUT (C),r`
  BC + 1 (BC before the load); CPI/CPD WZ ± 1; INI/IND BC(before) ± 1; OUTI/OUTD BC(after) ± 1; a repeating block
  instruction PC + 1. LDI, LDD, JP (HL), LD SP,HL, PUSH, POP and an ablated instruction leave it. The only flag that
  reads it: `BIT n,(HL)` takes F3/F5 from WZ bits 11 and 13.
- **IM.** IM 0/1/2 and the mirrors (ED 46 4E 66 6E → 0, 56 76 → 1, 5E 7E → 2) set `cpu_im`. No interrupts exist.
- **Block repeats.** A repeating LDIR/LDDR/CPIR/CPDR/INIR/INDR/OTIR/OTDR takes X/Y from bits 13/11 of its own
  address; INIR/INDR/OTIR/OTDR also adjust H and P/V (redcode Z80 Block Flags Test). The flags of a repeating
  iteration are normally overwritten by the next one; they survive when the budget ends mid-repeat, or when the
  instruction overwrites its own bytes (self-copying code), after which F can reach memory through `PUSH AF`.
- **Ports.** Without the io hooks IN reads 0 and OUT does nothing, as in 0.2; `OUT (C),r` and `OUT (C),0` now exist
  in every build (they set WZ). With the io hooks: port `(A << 8) | n` for `IN A,(n)`/`OUT (n),A`, `BC` for the
  `(C)` forms, `BC` before B is decremented for INI/IND and after for OUTI/OUTD.
- **Halt reasons.** `cpu_halted` holds `Z80_RUNNING`, `Z80_HALT_INSN` (HALT, PC parked on it) or `Z80_HALT_HOST`
  (`on_instruction_start` returned `ZIL_HALT`, PC backed onto the byte), constants equal to the contract's
  `ZIL_RUNNING`, `ZIL_HALT_INSN`, `ZIL_HALT_HOST` (the core text needs no prelude with its hooks off). A lane halted
  by HALT keeps executing it (R + 1 per step); a lane halted by the host is frozen (0.2 kept adding 1 to R). The Z80
  has no other halting trap, so `symbols.trapCause` is `halt-insn` exactly when `halted` = 1, in both semantics.
- **Raw hosts.** `z80_reset()` is the world reset (every register, latch and internal 0, PC 0, running);
  `z80_run(budget) -> u32` runs up to `budget` steps and stops after the step that halts. Hosts that embed the core
  text without the world builder (the vector harness, a soup shader) use them instead of relying on WGSL
  zero-initialisation (design Appendix C.5).

**Variant `zilog-nmos`** (compat `'0.3'` only): the Q latch of the Zilog NMOS Z80. Q = F after an instruction that
writes F, else 0 (POP AF and EX AF,AF' do not write it; a wasted prefix, a HALT step, a skipped or ablated
instruction and a step the host halts leave Q = 0, and a DD/FD prefix clears it before the instruction it prefixes);
SCF and CCF take X/Y from ((Q ⊕ F) | A), Q being the latch as the step began (`z80_qprev`). A lane already halted by
the host is frozen, Q included. The variant adds statements inside the same functions, so `z80_step` holds the
anchors here too. With it, every SingleStepTests field except the interrupt latches matches
(`expected-0.3.0-zilog-nmos.json`). It is a variant and not a core parameter (decision 4) because it changes the state
record (`q`), which the record-per-selection mechanism keys on variant and compat; the default `classic` takes
SCF/CCF X/Y from A, as 0.2 did.

Internals hold nothing between steps (`idx_*`; with `zilog-nmos` also `z80_qprev`, set at the start of each step),
so a resumed run that stores and loads the state record continues exactly (`wz`, `im` and `q` are state fields).

Order within `z80_step`, with the opt-in hooks (each adds text at a fixed insertion point only):

1. `z80_fetch()` of the first byte → `on_fetch(pc)` → read → PC + 1; `r_inc()` (M1);
2. `on_instruction_start(pc, byte)`: `ZIL_HALT` sets `cpu_halted = 2` and backs PC onto the byte (exactly
   Algocell's lethal-tar hunk, with a distinguishable value); `ZIL_SKIP` returns;
3. DD/FD: the next byte (`on_fetch`); a wasted prefix returns here (PC backed up; compat `'0.2'` counts its M1 first),
   otherwise `r_inc()`;
4. the decode hook `on_fetch_opcode(prefix, op)` for base-page opcodes; DDCB/FDCB fetch the displacement and
   the opcode first; CB and ED pages call it from their own dispatch;
5. execute (operands and displacements through `z80_fetch`, so `on_fetch` sees every instruction byte);
   HALT calls `zil_trap(ZIL_TRAP_HALT_INSN)` when the trap hook is on (`ignore` makes it a 1-byte no-op);
   IN/OUT and the block I/O instructions call `io_in`/`io_out` when the io hooks are on (with compat `'0.2'` the io
   hooks also add the `OUT (C),r` cases, which are no-ops without them there).

### Anchors

Algocell's shader generators patch the core text. These anchors occur exactly once in the core of every semantics
(compat `'0.2'`; compat `'0.3'` classic and `zilog-nmos`) generated with each of the 16 hook combinations (48 texts,
checked by `scripts/check-byte-identity.mjs`); the commitment holds through 0.3.x. The R fix of §5.2 is written so
that the prefix-resolution anchor is unchanged:

| Exact text | Used by (Algocell) |
|---|---|
| `"    var op = z80_fetch();\n    r_inc(); // M1: opcode (or prefix) fetch\n"` | `gen_lethal_shader.py`, `gen_dial_shader.py`, `optrace.py` |
| `"    let val = mem_read(cpu_pc);\n    cpu_pc = (cpu_pc + 1u) & 0xffffu;\n    return val;"` | `gen_trace_shader.py` |
| `"var<private> cpu_halted: u32;\n"` | `gen_dial_shader.py`, `gen_conv_shader.py`, `gen_trace_shader.py` |
| `"if (op == 0xddu \|\| op == 0xfdu) {"` before `"if (on_fetch_opcode(pfx, op)) { return; }"` | `gen_lethal_shader.py` |
| `cpu_pc = (cpu_pc + 1u) & 0xffffu`, `cpu_sp = (cpu_sp ± 1u) & 0xffffu`, `cpu_pc = u32(i32(cpu_pc) + d) & 0xffffu` (present) | mutants in `z80difftest_ring.node.ts` |

## L1: the world spec

`buildMachine({ isa, world, mode?, workgroupSize?, variant?, compat?, bindingNames? })`, or with core parameters
`buildMachine({ core: { isa, variant?, compat?, params? }, world, … })`, returns
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

`init.state: 'zero'` (default): the world reset, then, in order, `init.stack`, `entry` (`{ position }`, the PC),
`init.set` (constants by field name) and `init.random` (`{ fields?, salt? }`: field k of lane l =
`zil_hash(seed, l, k, salt ^ ZIL_SALT_INIT)` masked to its width; default fields = the randomizable ones).
`init.state: 'perLane'` reads the whole state record per lane from a buffer instead. In both cases the raw
`onReset` hook runs last, so it sees and may change the initial state.

**The stack is never a default.** On an ISA with a stack, a world gives `init.stack`, or sets every stack field
itself with `init.set` or `init.random` (the Z80's `sp`, the 6502's `s`: the fields the stack conventions assign),
or loads the state per lane; otherwise the build fails and names the field. `init.stack` is exactly one of two
conventions (giving both is an error on every ISA):

- `{ firstPushAt: t | 'lastByte' }`: the first byte pushed lands at position t, the same bytes on every ISA
  (`conventions.firstPushAt(P, t)`). The Z80 pre-decrements, so SP = `highestAlias(t, P) + 1` (16-bit: SP = 0 when
  that alias is 0xFFFF); the 6502 writes then decrements, so S is the largest value with `0x0100 | S` aliasing t.
  Worlds compared across ISAs use this.
- `{ topAliases: t | 'lastByte' }`: the stack pointer aliases t, with its per-ISA meaning (`conventions.stackTop`;
  the Z80's SP = `highestAlias(t, P)`, so its first push lands at t − 1; the 6502's at t). The `compat:'0.2'` and
  Algocell worlds are written in it.

`'lastByte'` is the last byte of the last segment (P − 1 without segments), so padding never moves the stack.
When a world gives both a convention and the stack fields, the order is the convention, then `init.set`, then
`init.random`. An ISA without a stack (BFF) accepts `init.stack`, validates it like any other ISA (one convention,
a position on the ring), and does not apply it, so one world spec serves a stack machine and a stackless one.

Nothing about the stack is dropped silently: `manifest.init.stack` records how it was set, in order of application:
`{ convention: { kind, position, values }, set: [fields], random: [fields] }` (each part present when it applies),
or `{ notApplicable: 'no stack', given: <init.stack as given> }` on an ISA without a stack, or
`{ notApplicable: 'per-lane state' }`. The generated `zil_init_state` carries the same as a comment, and the world as
given (with its `init.stack`) is in `manifest.world` and its hash.

**Presets** (`src/world/presets.ts`) write the old worlds out with both conventions explicit:
`compat02World({ memBytes, steps, registers? })` is 0.2's `Zilion.run` world (use it with `compat: '0.2'`: mask
memory, `topAliases: 'lastByte'`, which is 0.2's SP = 0xFFFF, or per-lane registers), and
`algocellPairWorld({ L, P, steps })` is Algocell's pair (tapes A and B on a ring of P, `topAliases: 'lastByte'`,
a steps budget, writes counted).

### Budgets

`budget: { unit: 'steps' | 'fetchBytes', value: n | 'perLane' }`, **required, both fields** (a world without them
fails to build, naming the missing field). A step is the core's step (Z80: one instruction, one block-repeat
iteration, or a wasted prefix). `fetchBytes` counts instruction-stream bytes through `on_fetch`, so it is
ISA-neutral; a step starts while fewer than `budget` bytes have been fetched. A number is the budget of every run
(a uniform: a host may pass another per run without recompiling); `perLane` adds a per-lane budget buffer. The run
loop stops at the budget or when the halt reason is non-zero; `steps` counts every executed step, including
the one that halted.

### Halting, traps, dials, ablation

- **Native halt.** As the chip does (Z80 HALT parks PC on the opcode, reason `halt-insn`), or re-policied as a
  trap: `halting.traps['halt-insn'] = 'ignore'`.
- **Lethal first unit.** `halting.lethal: { firstUnit, probability?, salt? }` halts a lane whose instruction
  starts with that unit, judged on the raw unit before prefixes and ablation (Algocell's lethal tar is
  `firstUnit: 0`).
- **Dials.** A probabilistic halt draws `zil_draw(salt) < round(p · 2³²)`: `zil_hash(seed, lane, step, salt)`, a
  stateless counter-based hash, at the 64-bit step index `stepBase + steps run`, with the index's high word folded
  into the seed (`seed ^ zil_mix32(hi)`; `zil_mix32(0) = 0`, so below 2³² steps it is exactly
  `zil_hash(seed, lane, step, salt)`; CPU mirror `zilDraw`). Draws depend neither on lane chunking and order nor on
  how a run is split across dispatches (see Resumable runs). With salt 0 it equals the BFF kernel's
  `hash32(p·0x9E3779B1 ^ (s+1)·0x85EBCA77 ^ roll_seed)`. Trap policies take the same dial:
  `traps: { unmatched: { halt: { probability: 0.1 } } }`.
- **Trap policies.** Per cause the core lists: `'as-chip' | 'halt' | 'ignore' | 'vector'` (vector only where the
  chip has one) or a dial. The trap hook is emitted only when some policy differs from the chip.
- **Ablation.** `{ expr }` (a WGSL boolean over the decode-hook parameters, 0.2's `fetchHook`) or
  `{ table: 'uniform', layout? }`: a bitset per decode page in the params, bit `key & 31` of word
  `page · wordsPerPage + (key >> 5)`, changed per run without recompiling (the Z80's `coarse` layout is
  Algocell's `params.suppress`, so its masks can be passed unchanged; `fine` has seven pages).

### Outputs and the lane record

Always: `steps`, `haltReason`, `trapCause` (words 0, 1, 2). Optional: `state` (default on), `memory` (default on),
`writeCounts` (one per segment, then one for padding; `mask`/`ring`: total writes), `fetchMap` (T_S: positions
fetched as instruction stream, `ceil(P/32)` words, uncapped), `startMap` (positions where an instruction started),
and on a resumable padded world `padding` (the padding bytes at the end of the run, packed like memory). The record
layout is in the manifest.

### Resumable runs

A run can be split across dispatches and give exactly what one long dispatch gives. The params carry
`stepBase` (64-bit, two u32: low, high), the dial index of the dispatch's first step, and on a resumable machine
`resume`: 0 begins the lanes (reset, init conventions, `on_reset`), 1 continues each lane from its previous
**record and memory**. What carries over between dispatches is exactly:

- the loaded segments (the memory binding, which the previous dispatch stored);
- the state record (record field `state`), and with it the halt reason and the trap cause, which the descriptor
  derives from state fields;
- `steps` (the record accumulates: a resumed lane reports the steps of all its dispatches), the write counters,
  the fetch and start maps;
- the padding bytes, which memory never stores, through the record field `padding`.

Core internals are per-instruction temporaries and carry nothing between steps (an obligation on cores); `on_reset`
does not run again. The host passes, per dispatch, the steps already run as `stepBase`: with a `steps` budget every
lane still running has run exactly that many (a lane that halted takes no further steps and draws nothing), so every
draw sees the step index of the long run. A machine is resumable (`manifest.resumable`) when its budget unit is
`steps`, it stores the state and the memory, and its raw hooks declare no private state (`var<private>` in
`hooks.declarations`, such as Algocell's PCG streams: no record carries it). `fetchBytes` budgets are not resumable
(the fetch count and the per-lane step index would have to carry over too). Per-lane budgets resume when the host
gives each lane its remaining budget, capped at the dispatch's step count (the engine cannot check this). The
record's `steps` is a u32 total and wraps after 2³² steps; the dial index is 64-bit. `Batch.encode` writes the
params when it is called, so each resumed encode must be submitted before the next. Library mode offers the same
through `zil_begin_at(lane, seed, step_base)` and `zil_resume(lane, seed, step_base, o)`.

### Raw hooks (escape hatch)

`world.hooks`: `declarations`, `onFetch`, `onInstructionStart` (may `return ZIL_HALT;`), `decode` (OR-ed with
the ablation), `trap`, `ioIn`, `ioOut`, `onReset`, with the world privates `zil_lane`, `zil_seed`, `zil_step` and
`zil_step_hi` (the low and high words of the 64-bit step index) and the world's draw `zil_draw(salt)` in scope. Raw
hooks are where ISA-specific or registered behaviour goes: `test/world/algocell.mjs` reproduces Algocell's PCG
lethality dial and its randreg/randsp conventions bit for bit with them. Private state a hook declares is not
resumable (see Resumable runs).

### Core parameters

A descriptor may declare `params`: name → `{ type: 'u32' | 'bool' | 'enum', default, values? }` (names and enum
values lower snake case). A machine selects values with `core: { isa, variant?, compat?, params? }` (the shorthand
`isa`, with `variant` and `compat` beside it, remains; mixing the two forms is an error). The builder validates the
selection (an unknown name, a wrong type, a u32 out of range or an enum value outside `values` are errors; an
omitted parameter takes its declared default), emits the constants after the world constants and **ahead of the
core text**, and records every resolved value in `manifest.core.params` and in the options hash. A parameter is a
compile-time constant, never a uniform. The naming scheme is fixed (`src/contract/params.ts`, `coreParamConstant`):

```
u32   const ZIL_PARAM_<NAME>: u32 = <value>u;
bool  const ZIL_PARAM_<NAME>: bool = <true|false>;
enum  const ZIL_PARAM_<NAME>_<VALUE>: u32 = <index>u;   (one per value, in declaration order)
      const ZIL_PARAM_<NAME>: u32 = <index of the selected value>u;
```

with `<NAME>` and `<VALUE>` upper-cased; a descriptor whose names would emit the same constant twice is refused.
No core declares parameters yet; a test-only core (`test/world/fake_core.mjs`) exercises the mechanism on the GPU.

### Generated shader

```
header (zilion version, core id/version/variant/compat/hooks, core/world/options SHA-256)
host-contract prelude · zil_hash · world constants (ZIL_MEM_P, ZIL_MEM_WORDS, ZIL_STATE_WORDS, ZIL_RECORD_WORDS)
[core params] const ZIL_PARAM_* (only when the core declares params)
[kernel] ZilParams { lane_count, lane_base, budget, seed, step_base: vec2<u32>, resume | _pad0, _pad1, ablation? }
         and bindings 0..4
world privates (zil_lane, zil_seed, zil_step, zil_step_hi, step base, counters, maps) · lane memory zil_m · zil_draw
mem_read / mem_write · the hooks the world needs · raw declarations
the core text
zil_reset · zil_init_state · zil_halt_reason · zil_trap_cause · zil_reset_lane(lane, seed) · zil_set_step_base
zil_begin_at(lane, seed, step_base) = zil_reset_lane + step base + on_reset · zil_begin (step base 0) · zil_run(budget)
memory, state and record I/O · [resumable] zil_resume(lane, seed, step_base, o)
[kernel] main: load memory; resume ? zil_resume(lane_base + i, seed, step_base, record of i)
                            : zil_begin_at(lane_base + i, seed, step_base) (perLane: zil_reset_lane, step base,
                              load state, on_reset); zil_run; store memory; store record
```

`mode: 'library'` emits only the functions, using `bindingNames` for host-owned buffers (`memory`, `out`,
`stateIn`, and an `ablation` expression such as `params.suppress`), so a soup shader with several entry points
can call `zil_load_memory`, `zil_begin`, `zil_run`, `zil_store_memory`. `zil_begin` resets everything a lane
owns, so a host may run several lanes in one invocation (tested); a host that sets the state itself calls
`zil_reset_lane`, sets it, then `on_reset()`. `zil_run(budget)` runs up to `budget` more steps (or fetched bytes)
and may be called again on the same lane: the step index the dials see continues from `zil_begin` (tested).

## The manifest (L1/L2 boundary)

`ShaderManifest` (`src/manifest.ts`, schema **`zilion.manifest/2`**) is plain JSON: bindings with roles
(`params`, `memory`, `record`, `stateIn`, `budgetIn`) and per-lane sizes; the params struct as fields with roles
(`laneCount`, `laneBase`, `budget`, `seed`, `stepBase` (2 words), `resume`, `ablation`, `constant`, `pad`) and byte
offsets; the memory layout (ring size, position expression, segments with host and storage offsets, padding); the
record layout; the state fields; halt reasons; trap causes (`trapCauses`, the codes of the record's `trapCause`);
`resumable`; the ablation layout; budget and init flags, with `init.stack` (how the stack was set, or why not); provenance (`zilion`, `hostContract`, core
id/version/status/variant/compat/hooks/params, SHA-256 of the WGSL, the core text, the world JSON and the options).
Schema 2 changed the record (`trapCause` at word 2 moved every later field by one word; `padding` on resumable
padded worlds) and the params (`stepBase` and `resume` at bytes 16..31, so the ablation table moved from 16 to 32).
`test/world/gpu_runner.py` is a complete Python host that reads nothing else. `legacyMachine(memBytes)`
describes 0.2's `buildComputeShader` kernel the same way. Codegen stays in TypeScript:
`node scripts/export-machines.mjs worlds.json --out shaders/` writes `<name>.wgsl` and `<name>.manifest.json`
for each named spec, and `--check` verifies files already on disk (for CI).

## L2: the engine

```ts
const engine = await createEngine();                 // or { gpu } in Node, or { device }
const m = await engine.machine({ isa: z80, world });  // compile errors → ZilionShaderError with source lines
const r = await m.run(lanes, { budget: 128, seed: 1, ablation }); // any number of lanes
r.steps; r.haltReason; r.trapCause; r.stateOf(i); r.memoryOf(i); r.writesOf(i); r.fetchedOf(i); r.startsOf(i);
const r2 = await m.run(r.memory, { budget: 64, seed: 1, stepBase: 128, resume: r.record }); // = one 192-step run
const b = m.batch(1_000_000);                         // resident lanes in slabs
b.upload(lanes); b.encode(encoder, { budget: 128 }); /* … */ const r3 = await b.read();
b.encode(encoder, { budget: 64, stepBase: 128, resume: true });   // continue the resident lanes in place
```

- **Resuming.** `run(memory, { resume: records, stepBase })` uploads each chunk's previous records before its
  dispatch; `Batch.encode({ resume: true, stepBase })` continues the lanes resident in the batch, and
  `Batch.uploadRecords` puts records there from the host. Both refuse a machine whose manifest is not resumable.

- **Chunking.** A chunk is the largest lane count within `maxComputeWorkgroupsPerDimension × workgroupSize`,
  `maxStorageBufferBindingSize` and `maxBufferSize` for every per-lane binding, and `maxBufferSize` for the
  staging buffer that reads a chunk back (`maxLanesPerChunk`). 0.2's
  `run()` failed above 4,194,240 programs and at 128 MiB of memory; both are now chunked. Each chunk passes
  `lane_base`, so hashes see global lane indices and results are chunk-invariant (tested with a dial).
- **Buffers.** A machine's slab (one bind group, at most one chunk) is reused between its runs and grows only;
  runs of one machine queue behind each other. A read is a **snapshot**: the copy of memory and records into a
  staging buffer (from a per-slab pool) is encoded and submitted when the read is called, and only the map is
  asynchronous, so later uploads, encodes and submits never leak into it.
- **Batches.** `Machine.batch(capacity)` keeps lanes resident across runs (several slabs when needed), exposes
  the buffers for chaining with other kernels, and encodes into the caller's encoder. Params are written with
  `queue.writeBuffer` at encode time, so submit before encoding again with different options.
- **Lifecycle.** `Machine.destroy()` makes later runs reject at once; runs already called complete, then the
  buffers are released. `Batch.destroy()` releases at once (submitted work and reads in flight complete).
- **The 0.2 facade.** `Zilion.create/run/destroy` keeps its API **and its lifecycle**: every run owns its buffers
  and releases them before it resolves, runs may overlap, the destroyed check is synchronous, and `destroy()`
  only marks the instance (and destroys a device Zilion created). It runs the byte-identical 0.2 kernel through
  the same runner, so it is chunked (its buffers are reused across the chunks of one run) and reads each chunk
  back with one map; an invalid `fetchHook` now rejects at `create`.

## Testing

| Command | What |
|---|---|
| `npm run check:bytes` | byte identity of the 0.2 configuration against the v0.2.0 tag (built from source) and the published 0.2.0 package; the compat `'0.2'` text of all 16 hook combinations against their recorded SHA-256; anchors in all 48 core texts (3 semantics × 16 hook combinations) |
| `npm run test:compat` | design §5.5: compat `'0.2'` reproduces outputs recorded from the 0.2.0 core on 100,000 random programs at each of P = 32, 38, 40, 64, 100, 128 (per-chunk SHA-256 digests, `test/world/compat-0.2.0.json`); `--compat 0.3` is its negative control |
| `npm run test:unit` | address math, hash, SHA-256, validation, hook minimality, manifest invariants, chunk planner, packing, ISA neutrality; the required budget and stack and their error messages, presets, `firstPushAt` mappings, the trap-cause plumbing, core-param validation and constants (test-only core), the step base and resumability |
| `npm run test:world` | the world spec on the GPU through `gpu_runner.py` (Python wgpu): hand-computed cases for odd and padded rings, the seam, stack conventions (`firstPushAt` on the Z80 and the 6502), budgets, halt and trap policies with trap causes, dials, ablation, maps, init, io hooks; ring = mask, hook neutrality, library = kernel, chunk invariance, 0.2 kernel = the `compat:'0.2'` preset; resumable runs (k = 1, 2, 7 dispatches = one, Z80 and BFF, with a negative control; the step base across 2³²; a hand-built record; library `zil_resume`); core params on a test-only core; the 6502 and BFF skeletons and one world on three ISAs; the Z80 semantics (`test/world/cases_z80.mjs`: §5.2's R programs and BIT n,(HL) from WZ under both compats, the state record per selection, the Q latch, LDIR repeat flags, `z80_run`/`z80_reset`/frozen host halts in a raw host, every hook combination of every semantics compiled and run, resumed runs keeping WZ and Q). Set `ZILION_PYTHON` to an interpreter with `wgpu` and `numpy`. |
| `npm run test:algocell` | 33 conditions against the executors Algocell exported with 0.2.0 (20,000 random pairs each), with compat `'0.2'` |
| `npm run test:engine` | the engine's ordering and lifecycle on a mock device (no GPU): read snapshots, the 0.2 facade's buffer lifetime and destroy races, staging within `maxBufferSize`, the step base and resume params and the record upload per chunk, `trapCause` decoding |
| `test/engine.html` | the engine and the facade on browser WebGPU (`node scripts/serve.mjs`), including a run split into k = 1, 2, 7 resumed dispatches and a batch resumed in place |

## Decisions on the open questions (2026-10-10)

The first architecture review left six questions open. Decided as follows; all six are implemented (branch
`m1/contract`), except the BFF use of decision 4, which comes with the BFF core.

1. **Stack convention: name the meaning, not the register.** Add `init.stack: { firstPushAt: t | 'lastByte' }`:
   the first byte pushed lands at position t, on every ISA (Z80: SP aliases t + 1; 6502: `0x0100 | S` aliases t).
   Cross-ISA worlds use this, since "the stack starts at the end of the partner" must mean the same bytes on both
   machines. `topAliases` stays, with its current per-ISA meaning, because the `compat:'0.2'` and Algocell worlds
   are written in it. A spec that gives both is an error. **Implemented**: `conventions.firstPushAt(P, t)` per
   descriptor (Z80 `z80FirstPushAt`, 6502 `m6502FirstPushAt`, null for BFF; see Initial state); tested by hand on
   rings of 32 and 33 bytes, a padded pair and a seam case, on the Z80 and the 6502 (GPU) and over many rings (unit).
2. **The lane record carries the trap cause.** A 6502 JAM, a BFF run-off and a Z80 `illegal` must be told apart
   in the outputs, not only in the policy. The record gains `trapCause` (0 when the lane did not trap), with the
   codes listed in the manifest; `haltReason` keeps its codes. The legacy 0.2 kernel's outputs stay
   byte-identical. **Implemented**: record word 2, `manifest.trapCauses`, `symbols.trapCause` per descriptor (see
   Host contract v2); manifest schema `zilion.manifest/2`. "Did not trap" means did not *halt* on a trap: an ignored
   or vectored trap leaves 0, and the Z80's HALT reports `halt-insn` whether the chip or a policy made it halt.
3. **No implicit defaults for the stack and the budget.** A world spec without `init.stack` (on an ISA with a
   stack) or without `budget` fails to build, naming the missing field. Silent defaults are how two worlds that
   look the same come to differ (SP = 0 against Algocell's end-of-ring stack). The `compat:'0.2'` preset and the
   Algocell presets supply both explicitly. **Implemented**: `budget.unit` and `budget.value` are both required;
   `init.stack` is required on an ISA with a stack unless the state is loaded per lane; presets `compat02World` and
   `algocellPairWorld`; every spec in the tests, docs and scripts states both; `scripts/export-machines.mjs` also
   requires the ISA to be named. Follow-up decisions: `init.set` or `init.random` covering every stack field counts
   as giving the stack (both given: convention first, both recorded in `manifest.init.stack`); a stackless ISA
   accepts `init.stack`, does not apply it and lists it as `notApplicable: 'no stack'`; the defaults outside this
   decision are listed under "Defaults that remain".
4. **Core parameters are a contract feature, not a BFF special case.** A descriptor may declare `params`
   (name → `{ type: 'u32' | 'bool' | 'enum', default, values? }`); a world selects them with
   `core: { isa, params }`; the builder emits them as WGSL constants ahead of the core text and records them in
   the manifest's provenance. A param is a compile-time constant (a recompile), never a uniform. BFF's variant
   parameters (alphabet density, literal push) are the first use; the 6502's decimal mode and the Z80's
   `zilog-nmos` Q latch are the next. **The generic mechanism is implemented** (see Core parameters), tested with a
   test-only descriptor; the BFF parameters themselves come with the BFF core (M2). The Z80's Q latch stays a
   **variant** (`variant: 'zilog-nmos'`), not a parameter: it adds a state field (`q`), and the state record is
   chosen per variant and compat (`stateFor`), not per parameter value (see The Z80 core).
5. **Resumable runs: a step base.** The params struct gains `stepBase` (64-bit, as two u32), added to the step
   counter in every dial draw, so a run split across dispatches draws exactly what one long dispatch draws.
   Test: k chunked dispatches equal one dispatch, byte for byte, for k = 1, 2, 7. **Implemented** (see Resumable
   runs): `stepBase` at params bytes 16..23, a `resume` flag, resumption from the record and memory, in the engine,
   the Python host and library mode; tested for k = 1, 2, 7 on the Z80 (with dials, ablation, maps and padding) and
   on BFF, with a negative control, across 2³² against the CPU mirror, and in the browser engine.
6. **Anchors stay through 0.3.x** (the commitment under Anchors). Registered Algocell work is pinned to 0.2.0
   output semantics in any case; the anchors keep its shader patchers working until the equivalence proof lets
   them retire. **Holds**: `npm run check:bytes` (decisions 1 to 5 did not touch the Z80 core text; the 0.3
   semantics keep every anchor too).

## Defaults that remain

Decision 3 removed the silent defaults of the stack and the budget. These defaults stay; each is recorded in the
manifest (the world as given, `core`, `init`, `budget`, `record`, the options hash), so none changes a result unseen.

| Field | When omitted | Notes |
|---|---|---|
| `world.entry` | position 0: PC (or BFF's `ip`) at its world-reset value 0, the lowest address that maps to position 0 | `entry: { position }` moves it |
| `world.init.state` | `'zero'`: the world reset (every state field at its descriptor `reset`, usually 0), then the conventions | `'perLane'` loads the state record |
| `world.init.random.fields` | the descriptor's `randomizable` fields (Z80: A..L, the alternates, IX, IY; 6502: A, X, Y) | |
| `world.init.random.salt` | 0 | XOR-ed with `ZIL_SALT_INIT` |
| `world.outputs.memory` | true | |
| `world.outputs.state` | true | resumable runs need it |
| `world.outputs.fetchMap`, `startMap`, `writeCounts` | false | |
| `world.halting.traps.<cause>` | `'as-chip'` (Z80 HALT halts; 6502 JAM and unimplemented halt; BFF bounds, unmatched and unimplemented halt) | |
| `world.halting.lethal` | none; when given, `probability` 1 and `salt` 0 | |
| trap dial `salt` | 0 | |
| `world.ablation` | none | |
| `variant` | `isa.defaultVariant`: Z80 `classic`, 6502 `nmos`, BFF `ascii` | recorded in `manifest.core` |
| `compat` | `isa.compat[0]`: Z80 `'0.3'` (the current semantics; `'0.2'` must be asked for), 6502 and BFF `'skeleton'` | recorded in `manifest.core` |
| core `params` | each declared parameter's `default` | recorded in `manifest.core.params` |
| `mode` | `'kernel'` | |
| `workgroupSize` | 64 | |
| run options | `seed` 0, `laneBase` 0, `stepBase` 0, `resume` off; `budget` = the world's `budget.value` | per dispatch, not compiled in |

## Differences from the design document

1. **No monorepo yet** (see Packaging).
2. **Fewer per-core WGSL obligations.** The design asks each core for `<id>_reset`, `<id>_store`, `<id>_load`,
   `<id>_halted` and `<id>_pc`. Here the descriptor's state fields (WGSL lvalues), `internals` and `symbols`
   let the builder generate all of them, the same way for every ISA. The Z80 (compat `'0.3'`) also has
   `z80_reset()` and `z80_run(budget)` in its text, for hosts that use the core without the builder.
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
