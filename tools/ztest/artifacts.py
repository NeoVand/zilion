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

    def configs(self, isa: str) -> list[dict]:
        """Every emitted core configuration of `isa` (variant, compat, hooks), the default first."""
        return self.manifest.get("coreConfigs", {}).get(isa) or [self.manifest["cores"][isa]]

    def core_config(self, isa: str) -> dict:
        """The selected configuration of `isa`'s core: export, variant, compat, hooks, SHA-256 (for run records)."""
        e = self.manifest["cores"][isa]
        return {k: e[k] for k in ("key", "export", "variant", "compat", "hooks", "coreVersion", "sha256", "override") if k in e}

    def select(self, isa: str, *, variant: str | None = None, compat: str | None = None) -> "Artifacts":
        """These artifacts with `isa`'s core switched to the emitted configuration matching variant and compat
        (unspecified: the default configuration's value). Raises when no configuration matches."""
        if variant is None and compat is None:
            return self
        configs = self.configs(isa)
        want_v = variant if variant is not None else configs[0].get("variant")
        want_c = compat if compat is not None else configs[0].get("compat")
        hits = [c for c in configs if c.get("variant") == want_v and c.get("compat") == want_c]
        if not hits:
            have = ", ".join(f"variant {c.get('variant')} compat {c.get('compat')}" for c in configs)
            raise HarnessError(f"no emitted {isa} core with variant {want_v!r} and compat {want_c!r} (emitted: {have})")
        m = json.loads(json.dumps(self.manifest))
        m["cores"][isa] = hits[0]
        return Artifacts(root=self.root, manifest=m)

    def provenance(self, isa: str | None = None) -> dict:
        """What the results depend on: the package version and the core text's SHA-256."""
        m = self.manifest
        out = {"package": m["package"]}
        if isa is not None:
            out["core"] = {"isa": isa, "sha256": m["cores"][isa]["sha256"]}
        return out

    def source(self) -> dict:
        """Where the WGSL came from (git commit, toolchain): recorded with a run, not in the canonical ledger."""
        return {"git": self.manifest["git"], "toolchain": self.manifest["toolchain"]}


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


def with_core(art: Artifacts, isa: str, text: str, origin: str) -> Artifacts:
    """Artifacts whose `isa` core is replaced by `text` (an override, recorded by SHA-256 and origin)."""
    m = json.loads(json.dumps(art.manifest))
    base = m["cores"][isa]
    m["cores"][isa] = {"export": f"override:{origin}", "file": None, "sha256": sha256_text(text), "override": True,
                       **{k: base[k] for k in ("variant", "compat", "hooks") if k in base}}
    return _OverrideArtifacts(root=art.root, manifest=m, _text=text, _isa=isa)


@dataclass(frozen=True)
class _OverrideArtifacts(Artifacts):
    _text: str = ""
    _isa: str = ""

    def core(self, isa: str) -> str:
        return self._text if isa == self._isa else super().core(isa)

    def select(self, isa: str, *, variant: str | None = None, compat: str | None = None) -> "Artifacts":
        if variant is None and compat is None:
            return self
        raise HarnessError("select a core configuration before overriding its text (with_core), not after")

    def configs(self, isa: str) -> list[dict]:
        """Every emitted core configuration of `isa` (variant, compat, hooks), the default first."""
        return self.manifest.get("coreConfigs", {}).get(isa) or [self.manifest["cores"][isa]]

    def core_config(self, isa: str) -> dict:
        """The selected configuration of `isa`'s core: export, variant, compat, hooks, SHA-256 (for run records)."""
        e = self.manifest["cores"][isa]
        return {k: e[k] for k in ("key", "export", "variant", "compat", "hooks", "coreVersion", "sha256", "override") if k in e}

    def select(self, isa: str, *, variant: str | None = None, compat: str | None = None) -> "Artifacts":
        """These artifacts with `isa`'s core switched to the emitted configuration matching variant and compat
        (unspecified: the default configuration's value). Raises when no configuration matches."""
        if variant is None and compat is None:
            return self
        configs = self.configs(isa)
        want_v = variant if variant is not None else configs[0].get("variant")
        want_c = compat if compat is not None else configs[0].get("compat")
        hits = [c for c in configs if c.get("variant") == want_v and c.get("compat") == want_c]
        if not hits:
            have = ", ".join(f"variant {c.get('variant')} compat {c.get('compat')}" for c in configs)
            raise HarnessError(f"no emitted {isa} core with variant {want_v!r} and compat {want_c!r} (emitted: {have})")
        m = json.loads(json.dumps(self.manifest))
        m["cores"][isa] = hits[0]
        return Artifacts(root=self.root, manifest=m)

    def provenance(self, isa: str | None = None) -> dict:
        out = super().provenance(isa)
        if isa == self._isa:
            out["core"]["override"] = self.manifest["cores"][isa]["export"]
        return out
