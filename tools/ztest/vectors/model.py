"""Data model of the vector runner. Nothing here is ISA-specific."""

from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

# Memory-table word flags (shared with host.py's WGSL).
READABLE = 0x100  # listed in the vector's initial RAM
WRITTEN = 0x200  # written by the core during the run
CONSUMED = 0x100  # port-read entry consumed by io_read

# Lane status flags (shared with host.py's WGSL).
ST_UNLISTED_READ = 1  # the core read an address absent from the initial RAM (and not written before)
ST_STRAY_WRITE = 2  # the core wrote an address absent from both RAM lists
ST_MEM_OVERFLOW = 4  # the sparse table was full (harness capacity, not a core result)
ST_UNLISTED_PORT = 8  # io_read of a port the vector does not list
ST_PORT_OVERFLOW = 16  # io_write log full (harness capacity)
HARNESS_ERRORS = ST_MEM_OVERFLOW | ST_PORT_OVERFLOW

# Sub-kinds of the two pseudo-fields `mem` and `ports` (their "xor bits" in the ledger).
MEM_VALUE = 1  # a listed address ends with the wrong value (or a reference write did not happen)
MEM_STRAY = 2  # write outside the listed addresses
MEM_READ = 4  # read outside the listed addresses
PORT_WRITE = 1  # port-write log differs from the vector's "w" entries (order, port or value)
PORT_READ_MISSING = 2  # a listed port read never happened
PORT_UNLISTED = 4  # read of an unlisted port
MEM_KINDS = {MEM_VALUE: "value", MEM_STRAY: "stray-write", MEM_READ: "unlisted-read"}
PORT_KINDS = {PORT_WRITE: "write", PORT_READ_MISSING: "read-missing", PORT_UNLISTED: "unlisted-read"}


@dataclass(frozen=True)
class Field:
    """One word of the state record that the GPU loads and stores."""

    name: str  # ledger field name; also the vector's JSON key unless `key` is given
    bits: int
    column: str  # ledger column this field is reported under
    architectural: bool = True  # counts toward the architectural pass rate
    compare: bool = True  # False: host-only output (e.g. a halted flag), never compared
    key: str | None = None

    @property
    def mask(self) -> int:
        return (1 << self.bits) - 1

    @property
    def json_key(self) -> str:
        return self.key or self.name


@dataclass(frozen=True)
class Rule:
    """An expected divergence: (files, fields, bit mask, predicate) -> explained, with its reason and source."""

    id: str
    files: tuple[str, ...]  # fnmatch patterns over the opcode key (the vector file's stem); "*" = every file
    fields: tuple[str, ...]  # state field names, or "mem" / "ports"
    mask: int | dict | None  # covered bits: one mask for all fields, {field: mask}, or None (every bit)
    reason: str
    source: str
    when: str | None = None  # named predicate of the adapter (None = always)
    status: str = "expected"

    def matches_file(self, key: str) -> bool:
        return any(fnmatch.fnmatchcase(key, p) for p in self.files)

    def mask_for(self, field: str, full: int) -> int:
        m = self.mask.get(field) if isinstance(self.mask, dict) else self.mask
        return full if m is None else m & full

    @staticmethod
    def from_json(d: dict) -> "Rule":
        num = lambda v: int(v, 0) if isinstance(v, str) else v  # noqa: E731
        mask = d.get("mask")
        mask = {k: num(v) for k, v in mask.items()} if isinstance(mask, dict) else num(mask)
        return Rule(
            id=d["id"],
            files=tuple(d["files"]),
            fields=tuple(d["fields"]),
            mask=mask,
            reason=d["reason"],
            source=d["source"],
            when=d.get("when"),
            status=d.get("status", "expected"),
        )


@dataclass
class FileBatch:
    """One vector file packed for the GPU (n tests; E memory slots; P port slots; F state words)."""

    key: str  # opcode key, e.g. "ed b0"
    path: Path
    sha256: str  # of the file as read (compressed bytes)
    names: list[str]
    state_in: np.ndarray  # [n, F] u32
    state_exp: np.ndarray  # [n, F] u32
    mem_n: np.ndarray  # [n] u32: number of listed addresses (initial RAM union final RAM)
    mem_addr: np.ndarray  # [n, E] u32
    mem_init: np.ndarray  # [n, E] u32: initial value | READABLE if listed in the initial RAM
    mem_exp: np.ndarray  # [n, E] u32: expected final value
    mem_final_only: np.ndarray  # [n, E] bool: written by the reference, absent from the initial RAM
    port_in_n: np.ndarray  # [n]
    port_in: np.ndarray  # [n, P, 2]: (port, value) reads, in order
    port_out_n: np.ndarray  # [n]
    port_out: np.ndarray  # [n, P, 2]: expected (port, value) writes, in order
    orig: np.ndarray  # [n] row -> index of the test in its file (rows may be a filtered subset)
    tests: list[dict] = field(repr=False, default_factory=list)  # the whole file's parsed tests, or [] (dropped)
    tests_loader: Callable[[], list[dict]] | None = field(repr=False, default=None)

    @property
    def n(self) -> int:
        return len(self.names)

    def test(self, i: int) -> dict:
        """The parsed JSON of row i; reloads the file through tests_loader if the parsed tests were dropped."""
        if not self.tests:
            if self.tests_loader is None:
                raise RuntimeError(f"{self.key}: parsed tests were dropped and there is no loader")
            self.tests = self.tests_loader()
        return self.tests[int(self.orig[i])]

    def subset(self, idx: list[int]) -> "FileBatch":
        ix = np.asarray(idx, dtype=np.int64)
        pick = lambda a: a[ix]  # noqa: E731
        return FileBatch(
            key=self.key, path=self.path, sha256=self.sha256, names=[self.names[i] for i in idx],
            state_in=pick(self.state_in), state_exp=pick(self.state_exp), mem_n=pick(self.mem_n),
            mem_addr=pick(self.mem_addr), mem_init=pick(self.mem_init), mem_exp=pick(self.mem_exp),
            mem_final_only=pick(self.mem_final_only), port_in_n=pick(self.port_in_n), port_in=pick(self.port_in),
            port_out_n=pick(self.port_out_n), port_out=pick(self.port_out), orig=pick(self.orig), tests=self.tests,
        )


@dataclass
class LaneOutputs:
    """What the GPU returned for a FileBatch (same row order)."""

    state: np.ndarray  # [n, F]
    mem_n: np.ndarray  # [n]
    mem_addr: np.ndarray  # [n, CAP]
    mem_word: np.ndarray  # [n, CAP]: value | READABLE | WRITTEN
    port_in_word: np.ndarray  # [n, P]: value | CONSUMED
    port_out_n: np.ndarray  # [n]
    port_out: np.ndarray  # [n, P, 2]
    status: np.ndarray  # [n, 4]: flags, first unlisted read, first stray write, first unlisted port

    def digest_parts(self) -> list[np.ndarray]:
        return [self.state, self.mem_n, self.mem_addr, self.mem_word, self.port_in_word, self.port_out_n,
                self.port_out, self.status]


Predicate = Callable[[FileBatch, LaneOutputs], np.ndarray]


def natural_key(key: str) -> tuple:
    """Sort order for opcode keys: by prefix bytes then opcode, numerically ("__" placeholders sort first)."""
    return tuple(-1 if t == "__" else int(t, 16) if re.fullmatch(r"[0-9a-f]{2}", t) else 0x1000 for t in key.split())
