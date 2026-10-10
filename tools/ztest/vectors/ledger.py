"""Comparison, classification and the divergence ledger.

For every test the runner produces a divergence row D over the compared fields plus two pseudo-fields:
  * state fields: D = (expected ^ actual) & field mask (so for F the set bits name the flags that differ);
  * `mem`:   bits MEM_VALUE | MEM_STRAY | MEM_READ;
  * `ports`: bits PORT_WRITE | PORT_READ_MISSING | PORT_UNLISTED.
Expected rules (ignore masks, Rule) cover bits of D, per file pattern and optional predicate; what they do not
cover is *unexpected*. The ledger keeps, per opcode file and field: divergence counts, the OR of the differing
bits, the rules that explained them, and minimal examples of anything unexpected. Everything is aggregated in
file order with deterministic tie-breaks, so the JSON is byte-identical across runs on the same inputs.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict

import numpy as np

from ..gpu import HarnessError
from .model import (
    CONSUMED,
    HARNESS_ERRORS,
    MEM_READ,
    MEM_STRAY,
    MEM_VALUE,
    PORT_READ_MISSING,
    PORT_UNLISTED,
    PORT_WRITE,
    ST_STRAY_WRITE,
    ST_UNLISTED_PORT,
    ST_UNLISTED_READ,
    WRITTEN,
    FileBatch,
    LaneOutputs,
    Rule,
)

EXAMPLES_PER_FIELD = 3
LEDGER_SCHEMA = 1


def popcount(a: np.ndarray) -> np.ndarray:
    return np.unpackbits(a.astype(">u4").view(np.uint8).reshape(-1, 4), axis=1).sum(1).reshape(a.shape)


def hx(v: int, width_bits: int = 8) -> str:
    return f"0x{v:0{max(2, (width_bits + 3) // 4)}x}"


class Ledger:
    def __init__(self, adapter, rules: list[Rule], *, mem_cap: int, port_cap: int):
        self.adapter = adapter
        self.rules = rules
        self.mem_cap = mem_cap
        self.port_cap = port_cap
        self.cmp = [j for j, f in enumerate(adapter.fields) if f.compare]
        self.names = [adapter.fields[j].name for j in self.cmp] + ["mem", "ports"]
        self.widths = [adapter.fields[j].bits for j in self.cmp] + [3, 3]
        self.masks = np.array([adapter.fields[j].mask for j in self.cmp] + [7, 7], dtype=np.uint32)
        self.column = {adapter.fields[j].name: adapter.fields[j].column for j in self.cmp} | {"mem": "mem", "ports": "ports"}
        self.arch = np.array(
            [adapter.fields[j].architectural for j in self.cmp] + [True, True], dtype=bool
        )
        unknown = {f for r in rules for f in r.fields} - set(self.names)
        if unknown:
            raise HarnessError(f"expected rules name unknown fields: {sorted(unknown)}")
        if len({r.id for r in rules}) != len(rules):
            raise HarnessError("expected rule ids must be unique")
        self.col_idx = {c: [j for j, n in enumerate(self.names) if self.column[n] == c] for c in adapter.columns}
        self.files: dict[str, dict] = {}
        self.rule_hits = {r.id: {"hit_tests": 0, "hit_files": 0} for r in rules}
        self.rule_examples: dict[str, dict] = {}
        self.gpu = hashlib.sha256()

    # ------------------------------------------------------------------ comparison
    def divergence(self, fb: FileBatch, out: LaneOutputs) -> np.ndarray:
        n, E, P = fb.n, self.mem_cap, self.port_cap
        D = np.zeros((n, len(self.names)), dtype=np.uint32)
        D[:, : len(self.cmp)] = (fb.state_exp[:, self.cmp] ^ out.state[:, self.cmp]) & self.masks[: len(self.cmp)]

        status = out.status[:, 0]
        if (status & HARNESS_ERRORS).any():
            i = int(np.argmax((status & HARNESS_ERRORS) != 0))
            raise HarnessError(f"{fb.key}: {fb.names[i]}: harness capacity exceeded (status {status[i]:#x}); raise --mem-cap/--port-cap")
        slot = np.arange(E)[None, :] < fb.mem_n[:, None]
        if (slot & (out.mem_addr[:, :E] != fb.mem_addr)).any():
            raise HarnessError(f"{fb.key}: the GPU table lost its listed addresses (harness bug)")
        val = out.mem_word[:, :E] & 0xFF
        written = (out.mem_word[:, :E] & WRITTEN) != 0
        bad = slot & ((val != fb.mem_exp) | (fb.mem_final_only & ~written))
        mem = (np.where(bad.any(1), MEM_VALUE, 0)
               | np.where(status & ST_STRAY_WRITE, MEM_STRAY, 0)
               | np.where(status & ST_UNLISTED_READ, MEM_READ, 0))

        pslot = np.arange(P)[None, :] < fb.port_out_n[:, None]
        wbad = (fb.port_out_n != out.port_out_n) | (pslot & (fb.port_out != out.port_out).any(2)).any(1)
        rslot = np.arange(P)[None, :] < fb.port_in_n[:, None]
        rmiss = (rslot & ((out.port_in_word & CONSUMED) == 0)).any(1)
        ports = (np.where(wbad, PORT_WRITE, 0) | np.where(rmiss, PORT_READ_MISSING, 0)
                 | np.where(status & ST_UNLISTED_PORT, PORT_UNLISTED, 0))
        D[:, -2] = mem
        D[:, -1] = ports
        return D

    # ------------------------------------------------------------------ classification
    def add(self, fb: FileBatch, out: LaneOutputs) -> None:
        gpu_digest = hashlib.sha256(b"".join(np.ascontiguousarray(p, dtype=np.uint32).tobytes()
                                             for p in out.digest_parts())).hexdigest()
        self.gpu.update(f"{fb.key}:{gpu_digest}\n".encode())
        mapped = self.adapter.postprocess(fb, out)  # convention mappings (after the raw digest)
        D = self.divergence(fb, out)
        covered = np.zeros_like(D)
        rule_bits: dict[str, np.ndarray] = {}
        for r in self.rules:
            if not r.matches_file(fb.key):
                continue
            pred = np.ones(fb.n, dtype=bool) if r.when is None else self.adapter.predicate(r.when, fb, out)
            hit = np.zeros(fb.n, dtype=bool)
            for name in r.fields:
                j = self.names.index(name)
                m = np.uint32(self.masks[j] if r.mask is None else r.mask & int(self.masks[j]))
                bits = np.where(pred, D[:, j] & m, 0).astype(np.uint32)
                covered[:, j] |= np.where(pred, m, 0).astype(np.uint32)
                hit |= bits != 0
            rule_bits[r.id] = hit
            if hit.any():
                self.rule_hits[r.id]["hit_tests"] += int(hit.sum())
                self.rule_hits[r.id]["hit_files"] += 1
                if r.id not in self.rule_examples:  # first file with a hit; there, the test with fewest divergences
                    cand = np.flatnonzero(hit)
                    i = int(cand[np.lexsort((cand, (D[cand] != 0).sum(1)))][0])
                    self.rule_examples[r.id] = self._example(fb, out, D, None, i, None) | {"file": fb.key}
        U = D & ~covered

        n = fb.n
        arch_div = (D[:, self.arch] != 0).any(1)
        any_div = (D != 0).any(1)
        unexp_any = (U != 0).any(1)
        unexp_arch = (U[:, self.arch] != 0).any(1)
        n_unexp_fields = (U != 0).sum(1)
        rec = {
            "group": self.adapter.group(fb.key),
            "tests": n,
            "sha256": fb.sha256,
            "gpu": gpu_digest,
            "pass_arch": int(n - arch_div.sum()),
            "pass_all": int(n - any_div.sum()),
            "explained": int(n - unexp_any.sum()),
            "unexpected_arch": int(unexp_arch.sum()),
            "unexpected": int(unexp_any.sum()),
            "mapped": mapped,
            "columns": {},
            "fields": {},
        }
        for c, idx in self.col_idx.items():
            dc = (D[:, idx] != 0).any(1).sum() if idx else 0
            if dc:
                rec["columns"][c] = {"diverging": int(dc), "unexpected": int((U[:, idx] != 0).any(1).sum())}
        for j, name in enumerate(self.names):
            d = D[:, j]
            if not d.any():
                continue
            u = U[:, j]
            entry = {
                "diverging": int((d != 0).sum()),
                "xor": int(np.bitwise_or.reduce(d)),
                "unexpected": int((u != 0).sum()),
                "unexpected_xor": int(np.bitwise_or.reduce(u)),
                "rules": {},
            }
            for r in self.rules:
                if r.id in rule_bits and name in r.fields:
                    m = self.masks[j] if r.mask is None else r.mask
                    c = int((rule_bits[r.id] & ((d & m) != 0)).sum())
                    if c:
                        entry["rules"][r.id] = c
            if entry["unexpected"]:
                order = np.lexsort((np.arange(n), popcount(u), n_unexp_fields))
                order = [i for i in order if u[i] != 0][:EXAMPLES_PER_FIELD]
                entry["examples"] = [self._example(fb, out, D, U, int(i), name) for i in order]
            rec["fields"][name] = entry
        self.files[fb.key] = rec

    def _example(self, fb: FileBatch, out: LaneOutputs, D, U, i: int, focus: str | None) -> dict:
        t = fb.test(i)
        diff = {}
        for j, name in enumerate(self.names):
            if D[i, j] == 0:
                continue
            if name == "mem":
                diff[name] = self._mem_detail(fb, out, i)
            elif name == "ports":
                diff[name] = self._port_detail(fb, out, i)
            else:
                k = self.cmp[j]
                w = self.adapter.fields[k].bits
                diff[name] = {"expected": hx(int(fb.state_exp[i, k]), w), "actual": hx(int(out.state[i, k]), w),
                              "xor": hx(int(D[i, j]), w)}
            if U is not None and U[i, j]:
                diff[name]["unexpected_bits"] = hx(int(U[i, j]), self.widths[j])
        return {
            "name": t["name"],
            "focus": focus,
            "bytes": self.adapter.instruction_bytes(t),
            "initial": self.adapter.compact_state(t["initial"]),
            "ram": [[a, v] for a, v in t["initial"]["ram"]],
            "ports": t.get("ports", []),
            "diff": diff,
        }

    def _mem_detail(self, fb, out, i) -> dict:
        n = int(fb.mem_n[i])
        rows = []
        for k in range(n):
            exp = int(fb.mem_exp[i, k])
            act = int(out.mem_word[i, k] & 0xFF)
            wr = bool(out.mem_word[i, k] & WRITTEN)
            if exp != act or (fb.mem_final_only[i, k] and not wr):
                rows.append({"addr": hx(int(fb.mem_addr[i, k]), 16), "expected": hx(exp), "actual": hx(act), "written": wr})
        for k in range(n, int(out.mem_n[i])):
            rows.append({"addr": hx(int(out.mem_addr[i, k]), 16), "stray_write": hx(int(out.mem_word[i, k] & 0xFF))})
        d = {"cells": rows}
        st = out.status[i]
        if st[0] & ST_UNLISTED_READ:
            d["first_unlisted_read"] = hx(int(st[1]), 16)
        return d

    def _port_detail(self, fb, out, i) -> dict:
        exp_w = [[hx(int(p), 16), hx(int(v))] for p, v in fb.port_out[i, : fb.port_out_n[i]]]
        act_w = [[hx(int(p), 16), hx(int(v))] for p, v in out.port_out[i, : out.port_out_n[i]]]
        reads = [[hx(int(fb.port_in[i, k, 0]), 16), hx(int(fb.port_in[i, k, 1])), bool(out.port_in_word[i, k] & CONSUMED)]
                 for k in range(int(fb.port_in_n[i]))]
        d = {"expected_writes": exp_w, "actual_writes": act_w, "reads (port, value, consumed)": reads}
        if out.status[i, 0] & ST_UNLISTED_PORT:
            d["first_unlisted_port"] = hx(int(out.status[i, 3]), 16)
        return d

    # ------------------------------------------------------------------ aggregation
    def summary(self) -> dict:
        groups: dict[str, dict] = {}
        tot = defaultdict(int)
        columns = {c: {"diverging_tests": 0, "unexpected_tests": 0, "files": 0} for c in self.adapter.columns}
        for key in self.ordered_keys():
            rec = self.files[key]
            g = groups.setdefault(rec["group"], defaultdict(int))
            for k in ("tests", "pass_arch", "pass_all", "explained", "unexpected_arch", "unexpected"):
                g[k] += rec[k]
                tot[k] += rec[k]
            g["files"] += 1
            tot["files"] += 1
            for name, e in rec["columns"].items():
                c = columns[name]
                c["diverging_tests"] += e["diverging"]
                c["unexpected_tests"] += e["unexpected"]
                c["files"] += 1
        return {
            "totals": dict(tot),
            "groups": {k: dict(groups[k]) for k in self.adapter.group_order if k in groups},
            "columns": columns,
        }

    def ordered_keys(self) -> list[str]:
        return sorted(self.files, key=self.adapter.sort_key)

    def unexpected_classes(self) -> list[dict]:
        """Files grouped by (prefix group, set of fields with unexpected divergences)."""
        classes: dict[tuple, dict] = {}
        for key in self.ordered_keys():
            rec = self.files[key]
            fields = tuple(sorted((n for n, e in rec["fields"].items() if e["unexpected"]), key=self.names.index))
            if not fields:
                continue
            c = classes.setdefault((rec["group"], fields), {"group": rec["group"], "fields": list(fields), "files": [],
                                                            "tests": 0, "xor": defaultdict(int), "best": None})
            c["files"].append(key)
            c["tests"] += rec["unexpected"]
            for n in fields:
                c["xor"][n] |= rec["fields"][n]["unexpected_xor"]
                for ex in rec["fields"][n].get("examples", []):
                    score = (len([d for d in ex["diff"].values() if "unexpected_bits" in d]), len(ex["diff"]), key, ex["name"])
                    if c["best"] is None or score < c["best"][0]:
                        c["best"] = (score, ex | {"file": key})
        out = []
        for (g, fields), c in classes.items():
            out.append({"group": g, "fields": list(fields), "files": c["files"], "tests": c["tests"],
                        "unexpected_xor": {n: c["xor"][n] for n in fields}, "reproducer": c["best"][1]})
        return out

    def to_json(self, meta: dict) -> dict:
        return {
            "schema": LEDGER_SCHEMA,
            **meta,
            "fields": [{"name": n, "column": self.column[n], "architectural": bool(a), "bits": w}
                       for n, a, w in zip(self.names, self.arch, self.widths)],
            "rules": [
                {"id": r.id, "files": list(r.files), "fields": list(r.fields),
                 "mask": None if r.mask is None else hx(r.mask), "when": r.when, "reason": r.reason,
                 "source": r.source, "status": r.status, **self.rule_hits[r.id],
                 "example": self.rule_examples.get(r.id)}
                for r in self.rules
            ],
            "summary": self.summary(),
            "unexpected_classes": self.unexpected_classes(),
            "files": {k: self.files[k] for k in self.ordered_keys()},
            "gpu_digest": self.gpu.hexdigest(),
        }


def canonical_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, indent=1, ensure_ascii=False) + "\n"
