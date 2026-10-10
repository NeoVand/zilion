"""Console summary and Markdown report of a ledger (the JSON from Ledger.to_json)."""

from __future__ import annotations

import hashlib
import json

from .model import MEM_KINDS, PORT_KINDS


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def pct(a: int, b: int) -> str:
    return f"{100.0 * a / b:.2f}%" if b else "n/a"


def flag_names(mask: int, isa: str, field: str) -> str:
    if field == "f" and isa == "z80":
        names = [(0x80, "S"), (0x40, "Z"), (0x20, "Y(5)"), (0x10, "H"), (0x08, "X(3)"), (0x04, "P/V"), (0x02, "N"), (0x01, "C")]
        return "+".join(n for b, n in names if mask & b) or "-"
    if field in ("mem", "ports"):
        kinds = MEM_KINDS if field == "mem" else PORT_KINDS
        return "+".join(n for b, n in kinds.items() if mask & b) or "-"
    return f"0x{mask:x}"


def console(doc: dict, run: dict, digest: str, show: int = 20) -> str:
    t = doc["summary"]["totals"]
    lines = [
        f"{doc['isa']} vectors: {t['files']} files, {t['tests']:,} tests "
        f"(zilion {doc['provenance']['package']['version']}, core {doc['provenance']['core']['sha256'][:12]}, "
        f"{doc['harness']['memory']} memory) on {run['adapter'].get('device')} ({run['adapter'].get('backend_type')})",
        f"  architectural pass (raw):   {t['pass_arch']:>9,}  {pct(t['pass_arch'], t['tests'])}",
        f"  all fields pass (raw):      {t['pass_all']:>9,}  {pct(t['pass_all'], t['tests'])}",
        f"  explained by expected rules:{t['explained']:>9,}  {pct(t['explained'], t['tests'])}",
        f"  unexpected (any field):     {t['unexpected']:>9,}  {pct(t['unexpected'], t['tests'])}",
        "  by group: " + ", ".join(
            f"{g} {v['pass_arch']}/{v['tests']} arch, {v['unexpected']} unexp" for g, v in doc["summary"]["groups"].items()),
        "  columns (tests diverging / unexpected): " + ", ".join(
            f"{c} {v['diverging_tests']}/{v['unexpected_tests']}" for c, v in doc["summary"]["columns"].items()
            if v["diverging_tests"]),
        "  rules: " + ", ".join(f"{r['id']} {r['hit_tests']}" for r in doc["rules"]),
    ]
    cov = doc.get("coverage") or {}
    if cov:
        miss = {g: len(v) for g, v in cov["missing_by_group"].items()}
        lines.append(f"  coverage: {cov['present']}/{cov['reference_files']} reference files"
                     + (f", {len(cov['extra'])} extra" if cov["extra"] else "")
                     + (f"; missing {miss}" if miss else ""))
    stale = [r["id"] for r in doc["rules"] if r["hit_tests"] == 0]
    if stale:
        lines.append(f"  rules with no hits: {', '.join(stale)}")
    cls = doc["unexpected_classes"]
    if cls:
        lines.append(f"  unexpected classes: {len(cls)}")
        for c in cls[:show]:
            ex = c["reproducer"]
            masks = ", ".join(f"{n}:{flag_names(m, doc['isa'], n)}" for n, m in c["unexpected_xor"].items())
            files = " ".join(c["files"][:12]) + (" ..." if len(c["files"]) > 12 else "")
            lines.append(f"    [{c['group']}] {c['tests']} tests in {len(c['files'])} files ({files}); {masks}")
            lines.append(f"        e.g. {ex['name']!r} bytes {ex['bytes']}: " + json.dumps(ex["diff"])[:400])
    secs = run["seconds"]
    lines.append(f"  time {secs['total']} s (gpu {secs['gpu']} s, {run['dispatches']} dispatches); ledger sha256 {digest[:16]}")
    return "\n".join(lines)


def markdown(doc: dict, run: dict, digest: str, analysis: str | None) -> str:
    from .report_md import render

    return render(doc, run, digest, analysis)
