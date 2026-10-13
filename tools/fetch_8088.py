"""Fetch data only from SingleStepTests/8088, pinned and Git-blob verified.

Run with python -I. The default invocation is an inventory; --download fetches
v2 and v2_undefined without decompressing vectors. No upstream tools are run.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import urllib.parse
import urllib.request

COMMIT = "aea84484abc79d09639d855b7b0ab32bc9e4dbeb"
REPO = "SingleStepTests/8088"
LIMIT = 3_000_000_000


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Zilion-vector-fetcher"})
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.read()


def blob(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--out", type=Path, default=Path("../zilion-vectors/8088"))
    args = ap.parse_args()
    tree = json.loads(get(f"https://api.github.com/repos/{REPO}/git/trees/{COMMIT}?recursive=1"))
    if tree.get("truncated"):
        raise RuntimeError("truncated Git tree; cannot establish size")
    entries = [e for e in tree["tree"] if e["type"] == "blob" and
               (e["path"].split("/")[0] in ("v2", "v2_undefined") or
                e["path"] in ("README.md", "LICENSE", "CHANGELOG.md"))]
    size = sum(e["size"] for e in entries)
    gz_size = sum(e["size"] for e in entries if e["path"].endswith(".gz"))
    print(f"{REPO}@{COMMIT}: {len(entries)} files, {size:,} bytes; compressed vectors {gz_size:,} bytes", flush=True)
    if gz_size > LIMIT:
        raise SystemExit("STOP: compressed set exceeds 3 GB; user approval required")
    if not args.download:
        return
    args.out.mkdir(parents=True, exist_ok=True)

    def fetch(e: dict) -> None:
        rel = PurePosixPath(e["path"])
        if rel.is_absolute() or ".." in rel.parts:
            raise RuntimeError("unsafe path in upstream tree")
        target = args.out.joinpath(*rel.parts)
        if target.exists() and blob(target.read_bytes()) == e["sha"]:
            return
        url = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/" + urllib.parse.quote(e["path"])
        data = get(url)
        if len(data) != e["size"] or blob(data) != e["sha"]:
            raise RuntimeError(f"blob verification failed: {e['path']}")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".partial")
        temporary.write_bytes(data)
        temporary.replace(target)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for i, _ in enumerate(pool.map(fetch, entries), 1):
            if i % 25 == 0:
                print(f"verified {i}/{len(entries)}", flush=True)
    (args.out / "PIN.json").write_text(json.dumps({"repository": REPO, "commit": COMMIT,
        "compressed_bytes": gz_size, "total_bytes": size, "files": entries}, indent=2) + "\n")
    print("all Git blob hashes verified", flush=True)


if __name__ == "__main__":
    main()
