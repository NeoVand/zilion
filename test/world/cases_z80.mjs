// World cases for the Z80's semantics: compat '0.3' (the default) against compat '0.2', and the zilog-nmos variant.
// Hand-computed expectations (design §5.2–§5.5); every world gives init.stack and budget explicitly.

const mem = (n, place = {}, fill = 0) => {
  const m = new Uint8Array(n).fill(fill);
  for (const [pos, bytes] of Object.entries(place)) m.set(bytes, +pos);
  return m;
};
const ring = (P, extra = {}) => ({
  memory: { kind: "ring", bytes: P },
  init: { stack: { topAliases: "lastByte" } },
  budget: { unit: "steps", value: 64 },
  ...extra,
});
function randomBytes(n, seed) {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    out[i] = (z ^ (z >>> 16)) & 0xff;
  }
  return out;
}
const lanesOf = (data, bytes) => Array.from({ length: data.length / bytes }, (_, i) => ({ mem: data.subarray(i * bytes, (i + 1) * bytes) }));
function compareJobs(a, b, what = "lane") {
  const errs = [];
  a.result.forEach((x, i) => {
    const y = b.result[i];
    if (!x.mem.every((v, k) => v === y.mem[k])) errs.push(`${what} ${i}: memory differs`);
    if (!x.raw.every((v, k) => v === y.raw[k])) errs.push(`${what} ${i}: record differs (${Array.from(x.raw).join(",")} vs ${Array.from(y.raw).join(",")})`);
  });
  return errs;
}

export const Z80_SEMANTICS_CASES = [
  {
    name: "§5.2: a wasted DD/FD prefix is one M1 (R + 1); compat '0.2' counts two",
    // DD FD 21 34 12 ED 5F: DD wasted (R 1), LD IY,1234 (R 3), LD A,R reads R after its two M1s → A = 5.
    // DD DD DD 00 ED 5F: two wasted DDs (R 2), DD 00 (R 4), LD A,R → A = 6. HALT after each.
    // compat '0.2': each wasted prefix adds 2 → A = 6 and A = 8.
    setup: ({ Z, addJob }) => {
      const lanes = (a1, a2) => [
        { label: "DD FD 21 34 12 ED 5F", mem: mem(32, { 0: [0xdd, 0xfd, 0x21, 0x34, 0x12, 0xed, 0x5f, 0x76] }),
          expect: { steps: 4, halt: "halt-insn", state: { a: a1, iy: 0x1234, pc: 7 } } },
        { label: "DD DD DD 00 ED 5F", mem: mem(32, { 0: [0xdd, 0xdd, 0xdd, 0x00, 0xed, 0x5f, 0x76] }),
          expect: { steps: 5, halt: "halt-insn", state: { a: a2, pc: 6 } } },
      ];
      return [
        addJob({ isa: Z.z80, world: ring(32) }, lanes(5, 6)),
        addJob({ isa: Z.z80, compat: "0.2", world: ring(32) }, lanes(6, 8)),
      ];
    },
  },
  {
    name: "§5.3: BIT n,(HL) takes F3/F5 from WZ (LD A,(nn) sets WZ = nn + 1); compat '0.2' from the operand",
    // LD A,(0x0000) → A = 0x3A, WZ = 0x0001; BIT 0,(HL) with HL = 0: (HL) = 0x3A, bit 0 clear → Z, P/V, H.
    // X/Y: WZ high byte 0x00 → none (F = 0x54); compat '0.2': operand 0x3A & 0x28 = 0x28 (F = 0x7C).
    // LD A,(0x2800) then BIT 0,(HL): WZ = 0x2801 → X/Y set.
    setup: ({ Z, addJob }) => [
      addJob({ isa: Z.z80, world: ring(32) }, [
        { mem: mem(32, { 0: [0x3a, 0x00, 0x00, 0xcb, 0x46, 0x76] }), expect: { steps: 3, state: { a: 0x3a, f: 0x54, wz: 0x0001 } } },
        { mem: mem(32, { 0: [0x3a, 0x00, 0x28, 0xcb, 0x46, 0x76] }), expect: { steps: 3, state: { f: 0x7c, wz: 0x2801 } } },
      ]),
      addJob({ isa: Z.z80, compat: "0.2", world: ring(32) }, [
        { mem: mem(32, { 0: [0x3a, 0x00, 0x00, 0xcb, 0x46, 0x76] }), expect: { steps: 3, state: { a: 0x3a, f: 0x7c } } },
      ]),
    ],
  },
  {
    name: "WZ, IM and the state record: compat '0.3' records wz and im (and zilog-nmos q); compat '0.2' keeps 25 fields",
    // JP 0x0005 → WZ = 5; at 5: IM 2 (ED 5E); HALT. The 0.2 record has no wz/im fields.
    setup: ({ Z, addJob }) => {
      const prog = mem(32, { 0: [0xc3, 0x05, 0x00], 5: [0xed, 0x5e, 0x76] });
      const a = Z.buildMachine({ isa: Z.z80, world: ring(32) });
      const b = Z.buildMachine({ isa: Z.z80, compat: "0.2", world: ring(32) });
      const c = Z.buildMachine({ isa: Z.z80, variant: "zilog-nmos", world: ring(32) });
      const names = (m) => m.manifest.state.map((f) => f.name);
      const errs = [];
      if (names(b).length !== 25 || names(b).includes("wz")) errs.push(`compat 0.2 record: ${names(b)}`);
      if (JSON.stringify(names(a)) !== JSON.stringify([...names(b), "wz", "im"])) errs.push(`compat 0.3 record: ${names(a)}`);
      if (JSON.stringify(names(c)) !== JSON.stringify([...names(a), "q"])) errs.push(`zilog-nmos record: ${names(c)}`);
      if (a.manifest.core.compat !== "0.3" || b.manifest.core.compat !== "0.2" || c.manifest.core.variant !== "zilog-nmos") errs.push("manifest provenance");
      if (errs.length) throw new Error(errs.join("; "));
      return [
        addJob(a, [{ mem: prog, expect: { steps: 3, halt: "halt-insn", state: { wz: 5, im: 2, pc: 7 } } }]),
        addJob(b, [{ mem: prog, expect: { steps: 3, halt: "halt-insn", state: { pc: 7 } } }]),
        addJob(c, [{ mem: prog, expect: { steps: 3, halt: "halt-insn", state: { wz: 5, im: 2, q: 0 } } }]),
      ];
    },
  },
  {
    name: "zilog-nmos: SCF takes X/Y from ((Q ^ F) | A); classic from A",
    // LD A,0x28; OR A (F = 0x2C, Q = 0x2C); LD A,0 (Q = 0); SCF: nmos ((0 ^ 0x2C) | 0) & 0x28 = 0x28 → F = 0x2D,
    // classic A & 0x28 = 0 → F = 0x05. Then HALT (Q = 0). With OR A directly before SCF (Q = F), both give 0x2D.
    setup: ({ Z, addJob }) => {
      const lanes = (f1) => [
        { mem: mem(32, { 0: [0x3e, 0x28, 0xb7, 0x3e, 0x00, 0x37, 0x76] }), expect: { steps: 5, state: { f: f1 } } },
        { mem: mem(32, { 0: [0x3e, 0x28, 0xb7, 0x37, 0x76] }), expect: { steps: 4, state: { f: 0x2d } } },
      ];
      return [
        addJob({ isa: Z.z80, variant: "zilog-nmos", world: ring(32) }, lanes(0x2d)),
        addJob({ isa: Z.z80, world: ring(32) }, lanes(0x05)),
      ];
    },
  },
  {
    name: "block repeat: LDIR repeating takes X/Y from PC bits 13/11 (compat '0.2' from the data)",
    // At position 0 of ring 32 (PC 0): LD BC,2; LD HL,0x10; LD DE,0x18; LDIR at PC 9. Budget 4 steps: the 4th step is
    // the first LDIR iteration, which repeats (BC = 1): PC stays 9, X/Y from PC high byte 0x00 → 0, P/V = 1 → F = 0x04,
    // WZ = 10. compat '0.2': data formula n = (HL) + A = 0x0A → X/Y = 0x28 → F = 0x2C.
    setup: ({ Z, addJob }) => {
      const prog = mem(32, { 0: [0x01, 0x02, 0x00, 0x21, 0x10, 0x00, 0x11, 0x18, 0x00, 0xed, 0xb0, 0x76], 0x10: [0x0a, 0x0b] });
      return [
        addJob({ isa: Z.z80, world: ring(32, { budget: { unit: "steps", value: 4 } }) }, [{ mem: prog, expect: { steps: 4, state: { pc: 9, f: 0x04, wz: 10, c: 1 } } }]),
        addJob({ isa: Z.z80, compat: "0.2", world: ring(32, { budget: { unit: "steps", value: 4 } }) }, [{ mem: prog, expect: { steps: 4, state: { pc: 9, f: 0x2c, c: 1 } } }]),
      ];
    },
  },
  {
    name: "raw hosts: z80_run(n) = zil_run(n); z80_reset() zeroes the state; a host-halted lane is frozen (compat '0.2': R still counts)",
    // A library-mode host calls the core's own functions. Lane program INC A; 00 with the lethal first unit 0: the
    // 00 halts the lane (host), R = 2. Five more z80_step() calls: compat '0.3' leaves R at 2; '0.2' adds 5 (R = 7).
    // A second job runs 512 random programs with z80_run(budget) after zil_begin and must equal the kernel.
    setup: ({ Z, addJob }) => {
      const host = (lib, body) => `struct Params { lanes: u32, lane_base: u32, budget: u32, seed: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> lane_mem: array<u32>;
@group(0) @binding(2) var<storage, read_write> lane_out: array<u32>;
${lib.wgsl}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let l = gid.x;
    if (l >= params.lanes) { return; }
    zil_load_memory(l * ZIL_MEM_WORDS);
    zil_begin(params.lane_base + l, params.seed);
${body}
    zil_store_memory(l * ZIL_MEM_WORDS);
    zil_store_record(l * ZIL_RECORD_WORDS, steps);
}
`;
      const asKernel = (lib, wgsl) => ({ wgsl, manifest: { ...lib.manifest, mode: "kernel", entryPoint: "main",
        params: { bytes: 16, fields: [
          { name: "lanes", role: "laneCount", offset: 0, words: 1 }, { name: "lane_base", role: "laneBase", offset: 4, words: 1 },
          { name: "budget", role: "budget", offset: 8, words: 1 }, { name: "seed", role: "seed", offset: 12, words: 1 }] },
        bindings: [
          { group: 0, binding: 0, name: "params", role: "params", type: "uniform" },
          { group: 0, binding: 1, name: "lane_mem", role: "memory", type: "storage", wordsPerLane: lib.manifest.memory.storageWordsPerLane },
          { group: 0, binding: 2, name: "lane_out", role: "record", type: "storage", wordsPerLane: lib.manifest.record.wordsPerLane }] } });
      const names = { memory: "lane_mem", out: "lane_out" };
      const lethal = ring(32, { halting: { lethal: { firstUnit: 0 } } });
      const frozen = (compat) => {
        const lib = Z.buildMachine({ isa: Z.z80, compat, world: lethal, mode: "library", bindingNames: names });
        return asKernel(lib, host(lib, "    var steps = zil_run(params.budget);\n    for (var k = 0u; k < 5u; k++) { z80_step(); }"));
      };
      // z80_reset: run 3 steps of LD A,0x55 ..., reset, then run the program again from PC 0 with A = 0.
      const libReset = Z.buildMachine({ isa: Z.z80, world: ring(32), mode: "library", bindingNames: names });
      const resetHost = asKernel(libReset, host(libReset,
        "    var steps = z80_run(2u);\n    z80_reset();\n    cpu_sp = 0x00ffu;\n    steps = steps + z80_run(1u);"));
      const plain = ring(32, { outputs: { writeCounts: true, fetchMap: true } });
      const lib = Z.buildMachine({ isa: Z.z80, world: plain, mode: "library", bindingNames: names });
      const random = lanesOf(randomBytes(512 * 32, 99), 32);
      return [
        addJob(frozen(undefined), [{ mem: mem(32, { 0: [0x3c, 0x00] }), expect: { steps: 2, halt: "host", state: { a: 1, r: 2, pc: 1, halted: 2 } } }], { budget: 10 }),
        addJob(frozen("0.2"), [{ mem: mem(32, { 0: [0x3c, 0x00] }), expect: { steps: 2, halt: "host", state: { a: 1, r: 7, pc: 1, halted: 2 } } }], { budget: 10 }),
        // LD A,0x55; LD B,0x66 (2 steps), reset (all 0, PC 0), SP = 0xFF, one more step (LD A,0x55): A = 0x55, B = 0, R = 1.
        addJob(resetHost, [{ mem: mem(32, { 0: [0x3e, 0x55, 0x06, 0x66] }), expect: { steps: 3, state: { a: 0x55, b: 0, r: 1, pc: 2, sp: 0xff, wz: 0 } } }], { budget: 0 }),
        addJob(Z.buildMachine({ isa: Z.z80, world: plain }), random, { budget: 50 }),
        addJob(asKernel(lib, host(lib, "    let steps = z80_run(params.budget);")), random, { budget: 50 }),
      ];
    },
    // z80_run counts steps like zil_run but does not drive the world's fetch counter; the fetch map comes from on_fetch.
    check: (jobs) => compareJobs(jobs[3], jobs[4], "z80_run lane"),
  },
  {
    name: "every hook combination of every semantics compiles and runs (16 x compat '0.2', '0.3' classic, '0.3' zilog-nmos)",
    // Worlds that enable each subset of the v2 hooks: fetch (fetch map), instructionStart (start map), trap (HALT
    // ignored), io (raw ioIn/ioOut). Program: INC A; OUT (0x10),A; IN A,(0x10); HALT. ioIn returns 7 when the io hooks
    // are on (A = 7), else IN reads 0 (A = 0). HALT ignored: the lane runs to the budget.
    setup: ({ Z, addJob }) => {
      const jobs = [];
      for (const sem of [{ compat: "0.2" }, {}, { variant: "zilog-nmos" }]) {
        for (let mask = 0; mask < 16; mask++) {
          const io = !!(mask & 8);
          const world = ring(32, {
            budget: { unit: "steps", value: 8 },
            outputs: { fetchMap: !!(mask & 1), startMap: !!(mask & 2) },
            ...(mask & 4 ? { halting: { traps: { "halt-insn": "ignore" } } } : {}),
            ...(io ? { hooks: { ioIn: "return 7u;", ioOut: "" } } : {}),
          });
          const m = Z.buildMachine({ isa: Z.z80, ...sem, world });
          const want = ["fetch", "instructionStart", "trap", "io"].filter((_, k) => mask & (1 << k));
          if (JSON.stringify(m.manifest.core.hooks) !== JSON.stringify(want)) throw new Error(`hooks ${m.manifest.core.hooks} != ${want}`);
          jobs.push(addJob(m, [{ mem: mem(32, { 0: [0x3c, 0xd3, 0x10, 0xdb, 0x10, 0x76] }),
            expect: { steps: mask & 4 ? 8 : 4, halt: mask & 4 ? "running" : "halt-insn", state: { a: io ? 7 : 0 } } }]));
        }
      }
      return jobs;
    },
  },
  {
    name: "resumable runs keep the latches: WZ (BIT n,(HL) after a split), Q (zilog-nmos SCF after a split), and k = 7 dispatches = one for zilog-nmos and compat '0.2'",
    // LD A,(0x0000); | BIT 0,(HL); HALT: WZ = 1 crosses the split, so F = 0x54 (0x7C if WZ were lost).
    // LD A,0; CP 0x28 (F = 0xBB: X/Y from the operand; Q = F) | SCF; HALT: X/Y = ((Q ^ F) | A) & 0x28 = 0 → F = 0x81;
    // with Q lost (0) it would be (F | A) & 0x28 → 0xA9.
    setup: ({ Z, addJob }) => {
      const nmos = { isa: Z.z80, variant: "zilog-nmos", world: ring(32, { budget: { unit: "steps", value: 128 } }) };
      const c02 = { isa: Z.z80, compat: "0.2", world: ring(32, { budget: { unit: "steps", value: 128 } }) };
      const random = lanesOf(randomBytes(4096 * 32, 123), 32);
      const chunks = [1, 5, 17, 30, 25, 40, 10];
      return [
        addJob({ isa: Z.z80, world: ring(32) }, [{ mem: mem(32, { 0: [0x3a, 0x00, 0x00, 0xcb, 0x46, 0x76] }), expect: { steps: 3, state: { f: 0x54, wz: 1 } } }], { stepChunks: [1, 2] }),
        addJob(nmos, [{ mem: mem(32, { 0: [0x3e, 0x00, 0xfe, 0x28, 0x37, 0x76] }), expect: { steps: 4, state: { f: 0x81, q: 0 } } }], { stepChunks: [2, 2] }),
        addJob(nmos, random, { budget: 128 }),
        addJob(nmos, random, { stepChunks: chunks }),
        addJob(c02, random, { budget: 128 }),
        addJob(c02, random, { stepChunks: chunks }),
      ];
    },
    check: (jobs) => [...compareJobs(jobs[2], jobs[3], "zilog-nmos k=7, lane"), ...compareJobs(jobs[4], jobs[5], "compat 0.2 k=7, lane")],
  },
];

// Each case's setup receives an addJob bound to that case (as in cases.mjs).
for (const c of Z80_SEMANTICS_CASES) {
  const setup = c.setup;
  c.setup = (ctx) => setup({ ...ctx, addJob: (spec, lanes, run) => ctx.addJob(c, spec, lanes, run) });
}
