import { i8086, i8086FirstPushAt } from "../../dist/cores/i8086/index.js";
const memory = (P, entries, fill = 0x90) => { const m = new Uint8Array(P).fill(fill); for (const [a,b] of Object.entries(entries)) m.set(b,+a); return m; };
const world = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, init: { stack: { firstPushAt: "lastByte" } },
  budget: { unit: "steps", value: 16 }, ...extra });
const CASES = [
  ...[32,33,64].map(P => ({ name: `8086 firstPushAt ring ${P}: low byte first, word crosses ring seam`,
    setup: ({addJob}) => addJob({isa:i8086,world:world(P,{budget:{unit:"steps",value:2}, outputs:{writeCounts:true}})},[
      {mem:memory(P,{0:[0xb8,0x34,0x12,0x50]}),expect:{steps:2,halt:"running",state:{ax:0x1234,sp:(i8086FirstPushAt(P,P-1).sp-2)&65535,ip:4},mem:{[P-1]:0x34,0:0x12},writes:[2]}}
    ]) })),
  ...[32,33,64].map(P => ({ name: `8086 INT3 ring ${P}: IVT read before stack overwrites vector`,
    // INT3 vector at 12..15 = 0000:0014. Low FLAGS push at 14, then CS at 12, then return IP at 10.
    // Reading the vector after pushes would target 0000:0000; the correct target is HLT at 20.
    setup: ({addJob}) => addJob({isa:i8086,world:world(P,{init:{stack:{firstPushAt:14}},outputs:{writeCounts:true,fetchMap:true,startMap:true}})},[
      {mem:memory(P,{0:[0xcc],12:[20,0,0,0],20:[0xf4]}),expect:{steps:2,halt:"halt-insn",trap:"halt-insn",state:{ip:21,sp:(i8086FirstPushAt(P,14).sp-6)&65535,flags:0xf002},mem:{10:1,11:0,12:0,13:0,14:2,15:0xf0},writes:[6],fetched:[0,20],starts:[0,20]}}
    ]) })),
  { name:"8086 word-offset seam on ring 33: FFFF to 0000, before ring mapping",
    setup:({addJob})=>addJob({isa:i8086,world:world(33,{entry:{position:8},budget:{unit:"steps",value:1}})},[
      {mem:memory(33,{0:[0x12],8:[0xa1,0xff,0xff],30:[0x34,0x56]}),expect:{steps:1,state:{ax:0x1234,ip:11},mem:{31:0x56}}}
    ])},
  { name:"8086 20-bit seam on ring 33: FFFF:000F and FFFF:0010 both alias position 0",
    setup:({addJob})=>addJob({isa:i8086,world:world(33,{entry:{position:8},init:{stack:{firstPushAt:"lastByte"},set:{ds:0xffff}},budget:{unit:"steps",value:1}})},[
      {mem:memory(33,{0:[0x34],8:[0xa1,0x0f,0]}),expect:{steps:1,state:{ax:0x3434,ip:11}}}
    ])},
  { name:"8086 TF: NOP vectors through type 1, pushes FLAGS before clearing TF",
    setup:({addJob})=>addJob({isa:i8086,world:world(64,{init:{stack:{firstPushAt:"lastByte"},set:{flags:0xf102}},budget:{unit:"steps",value:2}})},[
      {mem:memory(64,{0:[0x90],4:[20,0,0,0],20:[0xf4]}),expect:{steps:2,halt:"halt-insn",state:{flags:0xf002,ip:21,sp:0xfffb},mem:{63:2,0:0xf1,61:0,62:0,59:1,60:0}}}
    ])},
  { name:"8086 TF is sampled before POPF: next NOP traps, POPF itself finishes",
    setup:({addJob})=>addJob({isa:i8086,world:world(64,{init:{stack:{topAliases:32}},budget:{unit:"steps",value:3}})},[
      {mem:memory(64,{0:[0x9d,0x90],4:[20,0,0,0],20:[0xf4],32:[2,0xf1]}),expect:{steps:3,halt:"halt-insn",state:{flags:0xf002,ip:21}}}
    ])},
  { name:"8086 REP trap restart retains only last prefix (original-chip erratum)",
    setup:({addJob})=>addJob({isa:i8086,world:world(64,{init:{stack:{firstPushAt:"lastByte"},set:{flags:0xf102,cx:2,si:32,di:40}},budget:{unit:"steps",value:2}})},[
      {mem:memory(64,{0:[0xf3,0x26,0xa4],4:[20,0,0,0],20:[0xcf],32:[1,2]}),expect:{steps:2,halt:"running",state:{flags:0xf102,ip:1,cx:1,si:33,di:41,rep:0},mem:{40:1,41:0x90}}}
    ])},
  { name:"8086 ignored REP TF trap keeps first-prefix IP and active repeat latch",
    setup:({addJob})=>addJob({isa:i8086,world:world(64,{init:{stack:{firstPushAt:"lastByte"},set:{flags:0xf102,cx:3,si:32,di:40}},budget:{unit:"steps",value:2},halting:{traps:{syscall:"ignore"}}})},[
      {mem:memory(64,{0:[0xf3,0x26,0xa4],32:[1,2,3]}),expect:{steps:2,halt:"running",state:{flags:0xf102,ip:0,cx:1,si:34,di:42,rep:0xf3,sp:1},mem:{40:1,41:2,42:0x90}}}
    ])},
  { name:"8086 TF plus INT3 nests type 1 before the INT3 handler begins",
    setup:({addJob})=>addJob({isa:i8086,world:world(64,{init:{stack:{firstPushAt:"lastByte"},set:{flags:0xf102}},budget:{unit:"steps",value:1},outputs:{writeCounts:true}})},[
      {mem:memory(64,{0:[0xcc],4:[24,0,0,0],12:[20,0,0,0]}),expect:{steps:1,halt:"running",state:{ip:24,flags:0xf002,sp:0xfff5},writes:[12],mem:{53:20,54:0,55:0,56:0,57:2,58:0xf0,59:1,60:0,61:0,62:0,63:2,0:0xf1}}}
    ])},
  { name:"8086 MOV SS delays TF until after the following instruction, including resumed runs",
    setup:({addJob})=>{
      const spec={isa:i8086,world:world(64,{init:{stack:{firstPushAt:"lastByte"},set:{flags:0xf102}},budget:{unit:"steps",value:2},outputs:{writeCounts:true}})};
      const lanes=[{mem:memory(64,{0:[0x8e,0xd0,0x90],4:[24,0,0,0]}),expect:{steps:2,halt:"running",state:{ip:24,flags:0xf002,sp:0xfffb},writes:[6],mem:{59:3,60:0}}}];
      return [addJob(spec,lanes),addJob(spec,lanes,{stepChunks:[1,1]})];
    }},
  { name:"8086 interrupt round trip: INT n and IRET restore IP CS FLAGS",
    setup:({addJob})=>addJob({isa:i8086,world:world(64,{budget:{unit:"steps",value:3}})},[
      {mem:memory(64,{0:[0xcd,3,0xf4],12:[20,0,0,0],20:[0xcf]}),expect:{steps:3,halt:"halt-insn",state:{ip:3,cs:0,flags:0xf002,sp:1}}}
    ])},
  { name:"8086 REP MOVSB: one iteration per step; resumes without re-reading self-modified prefixes",
    setup:({addJob})=>{
      const spec={isa:i8086,world:world(64,{init:{stack:{firstPushAt:"lastByte"},set:{cx:4,si:32,di:40}},budget:{unit:"steps",value:3},outputs:{writeCounts:true}})};
      const lanes=[{mem:memory(64,{0:[0xf3,0xa4,0xf4],32:[1,2,3,4]}),expect:{steps:3,halt:"running",state:{cx:1,si:35,di:43,ip:0,rep:0xf3},mem:{40:1,41:2,42:3,43:0x90},writes:[3]}}];
      return [addJob(spec,lanes),addJob(spec,lanes,{stepChunks:[1,1,1]})];
    }},
  { name:"8086 REP CX=0 performs no memory access and finishes in one step",
    setup:({addJob})=>addJob({isa:i8086,world:world(32,{budget:{unit:"steps",value:2},outputs:{writeCounts:true}})},[
      {mem:memory(32,{0:[0xf3,0xa4,0xf4]}),expect:{steps:2,halt:"halt-insn",state:{cx:0,si:0,di:0,ip:3},writes:[0]}}
    ])},
  { name:"8086 budgets: HLT reports native halt, zero steps executes nothing, fetched byte budget ends after full instruction",
    setup:({addJob})=>[
      addJob({isa:i8086,world:world(32,{budget:{unit:"steps",value:0}})},[{mem:memory(32,{0:[0xf4]}),expect:{steps:0,halt:"running",state:{ip:0}}}]),
      addJob({isa:i8086,world:world(32,{budget:{unit:"fetchBytes",value:2}})},[{mem:memory(32,{0:[0xb9,0x51,0xb9,0x51,0xf4]}),expect:{steps:1,halt:"running",state:{cx:0xb951,ip:3}}}]),
      addJob({isa:i8086,world:world(32)},[{mem:memory(32,{0:[0xf4]}),expect:{steps:1,halt:"halt-insn",trap:"halt-insn",state:{ip:1,halted:1}}}])
    ]},
  ...[32,64].map(P=>({name:`8086 B9 51 opens into an unwritten partner byte on ring ${P}`,
    setup:({addJob})=>{
      const L=P/2; const m=new Uint8Array(P).fill(0x90);for(let i=0;i<L;i++)m[i]=i%2?0x51:0xb9;
      const wanted={};for(let i=P-L/2+1;i<P;i++)wanted[i]=i%2?0x51:0xb9;
      return addJob({isa:i8086,world:{...world(P),memory:{kind:"segments",segments:[{bytes:L,name:"A"},{bytes:L,name:"B"}],ring:P},budget:{unit:"steps",value:L/2+1},outputs:{writeCounts:true,fetchMap:true}}},[
        {mem:m,expect:{steps:L/2+1,halt:"running",state:{ip:L+1,cx:0xb951,sp:(1-L/2)&65535},mem:wanted,writes:[1,L/2-1],fetched:Array.from({length:L+1},(_,i)=>i)}}
      ]);
    }})),
  ...[32,64].map(P=>({ name:`8086 B9 51 tiling on pair [${P/2},${P/2}]: soup init, 128 steps self-write without changing tiling`,
    setup:({addJob})=>{
      const m=Uint8Array.from({length:P},(_,i)=>i%2?0x51:0xb9);
      return addJob({isa:i8086,world:{...world(P),memory:{kind:"segments",segments:[{bytes:P/2,name:"A"},{bytes:P/2,name:"B"}],ring:P},budget:{unit:"steps",value:128},outputs:{writeCounts:true}}},[
        {mem:m,expect:{steps:128,halt:"running",memAll:Array.from(m),writes:P===32?[64,64]:[64,64],state:{cx:0xb951,ip:256,sp:(1-128)&65535}}}
      ]);
    }})),
];
for(const c of CASES){const setup=c.setup;c.setup=ctx=>setup({...ctx,addJob:(spec,lanes,run)=>ctx.addJob(c,spec,lanes,run)});}
export const I8086_CASES=CASES;
