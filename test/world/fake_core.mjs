// A test-only core that exists to exercise IsaCore.params (compile-time core parameters) end to end. It is not an
// instruction set: a ring-native accumulator machine whose step reads the byte under its pointer and folds it into
// `acc`, shaped by three parameters of the three kinds:
//   scale     u32  (default 1)        the byte is multiplied by it
//   skip_zero bool (default false)    a zero byte is skipped (the step still advances the pointer)
//   mode      enum add | xor (add)    acc = (acc << 1) + b·scale, or (acc << 1) ^ b·scale
// The core text uses only the builder's constants (ZIL_PARAM_SCALE, ZIL_PARAM_SKIP_ZERO, ZIL_PARAM_MODE,
// ZIL_PARAM_MODE_ADD, ZIL_PARAM_MODE_XOR), so the test shows that the values reach the core as constants.

export const fakeCore = {
  id: "fake",
  name: "Test-only accumulator (core params)",
  coreVersion: "0.0.0-test",
  status: "skeleton",
  addressBits: 0,
  fetchUnitBytes: 1,
  endianness: "little",
  state: [
    { name: "pc", bits: 32, wgsl: "fake_pc" },
    { name: "acc", bits: 32, wgsl: "fake_acc" },
    { name: "halted", bits: 8, wgsl: "fake_halted" },
    { name: "trap", bits: 8, wgsl: "fake_trap" },
  ],
  internals: [],
  symbols: { step: "fake_step", haltReason: "fake_halted", pc: "fake_pc", trapCause: "select(0u, fake_trap, fake_halted == ZIL_HALT_TRAP)" },
  hooks: [],
  decode: null,
  conventions: {
    step: "One byte.",
    stackTop: null,
    firstPushAt: null,
    entry: (pos) => ({ pc: pos }),
    traps: {},
    halting: "Never halts.",
    illegal: "None.",
  },
  variants: { only: "The only variant." },
  defaultVariant: "only",
  compat: ["test"],
  params: {
    scale: { type: "u32", default: 1, description: "multiplier of each byte" },
    skip_zero: { type: "bool", default: false, description: "skip zero bytes" },
    mode: { type: "enum", default: "add", values: ["add", "xor"], description: "how a byte is folded in" },
  },
  wgsl() {
    return /* wgsl */ `
var<private> fake_pc: u32;
var<private> fake_acc: u32;
var<private> fake_halted: u32;
var<private> fake_trap: u32;
fn fake_step() {
    let b = mem_read(fake_pc);
    fake_pc = (fake_pc + 1u) % ZIL_MEM_P;
    if (ZIL_PARAM_SKIP_ZERO && b == 0u) { return; }
    if (ZIL_PARAM_MODE == ZIL_PARAM_MODE_XOR) { fake_acc = (fake_acc << 1u) ^ (b * ZIL_PARAM_SCALE); }
    else { fake_acc = (fake_acc << 1u) + b * ZIL_PARAM_SCALE; }
}
`;
  },
};
