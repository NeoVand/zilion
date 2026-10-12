"""8088 V2 hardware vectors. No flag masks; sparse final state merged with initial state.

The cycle array supplies ordered memory writes and port transactions. Queue
contents and bus timing are not compared by the architectural adapter yet.
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
from .model import Field

NAMES = ('ax','cx','dx','bx','sp','bp','si','di','es','cs','ss','ds','ip','flags','halted','trap','rep')
FIELDS = tuple(Field(n, 16 if n not in ('halted','trap') else 8,
                     'flags' if n == 'flags' else 'halt' if n == 'halted' else 'trap' if n == 'trap' else 'regs') for n in NAMES)
VARS = {n: f'i8086_r[{i}]' for i,n in enumerate(NAMES[:8])} | {n:f'i8086_s[{i}]' for i,n in enumerate(NAMES[8:12])} | {
    n:f'i8086_{n}' for n in NAMES[12:]}


def transactions(t):
    addr = None
    kind = None
    result = []
    for c in t['cycles']:
        if not isinstance(c,list) or len(c) != 11:
            raise ValueError('bad 8088 cycle entry')
        if c[0]:
            addr,kind = c[1],c[7]
        if c[8] == 'T3' and kind in ('MEMW','IOR','IOW'):
            if type(addr) is not int or type(c[6]) is not int:
                raise ValueError('invalid bus transaction')
            result.append((kind,addr,c[6]))
    return result


class I8086Adapter:
    isa = '8086'
    addr_bits = 20
    fields = FIELDS
    step_call = '''i8086_step();
        // Vectors run one complete REP; the world charges one step per iteration.
        for (var repguard = 0u; repguard < 128u && i8086_rep != 0u; repguard++) { i8086_step(); }'''
    columns = ('regs','flags','halt','mem','ports','bus','trap')
    group_order = ('documented','aliases','undefined')
    file_glob = '*.json.gz'
    write_cap = 264
    passthrough = ()

    @staticmethod
    def key_of(path):
        key = path.name.removesuffix('.json.gz').lower()
        return 'undefined ' + key if path.parent.name == 'v2_undefined' else key

    @staticmethod
    def group(key):
        if key.startswith('undefined '): return 'undefined'
        op = int(key.split('.')[0],16)
        if 0x60 <= op <= 0x6f or op in (0x82,0xc0,0xc1,0xc8,0xc9,0xd6) or key.endswith('.1') and op in (0xf6,0xf7) or key.endswith('.6') and 0xd0 <= op <= 0xd3 or key == 'ff.7':
            return 'aliases'
        return 'documented'

    @staticmethod
    def reference_keys():
        return json.loads((Path(__file__).resolve().parents[3] / "test/vectors/8086/reference-files.json").read_text())

    @staticmethod
    def sort_key(key):
        return (key.startswith('undefined '), *[int(k,16) for k in key.removeprefix('undefined ').split('.')])

    @staticmethod
    def state_values(d):
        return [d['regs'].get(n,0) if n not in ('halted','trap') else 0 for n in NAMES]

    @staticmethod
    def prepare_test(t):
        # V2 final.regs is sparse. Preserve every unchanged initial field; no
        # result-dependent mutation and no flags masked from comparison.
        if set(t['initial']['regs']) != set(NAMES[:14]):
            raise ValueError('initial registers must be complete, with no unknown fields')
        if not set(t['final']['regs']).issubset(NAMES[:14]):
            raise ValueError('unknown final register')
        if not isinstance(t['bytes'],list) or not t['bytes'] or any(type(b) is not int or not 0 <= b <= 255 for b in t['bytes']):
            raise ValueError('instruction bytes must be byte integers')
        t['final']['regs'] = t['initial']['regs'] | t['final']['regs']
        t['ports'] = [[a,v,'r' if kind == 'IOR' else 'w'] for kind,a,v in transactions(t) if kind != 'MEMW']
        return t

    @staticmethod
    def bus_writes(t):
        return [(a,v) for kind,a,v in transactions(t) if kind == 'MEMW']

    @staticmethod
    def compact_state(d): return d['regs']

    @staticmethod
    def instruction_bytes(t): return ' '.join(f'{b:02x}' for b in t['bytes'])

    def glue(self,core):
        load = [f'  {VARS[n]} = zt_state_in[b + {i}u];' for i,n in enumerate(NAMES)]
        load += ['  i8086_rep = 0u;']
        store = [f'  zt_state_out[b + {i}u] = {VARS[n]};' for i,n in enumerate(NAMES)]
        return '\n'.join(['fn io_in(port: u32) -> u32 { return io_read(port); }',
            'fn io_out(port: u32, val: u32) { io_write(port, val); }',
            'fn on_decode(page: u32, key: u32) -> bool { return false; }',
            'fn zt_load_state(b: u32) {',*load,'}', 'fn zt_store_state(b: u32) {',*store,'}'])

    def postprocess(self,fb,out): return {}
    def predicate(self,name,fb,out):
        if name != "far_register_hidden_latch": raise KeyError(name)
        def hidden(t):
            code = t['bytes']
            pos = 0
            while pos < len(code) and code[pos] in (0x26,0x2e,0x36,0x3e,0xf0,0xf1,0xf2,0xf3): pos += 1
            return pos + 1 < len(code) and code[pos] in (0xfe,0xff) and code[pos+1] >> 6 == 3 and (code[pos+1] >> 3) & 7 in (3,5)
        return np.array([hidden(fb.test(i)) for i in range(fb.n)],dtype=bool)

