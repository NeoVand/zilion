#!/usr/bin/env python3
"""Fetch a SingleStepTests vector set at a pinned commit, verified against git's own blob hashes (design §6.2).

Usage: python -I tools/fetch-vectors.py <owner/repo> <commit> <path-prefix> <dest-dir> [--jobs N]
  e.g. python -I tools/fetch-vectors.py SingleStepTests/z80 <commit sha> v1/ ../zilion-vectors/z80

* Lists the tree at <commit> (GitHub API git/trees/<commit>?recursive=1); a truncated listing is an error.
* Downloads every blob under <path-prefix> from raw.githubusercontent.com at that commit. Paths are URL-quoted:
  SingleStepTests names contain spaces ("v1/cb 00.json"), which an unquoted URL cannot carry.
* Checks git's blob SHA-1 (sha1(b"blob <size>\\0" + bytes)) against the tree entry, so every file is exactly the
  committed one, and checks that it parses as JSON (data only; nothing is executed).
* Writes <dest>/<file name>.gz atomically, and <dest>/MANIFEST.json with the repo, the commit, and per file the
  blob SHA-1 and the SHA-256 of the written .gz. Files already present with a matching manifest entry are skipped.

The destination is untrusted data: keep it outside the repository and run tools on it with python -I.
Downloading needs network access and the maintainer's approval; the harness itself never downloads.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://api.github.com/repos/{repo}/git/trees/{commit}?recursive=1"
RAW = "https://raw.githubusercontent.com/{repo}/{commit}/{path}"


def git_blob_sha1(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def raw_url(repo: str, commit: str, path: str) -> str:
    return RAW.format(repo=repo, commit=commit, path=urllib.parse.quote(path, safe="/"))


def safe_name(path: str) -> str:
    """The file name a tree path is stored under; refuses anything that is not a plain name."""
    name = path.rsplit("/", 1)[-1]
    if not name or name in (".", "..") or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError(f"refusing tree path {path!r}")
    return name


def fetch(url: str, timeout: int = 120) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 (https only, fixed hosts)
        return r.read()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("repo")
    ap.add_argument("commit", help="full commit SHA to pin (not a branch name)")
    ap.add_argument("prefix")
    ap.add_argument("dest", type=Path)
    ap.add_argument("--jobs", type=int, default=8)
    a = ap.parse_args()
    if len(a.commit) != 40 or any(c not in "0123456789abcdef" for c in a.commit):
        ap.error("commit must be a full 40-hex-digit SHA")
    tree = json.loads(fetch(API.format(repo=a.repo, commit=a.commit)))
    if tree.get("truncated"):
        print("tree listing truncated; refusing a partial set", file=sys.stderr)
        return 2
    entries = [t for t in tree["tree"] if t["type"] == "blob" and t["path"].startswith(a.prefix)
               and t["path"].endswith(".json")]
    a.dest.mkdir(parents=True, exist_ok=True)
    man_path = a.dest / "MANIFEST.json"
    manifest = json.loads(man_path.read_text()) if man_path.exists() else {}
    if manifest and (manifest.get("repo"), manifest.get("commit")) != (a.repo, a.commit):
        print(f"{man_path} is for {manifest.get('repo')}@{manifest.get('commit')}; use an empty directory", file=sys.stderr)
        return 2
    files = manifest.get("files", {})

    def one(t: dict) -> tuple[str, dict | None, str | None]:
        name = safe_name(t["path"]) + ".gz"
        out = a.dest / name
        prev = files.get(name)
        if prev and prev["blob_sha1"] == t["sha"] and out.exists() \
                and hashlib.sha256(out.read_bytes()).hexdigest() == prev["gz_sha256"]:
            return name, prev, None
        last = None
        for _ in range(3):
            try:
                data = fetch(raw_url(a.repo, a.commit, t["path"]))
                if git_blob_sha1(data) != t["sha"]:
                    raise ValueError("blob SHA-1 mismatch")
                json.loads(data)
                gz = gzip.compress(data, compresslevel=6, mtime=0)
                tmp = out.with_name(out.name + ".part")
                tmp.write_bytes(gz)
                os.replace(tmp, out)
                return name, {"path": t["path"], "blob_sha1": t["sha"], "gz_sha256": hashlib.sha256(gz).hexdigest()}, None
            except Exception as e:  # network or verification failure: retried, then reported
                last = f"{t['path']}: {e}"
        return name, None, last

    errors = []
    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        for k, (name, entry, err) in enumerate(pool.map(one, entries), 1):
            if entry:
                files[name] = entry
            else:
                errors.append(err)
            if k % 100 == 0 or k == len(entries):
                print(f"{k}/{len(entries)} ({len(errors)} failed)", flush=True)
    man_path.write_text(json.dumps({"repo": a.repo, "commit": a.commit, "prefix": a.prefix,
                                    "files": dict(sorted(files.items()))}, indent=1) + "\n")
    for e in errors:
        print("failed:", e, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
