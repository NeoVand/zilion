"""Unit tests of the headless harness that need no GPU.

Run: python -I -m unittest discover -s test/harness -v
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

from ztest.gpu import HarnessError  # noqa: E402
from ztest.vectors import session, sst  # noqa: E402
from ztest.vectors.model import READABLE, Rule  # noqa: E402
from ztest.vectors.z80 import FIELDS, Z80Adapter, calls_fn, declares, defines_fn  # noqa: E402


def z80_state(**over):
    s = {f.name: 0 for f in FIELDS if f.compare}
    s["ram"] = []
    s.update(over)
    return s


class ParserTests(unittest.TestCase):
    def write(self, tests, gz=True) -> Path:
        d = Path(self.tmp.name)
        p = d / ("t.json.gz" if gz else "t.json")
        data = json.dumps(tests).encode()
        p.write_bytes(gzip.compress(data) if gz else data)
        return p

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def parse(self, tests, gz=True):
        return sst.parse_file(self.write(tests, gz), "t", Z80Adapter(), 32, 8)

    def test_tables(self):
        t = {"name": "x", "initial": z80_state(ram=[[5, 1], [3, 2]]), "final": z80_state(ram=[[5, 9], [3, 2], [7, 4]])}
        fb = self.parse([t], gz=False)
        self.assertEqual(int(fb.mem_n[0]), 3)
        self.assertEqual(fb.mem_addr[0, :3].tolist(), [3, 5, 7])  # sorted union
        self.assertEqual(fb.mem_init[0, :3].tolist(), [2 | READABLE, 1 | READABLE, 0])
        self.assertEqual(fb.mem_exp[0, :3].tolist(), [2, 9, 4])
        self.assertEqual(fb.mem_final_only[0, :3].tolist(), [False, False, True])

    def test_ports(self):
        t = {"name": "x", "initial": z80_state(), "final": z80_state(), "ports": [[0x1234, 7, "r"], [0xFE, 1, "w"]]}
        fb = self.parse([t])
        self.assertEqual((int(fb.port_in_n[0]), fb.port_in[0, 0].tolist()), (1, [0x1234, 7]))
        self.assertEqual((int(fb.port_out_n[0]), fb.port_out[0, 0].tolist()), (1, [0xFE, 1]))

    def test_rejects_malformed(self):
        good = {"name": "x", "initial": z80_state(), "final": z80_state()}
        bad = [
            {**good, "initial": z80_state(a=1.5)},  # float
            {**good, "initial": z80_state(a="1")},  # string
            {**good, "initial": z80_state(a=None)},  # null
            {**good, "initial": z80_state(f=256)},  # wider than the field
            {**good, "initial": z80_state(pc=-1)},  # negative
            {**good, "initial": z80_state(ram=[[70000, 1]])},  # address beyond 16 bits
            {**good, "initial": z80_state(ram=[[1, 300]])},  # byte beyond 8 bits
            {**good, "initial": z80_state(ram=[[1]])},  # malformed pair
            {**good, "ports": [[1, 2, "x"]]},  # bad direction
            {**good, "ports": "nope"},
            {"name": "x", "initial": {"pc": 0}, "final": z80_state()},  # missing fields
            {**good, "name": 7},
        ]
        for t in bad:
            with self.subTest(t=json.dumps(t)[:80]), self.assertRaises(HarnessError):
                self.parse([t])
        with self.assertRaises(HarnessError):
            sst.parse_file(self.write({"not": "a list"}), "t", Z80Adapter(), 32, 8)

    def test_capacity(self):
        t = {"name": "x", "initial": z80_state(ram=[[a, 0] for a in range(30)]), "final": z80_state()}
        with self.assertRaises(HarnessError):
            self.parse([t])


class RuleTests(unittest.TestCase):
    def test_patterns(self):
        r = Rule.from_json({"id": "x", "files": ["cb [4-7][6e]"], "fields": ["f"], "mask": "0x28", "reason": "",
                            "source": ""})
        self.assertEqual(r.mask, 0x28)
        for k in ("cb 46", "cb 4e", "cb 76", "cb 7e"):
            self.assertTrue(r.matches_file(k), k)
        for k in ("cb 47", "cb 86", "dd cb __ 46", "46"):
            self.assertFalse(r.matches_file(k), k)

    def test_expected_rules_file(self):
        ad = Z80Adapter()
        names = {f.name for f in FIELDS if f.compare} | {"mem", "ports"}
        predicates = {"q_xy_model", "bit_hl_model", "r_wasted_model", "repeats", "not_repeats", "port_read_nonzero", "in_a_n_model", "in_r_c_model", "in_block_model", "rep_xy_model", "rep_io_model",
                      "port_read_zero_or_none"}
        for path in sorted((REPO / "test" / "vectors" / "z80").glob("expected-*.json")):
            rules, doc = session.load_rules(path)
            self.assertEqual(len({r.id for r in rules}), len(rules), path)
            for r in rules:
                self.assertTrue(set(r.fields) <= names, (path.name, r.id))
                self.assertTrue(r.when is None or r.when in predicates, (path.name, r.id))
                self.assertTrue(r.reason and r.source, (path.name, r.id))
                ref = set(ad.reference_keys()) | {"dd dd", "dd fd", "dd ed", "fd dd", "fd fd", "fd ed"}
                self.assertTrue(any(r.matches_file(k) for k in ref), (path.name, r.id, "matches no file"))


class Z80AdapterTests(unittest.TestCase):
    def test_groups_and_reference_set(self):
        g = Z80Adapter.group
        self.assertEqual([g("00"), g("cb 46"), g("ed b0"), g("dd 21"), g("fd cb __ 06"), g("dd ed")],
                         ["base", "CB", "ED", "DD", "FDCB", "wasted-prefix"])
        keys = Z80Adapter.reference_keys()
        self.assertEqual(len(keys), 1604)
        self.assertEqual(len(set(keys)), 1604)

    def test_wgsl_detection_ignores_comments(self):
        core = "// fn on_fetch_opcode(prefix: u32) -> bool\n/* var<private> cpu_wz: u32; */\nvar<private> cpu_im: u32;\n" \
               "fn f() { if (on_fetch_opcode(0u, 1u)) { return; } }"
        self.assertFalse(defines_fn(core, "on_fetch_opcode"))
        self.assertTrue(calls_fn(core, "on_fetch_opcode"))
        self.assertFalse(declares(core, "cpu_wz"))
        self.assertTrue(declares(core, "cpu_im"))
        ad = Z80Adapter()
        glue = ad.glue(core)
        self.assertEqual(ad.passthrough, ("wz", "q", "ei", "p"))
        self.assertIn("fn on_fetch_opcode(", glue)
        self.assertIn("cpu_im = zt_state_in", glue)


if __name__ == "__main__":
    unittest.main()
