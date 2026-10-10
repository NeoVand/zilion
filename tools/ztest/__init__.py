"""Headless test harness for Zilion (wgpu-py).

Node emits the WGSL from the TypeScript sources (tools/build-wgsl.mjs); this
package compiles and dispatches it with wgpu-py, and holds the generic
per-instruction vector runner (tools/ztest/vectors). See docs/TESTING.md.
"""

HARNESS_VERSION = "1"
