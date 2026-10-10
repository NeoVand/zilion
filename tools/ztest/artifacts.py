"""The WGSL artifacts that tools/build-wgsl.mjs emits from the TypeScript sources, with their provenance."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .gpu import HarnessError

REPO = Path(__file__).resolve().parents[2]
DEFAULT_WGSL_DIR = REPO / "build" / "wgsl"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Artifacts:
    root: Path
    manifest: dict

    @property
    def version(self) -> str:
        return self.manifest["package"]["version"]

    def core(self, isa: str) -> str:
        """The core's WGSL text, verified against the SHA-256 recorded at emission."""
        entry = self.manifest["cores"].get(isa)
        if entry is None:
            raise HarnessError(f"no {isa!r} core in {self.root / 'manifest.json'}")
        return self.text(entry)

    def text(self, entry: dict) -> str:
        text = (self.root / entry["file"]).read_text(encoding="utf-8")
        if sha256_text(text) != entry["sha256"]:
            raise HarnessError(f"{entry['file']} does not match its manifest SHA-256; re-run tools/build-wgsl.mjs")
        return text

    def json(self, rel: str) -> dict:
        return json.loads((self.root / rel).read_text(encoding="utf-8"))

    def provenance(self, isa: str | None = None) -> dict:
        m = self.manifest
        out = {"package": m["package"], "git": m["git"], "toolchain": m["toolchain"]}
        if isa is not None:
            out["core"] = {"isa": isa, "sha256": m["cores"][isa]["sha256"]}
        return out


def emit(out_dir: Path = DEFAULT_WGSL_DIR) -> None:
    """Run tools/build-wgsl.mjs (tsc build + WGSL emission). Node is found on PATH or via ZILION_NODE."""
    node = os.environ.get("ZILION_NODE") or shutil.which("node")
    if not node:
        raise HarnessError("node not found (set ZILION_NODE); it is needed to emit WGSL from the TypeScript sources")
    r = subprocess.run([node, str(REPO / "tools" / "build-wgsl.mjs"), str(out_dir)], cwd=REPO)
    if r.returncode != 0:
        raise HarnessError(f"tools/build-wgsl.mjs failed with exit code {r.returncode}")


def load(out_dir: Path = DEFAULT_WGSL_DIR, *, do_emit: bool = True) -> Artifacts:
    if do_emit:
        emit(out_dir)
    path = out_dir / "manifest.json"
    if not path.exists():
        raise HarnessError(f"{path} not found; run `node tools/build-wgsl.mjs` (or drop --no-emit)")
    return Artifacts(root=out_dir, manifest=json.loads(path.read_text(encoding="utf-8")))


def run_node(script: str, *args: str) -> subprocess.CompletedProcess:
    node = os.environ.get("ZILION_NODE") or shutil.which("node")
    if not node:
        raise HarnessError("node not found (set ZILION_NODE)")
    return subprocess.run([node, str(REPO / "tools" / script), *args], cwd=REPO, capture_output=True, text=True)
