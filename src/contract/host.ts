// Host contract v2: the constants every core and every world share.
//
// A core calls hooks only at its canonical points (docs/ARCHITECTURE.md, "Host contract v2"); the world (L1)
// implements them. The values below are the wire format between the two and must never change within a
// HOST_CONTRACT version.

/** Version of the hook contract between cores (L0) and worlds (L1). Frozen at the end of M2. */
export const HOST_CONTRACT = 2;

/** Return values of `on_instruction_start`. */
export const ZIL_CONTINUE = 0;
export const ZIL_HALT = 1;
export const ZIL_SKIP = 2;

/** Halt reasons, as reported per lane (`haltReason`). 0 means the budget ran out with the lane still running. */
export const HALT_REASONS = {
  running: 0,
  /** The ISA's own halt instruction (Z80 HALT, 8086 HLT, PDP-11 HALT). */
  "halt-insn": 1,
  /** The host halted the lane from `on_instruction_start` (lethal first unit, probability dial). */
  host: 2,
  /** A trap whose policy is `halt` (6502 JAM, BFF unmatched bracket, …). */
  trap: 3,
} as const;
export type HaltReasonName = keyof typeof HALT_REASONS;

/** Decisions returned by `zil_trap(cause)`. */
export const ZIL_TRAP_HALT = 1;
export const ZIL_TRAP_IGNORE = 2;
export const ZIL_TRAP_VECTOR = 3;

/**
 * Trap causes, shared by every ISA. A core raises only the causes its descriptor lists
 * (`IsaCore.conventions.traps`); a world sets a policy per cause.
 */
export const TRAP_CAUSES = {
  /** Undefined or illegal opcode (6502 NMOS JAM, RISC-V illegal instruction). */
  illegal: 1,
  /** The ISA's own halt instruction executed (Z80 HALT). Policy `ignore` makes it a no-op. */
  "halt-insn": 2,
  /** Unmatched bracket (BFF). */
  unmatched: 3,
  /** Instruction pointer left the tape (BFF without wrap). Policy `ignore` wraps it modulo the ring. */
  bounds: 4,
  /** Misaligned access or fetch (PDP-11 odd address, RV32 without C). */
  misaligned: 5,
  /** Division by zero (8086 INT 0). */
  "div-zero": 6,
  /** Environment call or software interrupt (ECALL, EBREAK). */
  syscall: 7,
  /** An opcode a skeleton core does not implement yet. Never raised by a finished core. */
  unimplemented: 8,
} as const;
export type TrapCause = keyof typeof TRAP_CAUSES;

/** Built-in trap decisions a world can choose per cause. */
export type TrapDecision = "halt" | "ignore" | "vector";

/**
 * WGSL declarations of the contract constants. Emitted once by `buildMachine` before the core; a core generated
 * with any v2 hook enabled needs it.
 */
export const HOST_CONTRACT_PRELUDE_WGSL = `// === Zilion host contract v${HOST_CONTRACT} ===
const ZIL_CONTINUE: u32 = ${ZIL_CONTINUE}u;  // on_instruction_start: execute the instruction
const ZIL_HALT: u32 = ${ZIL_HALT}u;      // on_instruction_start: halt the lane, PC stays on the instruction
const ZIL_SKIP: u32 = ${ZIL_SKIP}u;      // on_instruction_start: consume the first fetch unit as a no-op
const ZIL_RUNNING: u32 = ${HALT_REASONS.running}u;    // halt reasons
const ZIL_HALT_INSN: u32 = ${HALT_REASONS["halt-insn"]}u;
const ZIL_HALT_HOST: u32 = ${HALT_REASONS.host}u;
const ZIL_HALT_TRAP: u32 = ${HALT_REASONS.trap}u;
const ZIL_TRAP_HALT: u32 = ${ZIL_TRAP_HALT}u;    // zil_trap decisions
const ZIL_TRAP_IGNORE: u32 = ${ZIL_TRAP_IGNORE}u;
const ZIL_TRAP_VECTOR: u32 = ${ZIL_TRAP_VECTOR}u;
${Object.entries(TRAP_CAUSES)
  .map(([k, v]) => `const ZIL_TRAP_${k.toUpperCase().replace(/-/g, "_")}: u32 = ${v}u;`)
  .join("\n")}
`;
