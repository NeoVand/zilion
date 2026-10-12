import { i8086, i8086FirstPushAt } from "../../dist/cores/i8086/index.js";
import { readFileSync } from "node:fs";
const bootstrapPanel = JSON.parse(readFileSync(new URL("./fixtures/i8086-bootstrap-panel.json", import.meta.url), "utf8"));
const memory = (P, entries, fill = 0x90) => { const m = new Uint8Array(P).fill(fill); for (const [a,b] of Object.entries(entries)) m.set(b,+a); return m; };
const world = (P, extra = {}) => ({ memory: { kind: "ring", bytes: P }, init: { stack: { firstPushAt: "lastByte" } },
  budget: { unit: "steps", value: 16 }, ...extra });
const CASES = [
  ...bootstrapPanel.rings.map(({L,lanes})=>({name:`8086 seeded random-panel bootstrap: 16 partners on ring ${2*L}`,
    setup:({addJob})=>addJob({isa:i8086,world:world(2*L,{memory:{kind:"segments",segments:[{bytes:L,name:"A"},{bytes:L,name:"B"}],ring:2*L},budget:{unit:"steps",value:bootstrapPanel.budget},outputs:{writeCounts:true,fetchMap:true}})},lanes.map(l=>({
      mem:Uint8Array.from([...Array.from({length:L},(_,i)=>i%2?0x51:0xb9),...Buffer.from(l.partner,"hex")]),
      expect:{steps:l.steps,halt:l.halt,writes:l.writes,fetched:l.fetched,memAll:Array.from(Buffer.from(l.finalMemory,"hex"))}
    })))
  })),
  { name:"8086 coherent contract reset fixes segments, DF and TF",
    setup:({addJob})=>addJob({isa:i8086,world:world(32,{budget:{unit:"steps",value:0}})},[
      {mem:memory(32,{}),expect:{steps:0,state:{cs:0,ds:0,es:0,ss:0,ax:0,cx:0,dx:0,bx:0,bp:0,si:0,di:0,sp:1,flags:0xf002}}}
    ])},
  ...[32,64].map(P=>({name:`8086 SP=0 phase differs from pinned lastByte on ring ${P}`,
    setup:({addJob})=>addJob({isa:i8086,world:world(P,{init:{set:{sp:0,ax:0x1234}},budget:{unit:"steps",value:1},outputs:{writeCounts:true}})},[
      {mem:memory(P,{0:[0x50]}),expect:{steps:1,state:{sp:65534,ip:1},mem:{[P-2]:0x34,[P-1]:0x12,0:0x50},writes:[2]}}
    ])})),
  ...[32,64].map(P=>({name:`8086 PUSH SP stores decremented SP on ring ${P}`,
    setup:({addJob})=>addJob({isa:i8086,world:world(P,{budget:{unit:"steps",value:1}})},[
      {mem:memory(P,{0:[0x54]}),expect:{steps:1,state:{sp:65535,ip:1},mem:{[P-1]:255,0:255}}}
    ])})),
  {name:"8086 ordered word stores: both wrapped offsets alias one byte on ring 3, high wins",
    setup:({addJob})=>addJob({isa:i8086,world:world(3,{init:{stack:{firstPushAt:0},set:{ax:0x1234}},budget:{unit:"steps",value:1},outputs:{writeCounts:true}})},[
      {mem:memory(3,{0:[0x50]}),expect:{steps:1,state:{sp:65535},mem:{0:0x12},writes:[2]}}
    ])},
  {name:"8086 coherent fetch observes changed next opcode, immediate and prefix",
    setup:({addJob})=>addJob({isa:i8086,world:world(32,{init:{stack:{firstPushAt:"lastByte"},set:{cx:3,si:16,di:24}},budget:{unit:"steps",value:2}})},[
      {mem:memory(32,{0:[0xc6,6,5,0,0xf4,0x90]}),expect:{steps:2,halt:"halt-insn",state:{ip:6},mem:{5:0xf4}}},
      {mem:memory(32,{0:[0xc6,6,6,0,0x77,0xb9,1,0]}),expect:{steps:2,state:{cx:0x77,ip:8}}},
      {mem:memory(32,{0:[0xc6,6,5,0,0xfc,0xf3,0xa4],16:[0x77]}),expect:{steps:2,state:{cx:3,ip:6,si:16,di:24,rep:0,flags:0xf002},mem:{5:0xfc}}}
    ])},
  {name:"8086 instruction fetch wraps offset FFFF to zero before ring mapping",
    setup:({addJob})=>addJob({isa:i8086,world:world(33,{init:{stack:{firstPushAt:"lastByte"},set:{ip:65535}},budget:{unit:"steps",value:1},outputs:{fetchMap:true}})},[
      {mem:memory(33,{0:[0x34,0x12],30:[0xb8]}),expect:{steps:1,state:{ax:0x1234,ip:2},fetched:[30,0,1]}}
    ])},
  {name:"8086 REP retains decoded operation when it overwrites its own prefix and opcode",
    setup:({addJob})=>{
      const spec={isa:i8086,world:world(64,{init:{stack:{firstPushAt:"lastByte"},set:{cx:3,si:32,di:0}},budget:{unit:"steps",value:3},outputs:{writeCounts:true,fetchMap:true}})};
      const lanes=[{mem:memory(64,{0:[0xf3,0xa4,0xf4],32:[0x90,0x90,0x90]}),expect:{steps:3,state:{cx:0,si:35,di:3,ip:2,rep:0},mem:{0:0x90,1:0x90,2:0x90},writes:[3],fetched:[0,1]}}];
      return [addJob(spec,lanes),addJob(spec,lanes,{stepChunks:[1,1,1]})];
    }},
  {name:"8086 string segment selection and backward DF are declared state",
    setup:({addJob})=>addJob({isa:i8086,world:world(64,{init:{stack:{firstPushAt:"lastByte"},set:{ds:1,es:2,ss:3,si:16,di:16,flags:0xf402}},budget:{unit:"steps",value:1}})},[
      {mem:memory(64,{0:[0xa4],32:[0xab]}),expect:{steps:1,state:{ds:1,es:2,ss:3,cs:0,si:15,di:15,flags:0xf402},mem:{48:0xab}}}
    ])},
  {name:"8086 zero-ea far register transfers have no previous-EA history, including resumes",
    setup:({addJob})=>{
      const spec={isa:i8086,world:world(32,{entry:{position:8},init:{stack:{firstPushAt:"lastByte"},set:{bx:0x1234}},budget:{unit:"steps",value:2}})};
      const lanes=[{mem:memory(32,{2:[0x78,0x56],8:[0x8b,6,24,0,0xff,0xeb],24:[1,0]}),expect:{steps:2,state:{ax:1,bx:0x1234,cs:0x5678,ip:0x1234,sp:1}}}];
      return [addJob(spec,lanes),addJob(spec,lanes,{stepChunks:[1,1]})];
    }},
  {name:"8086 zero-ea byte far register transfer reads declared memory at offset zero",
    setup:({addJob})=>addJob({isa:i8086,world:world(32,{entry:{position:8},init:{stack:{firstPushAt:"lastByte"},set:{ss:1,bx:0x1234}},budget:{unit:"steps",value:1}})},[
      {mem:memory(32,{8:[0xfe,0xeb],16:[0x78]}),expect:{steps:1,state:{cs:0xff78,ip:0xff34}}}
    ])},
  {name:"8086 zero-ea far register CALL reads target before deterministic stack writes",
    setup:({addJob})=>[
      addJob({isa:i8086,world:world(32,{entry:{position:8},init:{stack:{firstPushAt:"lastByte"},set:{bx:0x1234}},budget:{unit:"steps",value:1},outputs:{writeCounts:true}})},[
        {mem:memory(32,{2:[0x78,0x56],8:[0xff,0xdb]}),expect:{steps:1,state:{cs:0x5678,ip:0x1234,sp:65533},mem:{31:0,0:0,29:10,30:0},writes:[4]}}
      ]),
      addJob({isa:i8086,world:world(32,{entry:{position:8},init:{stack:{firstPushAt:"lastByte"},set:{ss:1,bx:0x1234}},budget:{unit:"steps",value:1},outputs:{writeCounts:true}})},[
        {mem:memory(32,{8:[0xfe,0xdb],16:[0x78]}),expect:{steps:1,state:{cs:0xff78,ip:0xff34,sp:65533},mem:{15:0,13:10},writes:[2]}}
      ])
    ]},
  {name:"8086 hidden-EA register LEA LES LDS deterministically trap after ModRM",
    setup:({addJob})=>addJob({isa:i8086,world:world(32,{budget:{unit:"steps",value:1}})},[0x8d,0xc4,0xc5].map(op=>
      ({mem:memory(32,{0:[op,0xc0]}),expect:{steps:1,halt:"trap",trap:"unimplemented",state:{ip:2,ax:0,ds:0,es:0}}})))},
  {name:"8086 undocumented aliases execute under the pinned policy",
    setup:({addJob})=>addJob({isa:i8086,world:world(32,{init:{stack:{firstPushAt:"lastByte"},set:{ax:0x1234,flags:0xf003}},budget:{unit:"steps",value:1}})},[
      {mem:memory(32,{0:[0xf1,0x90]}),expect:{steps:1,state:{ip:2,ax:0x1234}}},
      {mem:memory(32,{0:[0xd6]}),expect:{steps:1,state:{ip:1,ax:0x12ff}}},
      {mem:memory(32,{0:[0xff,0xf8]}),expect:{steps:1,state:{ip:2,sp:65535},mem:{31:0x34,0:0x12}}},
      {mem:memory(32,{0:[0x60,2]}),expect:{steps:1,state:{ip:2}}}
    ])},
  ...[32,64].map(P=>({name:`8086 B9 51 bootstrap into zero and affine partners on ring ${P}`,
    setup:({addJob})=>{
      const L=P/2; const tiles=Uint8Array.from({length:L},(_,i)=>i%2?0x51:0xb9);
      return addJob({isa:i8086,world:world(P,{memory:{kind:"segments",segments:[{bytes:L,name:"A"},{bytes:L,name:"B"}],ring:P},budget:{unit:"steps",value:L/2},outputs:{writeCounts:true,fetchMap:true}})},[0,1].map(v=>{
        const m=Uint8Array.from({length:P},(_,i)=>i<L?tiles[i]:v?((i*73+19)&255):0);
        const wanted={0:0xb9};for(let i=P-L/2+1;i<P;i++)wanted[i]=i%2?0x51:0xb9;
        return {mem:m,expect:{steps:L/2,halt:"running",state:{ip:L,cx:0xb951,sp:(1-L/2)&65535},mem:wanted,writes:[1,L/2-1],fetched:Array.from({length:L},(_,i)=>i)}};
      }));
    }})),
  ...[32,64].map(P=>({name:`8086 B9 51 full-budget bootstrap outcome on ring ${P}`,
    setup:({addJob})=>{
      const L=P/2; const tiled=Array.from({length:P},(_,i)=>i%2?0x51:0xb9);
      return addJob({isa:i8086,world:world(P,{memory:{kind:"segments",segments:[{bytes:L,name:"A"},{bytes:L,name:"B"}],ring:P},budget:{unit:"steps",value:128},outputs:{writeCounts:true,fetchMap:true}})},[0,1].map(v=>{
        const m=Uint8Array.from({length:P},(_,i)=>i<L?tiled[i]:v?((i*73+19)&255):0);
        const out=[...tiled];if(P===64&&v){out[0]=47;for(const i of [7,8,9,10,61,62])out[i]=0;}
        return {mem:m,expect:{steps:128,halt:"running",memAll:out,writes:v?(P===32?[60,66]:[63,64]):[64,65],fetched:Array.from({length:P},(_,i)=>i)}};
      }));
    }})),
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
  { name:"8086 REP DIV ignores REP, while REP IDIV negates the quotient",
    setup:({addJob})=>addJob({isa:i8086,world:world(32,{init:{stack:{firstPushAt:"lastByte"},set:{ax:20,bx:3}},budget:{unit:"steps",value:1}})},[
      {mem:memory(32,{0:[0xf3,0xf7,0xf3]}),expect:{steps:1,state:{ax:6,dx:2,ip:3}}},
      {mem:memory(32,{0:[0xf3,0xf7,0xfb]}),expect:{steps:1,state:{ax:0xfffa,dx:2,ip:3}}}
    ])},
  { name:"8086 PUSHF reads reserved flag bits as fixed, even after raw initialization",
    setup:({addJob})=>addJob({isa:i8086,world:world(32,{init:{stack:{firstPushAt:"lastByte"},set:{flags:0x28}},budget:{unit:"steps",value:1}})},[
      {mem:memory(32,{0:[0x9c]}),expect:{steps:1,state:{ip:1,flags:0x28},mem:{31:2,0:0xf0}}}
    ])},
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
