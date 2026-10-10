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
from ztest.vectors.m6502 import FIELDS as M6502_FIELDS  # noqa: E402
from ztest.vectors.m6502 import M6502Adapter  # noqa: E402
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

    def test_rules_resolved_by_core_sha(self):
        from ztest.artifacts import Artifacts
        for isa in ("z80", "6502"):
            files = sorted((REPO / "test" / "vectors" / isa).glob("expected-*.json"))
            self.assertTrue(files, isa)
            shas = [json.loads(p.read_text(encoding="utf-8")).get("core_sha256") for p in files]
            self.assertTrue(all(isinstance(h, str) and len(h) == 64 and int(h, 16) >= 0 for h in shas), shas)
            self.assertEqual(len(set(shas)), len(shas))
            for path, sha in zip(files, shas):  # a version bump that leaves the core text alone keeps its rules
                art = Artifacts(Path("."), {"package": {"version": "9.9.9-test"}, "cores": {isa: {"sha256": sha}}})
                self.assertEqual(session.default_rules_path(isa, art), path)
            art = Artifacts(Path("."), {"package": {"version": "9.9.9-test"}, "cores": {isa: {"sha256": "0" * 64}}})
            with self.assertRaises(HarnessError):
                session.default_rules_path(isa, art)

    def test_6502_rules_file(self):
        # the goal is zero rules; any rule must name real fields and files, and give a reason and a source
        names = {f.name for f in M6502_FIELDS if f.compare} | {"mem", "ports", "bus"}
        for path in sorted((REPO / "test" / "vectors" / "6502").glob("expected-*.json")):
            rules, doc = session.load_rules(path)
            self.assertEqual(doc["isa"], "6502")
            self.assertEqual(doc["passthrough"], ["trap"])
            for r in rules:
                self.assertTrue(set(r.fields) <= names, (path.name, r.id))
                self.assertTrue(r.reason and r.source, (path.name, r.id))
                self.assertTrue(any(r.matches_file(k) for k in M6502Adapter.reference_keys()), (path.name, r.id))

    def test_q_xy_after_wasted_prefix(self):
        # SingleStepTests "DD 37 0008": the DD prefix clears Q, so SCF's X/Y come from (F | A), not ((Q ^ F) | A)
        import numpy as np
        from ztest.vectors.model import LaneOutputs
        init = z80_state(pc=0x0B4E, a=0xCE, f=0x23, q=0x23, ram=[[0x0B4E, 0xDD], [0x0B4F, 0x37]])
        final = dict(init, pc=0x0B50, f=0x29, q=0x29, ram=[[0x0B4E, 0xDD], [0x0B4F, 0x37]])
        test = {"name": "DD 37 0008", "initial": init, "final": final, "cycles": [], "ports": []}
        d = Path(tempfile.mkdtemp())
        try:
            (d / "t.json").write_text(json.dumps([test]))
            ad = Z80Adapter()
            for key, explained in (("dd 37", True), ("37", False)):
                fb = sst.parse_file(d / "t.json", key, ad, 32, 8)
                act = fb.state_exp.copy()
                act[:, [f.name for f in FIELDS if f.compare].index("f")] = 0x09  # Zilion 0.2.0: X/Y from A only
                out = LaneOutputs(act, *(np.zeros(1) for _ in range(7)))
                self.assertEqual(bool(ad.predicate("q_xy_model", fb, out)[0]), explained, key)
        finally:
            import shutil
            shutil.rmtree(d)


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


def m6502_state(**over):
    s = {"pc": 0, "s": 0xFD, "a": 0, "x": 0, "y": 0, "p": 0x20, "ram": []}
    s.update(over)
    return s


class M6502AdapterTests(unittest.TestCase):
    def test_groups_and_reference_set(self):
        keys = M6502Adapter.reference_keys()
        self.assertEqual(len(keys), 256)
        counts = {}
        for k in keys:
            counts[M6502Adapter.group(k)] = counts.get(M6502Adapter.group(k), 0) + 1
        self.assertEqual(counts, {"documented": 151, "undocumented": 85, "unstable": 8, "jam": 12})
        self.assertEqual([M6502Adapter.group(k) for k in ("a9", "a7", "8b", "02", "ea", "1a")],
                         ["documented", "undocumented", "unstable", "jam", "documented", "undocumented"])

    def test_bus_writes_parsed_in_order_and_validated(self):
        d = Path(tempfile.mkdtemp())
        try:
            good = {"name": "0e 01 02", "initial": m6502_state(ram=[[0, 0x0E], [1, 0x10], [2, 0], [0x10, 5]]),
                    "final": m6502_state(pc=3, ram=[[0, 0x0E], [1, 0x10], [2, 0], [0x10, 10]]),
                    "cycles": [[0, 0x0E, "read"], [1, 0x10, "read"], [2, 0, "read"], [0x10, 5, "read"],
                               [0x10, 5, "write"], [0x10, 10, "write"]]}
            (d / "t.json").write_text(json.dumps([good]))
            fb = sst.parse_file(d / "t.json", "0e", M6502Adapter(), 32, 8)
            self.assertEqual(int(fb.bus_n[0]), 2)
            self.assertEqual(fb.bus[0, :2].tolist(), [[0x10, 5], [0x10, 10]])
            bad = [
                [[0x10, 5, "wrote"]],  # unknown kind
                [[0x10, 5]],  # malformed entry
                [[0x10, 300, "write"]],  # byte beyond 8 bits
                [[0x10000, 1, "write"]],  # address beyond 16 bits
                [[0x10, 1.5, "write"]],  # not an integer
                [[0x10, 1, "write"]] * 5,  # more writes than the log can hold with its free slots
                "nope",
            ]
            for cyc in bad:
                (d / "t.json").write_text(json.dumps([dict(good, cycles=cyc)]))
                with self.subTest(cycles=str(cyc)[:60]), self.assertRaises(HarnessError):
                    sst.parse_file(d / "t.json", "0e", M6502Adapter(), 32, 8)
        finally:
            import shutil
            shutil.rmtree(d)

    def test_glue(self):
        core = "// fn on_decode(page: u32, key: u32) -> bool\nconst ZIL_HALT_TRAP: u32 = 3u;\n" \
               "var<private> m6502_trap: u32;\nfn m6502_step() { if (on_decode(0u, 1u)) { return; } }"
        ad = M6502Adapter()
        glue = ad.glue(core)
        self.assertEqual(ad.passthrough, ("trap",))
        self.assertIn("m6502_trap = 0u;", glue)
        self.assertEqual(ad.halt_trap, 3)
        self.assertIn("fn on_decode(", glue)
        self.assertIn("m6502_halted = 0u;", glue)
        with self.assertRaises(ValueError):  # the core must come with the host-contract prelude
            M6502Adapter().glue("fn m6502_step() {}")

    def test_halted_expectation_and_jam_pc(self):
        import numpy as np
        from ztest.vectors.model import LaneOutputs
        d = Path(tempfile.mkdtemp())
        try:
            t = {"name": "x", "initial": m6502_state(pc=0x100, ram=[[0x100, 2]]),
                 "final": m6502_state(pc=0x101, ram=[[0x100, 2]]), "cycles": [[0x100, 2, "read"]]}
            (d / "t.json").write_text(json.dumps([t, t]))
            ad = M6502Adapter()
            ad.halt_trap = 3
            H, PC = [f.name for f in M6502_FIELDS].index("halted"), [f.name for f in M6502_FIELDS].index("pc")
            for key, halted, want_exp, want_pc in (("02", 3, 3, 0x101), ("02", 0, 3, 0x100), ("ea", 3, 0, 0x101)):
                fb = sst.parse_file(d / "t.json", key, ad, 32, 8)
                act = fb.state_in.copy()
                act[:, H] = halted
                out = LaneOutputs(act, *(np.zeros(1) for _ in range(7)))
                mapped = ad.postprocess(fb, out)
                self.assertEqual(fb.state_exp[:, H].tolist(), [want_exp, want_exp], key)
                self.assertEqual(out.state[:, PC].tolist(), [want_pc, want_pc], key)
                self.assertEqual(mapped, {"jam_pc": 2} if halted else {}, key)
        finally:
            import shutil
            shutil.rmtree(d)


class FetchScriptTests(unittest.TestCase):
    """Offline checks of tools/fetch-vectors.py (it never touches the network here)."""

    @classmethod
    def setUpClass(cls):
        import importlib.util

        spec = importlib.util.spec_from_file_location("fetch_vectors", REPO / "tools" / "fetch-vectors.py")
        cls.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.m)

    def test_quoting(self):
        url = self.m.raw_url("SingleStepTests/z80", "0" * 40, "v1/dd cb __ 06.json")
        self.assertEqual(url, "https://raw.githubusercontent.com/SingleStepTests/z80/" + "0" * 40 + "/v1/dd%20cb%20__%2006.json")

    def test_blob_sha1_matches_git(self):
        import subprocess

        data = b'[{"name": "00 0000"}]\n'
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(data)
        try:
            git = subprocess.run(["git", "hash-object", f.name], capture_output=True, text=True)
            if git.returncode != 0:
                self.skipTest("git not available")
            self.assertEqual(self.m.git_blob_sha1(data), git.stdout.strip())
        finally:
            Path(f.name).unlink()

    def test_safe_name(self):
        self.assertEqual(self.m.safe_name("v1/cb 00.json"), "cb 00.json")
        for bad in ("v1/..", "v1/.hidden", "v1/", "v1/a\\b"):
            with self.assertRaises(ValueError):
                self.m.safe_name(bad)


if __name__ == "__main__":
    unittest.main()
