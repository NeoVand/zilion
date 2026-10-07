// Known-answer conformance vectors for the Zilion Z80 core. Each runs a short
// program and asserts on the final registers/memory, hand-verified against the
// Z80 instruction set. Runs in a browser after `npm run build` (see index.html).
// The broader differential test against a real-Z80 reference lives upstream in
// the Algocell project.

import { Zilion } from "../dist/index.js";

const hi = (n) => (n >> 8) & 0xff;
const lo = (n) => n & 0xff;

/** @type {{name:string, program:number[], steps:number, fetchHook?:string, check:(r:any,m:Uint8Array)=>(string|null)}[]} */
export const VECTORS = [
  {
    name: "LD A,n + INC A",
    program: [0x3e, 0x42, 0x3c, 0x76],
    steps: 16,
    check: (r) =>
      hi(r.af) === 0x43 ? null : `A=${hi(r.af).toString(16)} want 43`,
  },
  {
    name: "ADD A,B",
    program: [0x3e, 0x10, 0x06, 0x22, 0x80, 0x76],
    steps: 16,
    check: (r) =>
      hi(r.af) === 0x32 ? null : `A=${hi(r.af).toString(16)} want 32`,
  },
  {
    name: "flags: zero + carry (0xFF+1)",
    program: [0x3e, 0xff, 0x06, 0x01, 0x80, 0x76],
    steps: 16,
    check: (r) =>
      hi(r.af) === 0 && (r.af & 0x40) !== 0 && (r.af & 0x01) !== 0
        ? null
        : `A=${hi(r.af).toString(16)} f=${lo(r.af).toString(16)}`,
  },
  {
    name: "DJNZ loop -> A=5",
    program: [0x06, 0x05, 0x3c, 0x10, 0xfd, 0x76],
    steps: 64,
    check: (r) => (hi(r.af) === 5 ? null : `A=${hi(r.af)} want 5`),
  },
  {
    name: "LD (HL),n memory write",
    program: [0x21, 0x10, 0x00, 0x36, 0xab, 0x76],
    steps: 16,
    check: (_r, m) =>
      m[0x10] === 0xab ? null : `mem[16]=${m[0x10].toString(16)} want ab`,
  },
  {
    name: "LDIR block copy",
    program: [
      0x21, 0x20, 0x00, 0x11, 0x30, 0x00, 0x01, 0x03, 0x00, 0xed, 0xb0, 0x76,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe,
    ],
    steps: 64,
    check: (_r, m) =>
      m[0x30] === 0xde && m[0x31] === 0xad && m[0x32] === 0xbe
        ? null
        : `dst=${m[0x30].toString(16)},${m[0x31].toString(16)},${m[0x32].toString(16)} want de,ad,be`,
  },
  {
    name: "CB: SET 7,A",
    program: [0x3e, 0x01, 0xcb, 0xff, 0x76],
    steps: 16,
    check: (r) =>
      hi(r.af) === 0x81 ? null : `A=${hi(r.af).toString(16)} want 81`,
  },
  {
    name: "IX: LD IX,nn + LD (IX+d),n",
    program: [0xdd, 0x21, 0x08, 0x00, 0xdd, 0x36, 0x02, 0x99, 0x76],
    steps: 16,
    check: (_r, m) =>
      m[0x0a] === 0x99 ? null : `mem[10]=${m[0x0a].toString(16)} want 99`,
  },
  {
    name: "IX: LD A,(IX+d)",
    program: [
      0xdd, 0x21, 0x10, 0x00, 0xdd, 0x7e, 0x02, 0x76, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x77,
    ],
    steps: 16,
    check: (r) =>
      hi(r.af) === 0x77 ? null : `A=${hi(r.af).toString(16)} want 77`,
  },
  {
    name: "stack: PUSH BC / POP HL",
    program: [0x01, 0x34, 0x12, 0xc5, 0xe1, 0x76],
    steps: 16,
    check: (r) =>
      r.hl === 0x1234 ? null : `HL=${r.hl.toString(16)} want 1234`,
  },
  {
    // HALT stops execution: the INC A after HALT must not run, so A stays 5.
    name: "HALT stops execution",
    program: [0x3e, 0x05, 0x76, 0x3c],
    steps: 16,
    check: (r) =>
      hi(r.af) === 5 ? null : `A=${hi(r.af)} want 5 (INC after HALT ran?)`,
  },
  {
    // LD A,R after two M1 fetches (ED, 5F): R has incremented to 2 -> A=2.
    name: "LD A,R reflects M1 refresh count",
    program: [0xed, 0x5f, 0x76],
    steps: 8,
    check: (r) => (hi(r.af) === 2 ? null : `A=${hi(r.af).toString(16)} want 2`),
  },
  // ── fetchHook (instruction ablation) ───────────────────────────────────
  {
    // Same LDIR program as above, with LDIR (ED B0) ablated: the ED B0 pair
    // must act as a 2-byte NOP, so nothing is copied and the HALT still runs.
    name: "hook: ED B0 (LDIR) ablated -> 2-byte NOP, HALT reached",
    fetchHook: "prefix == 0xedu && op == 0xb0u",
    program: [
      0x21, 0x20, 0x00, 0x11, 0x30, 0x00, 0x01, 0x03, 0x00, 0xed, 0xb0, 0x76,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe,
    ],
    steps: 64,
    check: (r, m) =>
      m[0x30] === 0 &&
      m[0x31] === 0 &&
      m[0x32] === 0 &&
      r.pc === 0x0b &&
      r.bc === 3
        ? null
        : `dst=${m[0x30]},${m[0x31]},${m[0x32]} pc=${r.pc.toString(16)} bc=${r.bc} (want untouched, pc=0b, bc=3)`,
  },
  {
    // Ablating LDIR must leave the rest of the ED page alone: LDI (ED A0) still copies one byte.
    name: "hook: LDI survives when only LDIR is ablated",
    fetchHook: "prefix == 0xedu && op == 0xb0u",
    program: [
      0x21, 0x10, 0x00, 0x11, 0x20, 0x00, 0x01, 0x01, 0x00, 0xed, 0xa0, 0x76, 0,
      0, 0, 0, 0x5a,
    ],
    steps: 32,
    check: (_r, m) =>
      m[0x20] === 0x5a ? null : `mem[20]=${m[0x20].toString(16)} want 5a`,
  },
  {
    // Base-page ablation is a 1-byte NOP: the operand byte of LD A,n (0x3E 0x42)
    // is NOT skipped and executes as its own instruction (0x42 = LD B,D).
    name: "hook: base opcode ablated -> operand runs as next instruction",
    fetchHook: "prefix == 0u && op == 0x3eu",
    program: [0x16, 0x07, 0x3e, 0x42, 0x76], // LD D,7 ; [LD A,42 ablated] ; (42 = LD B,D) ; HALT
    steps: 16,
    check: (r) =>
      hi(r.af) === 0 && hi(r.bc) === 7
        ? null
        : `A=${hi(r.af)} B=${hi(r.bc)} want A=0 B=7`,
  },
  {
    // The IX form reports prefix 0xDD: ablating only (prefix==0xdd, op==0x36)
    // blocks LD (IX+d),n but leaves plain LD (HL),n working.
    name: "hook: IX form distinguished from base form",
    fetchHook: "prefix == 0xddu && op == 0x36u",
    program: [
      0xdd, 0x21, 0x08, 0x00, 0xdd, 0x36, 0x02, 0x99, 0x21, 0x10, 0x00, 0x36,
      0xab, 0x76,
    ],
    steps: 16,
    check: (_r, m) =>
      m[0x0a] !== 0x99 && m[0x10] === 0xab
        ? null
        : `mem[0a]=${m[0x0a].toString(16)} mem[10]=${m[0x10].toString(16)}`,
  },
  {
    // CB page reports prefix 0xCB: ablate SET 7,A only.
    name: "hook: CB page addressable",
    fetchHook: "prefix == 0xcbu && op == 0xffu",
    program: [0x3e, 0x01, 0xcb, 0xff, 0xcb, 0xc7, 0x76], // SET 7,A (ablated) ; SET 0,A ; HALT
    steps: 16,
    check: (r) =>
      hi(r.af) === 0x01 ? null : `A=${hi(r.af).toString(16)} want 01`,
  },
];

export async function runConformance() {
  const z80 = await Zilion.create({ memBytes: 256 });
  /** One extra executor per distinct fetchHook, sharing the device. */
  const hooked = new Map();
  const results = [];
  for (const v of VECTORS) {
    let exec = z80;
    if (v.fetchHook) {
      exec = hooked.get(v.fetchHook);
      if (!exec) {
        exec = await Zilion.create({
          memBytes: 256,
          device: z80.device,
          fetchHook: v.fetchHook,
        });
        hooked.set(v.fetchHook, exec);
      }
    }
    const r = await exec.run([v.program], { steps: v.steps });
    const detail = v.check(r.registers[0], r.memoryOf(0));
    results.push({ name: v.name, ok: detail === null, detail: detail ?? "ok" });
  }
  for (const h of hooked.values()) h.destroy();
  const N = 8192;
  const progs = Array.from({ length: N }, () => [
    0x3e, 0x00, 0x3c, 0x3c, 0x3c, 0x76,
  ]);
  const t0 = performance.now();
  const r = await z80.run(progs, { steps: 16 });
  const ms = performance.now() - t0;
  const ok = r.registers.every((x) => x.af >> 8 === 3);
  z80.destroy();
  const passed = results.filter((x) => x.ok).length;
  return {
    total: VECTORS.length,
    passed,
    results,
    parallel: { count: N, ms, ok },
  };
}
