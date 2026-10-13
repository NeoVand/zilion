# Attribution and external references

Zilion is licensed under [MIT](LICENSE). Upstream vector datasets are downloaded separately and are not distributed in this repository or the npm package. The committed expected-rule files, analytic fixtures and validation ledgers are Zilion's own test artifacts; ledger reproducers identify the relevant upstream cases.

## Validation datasets

| Dataset and pinned revision | Attribution | Upstream licence |
|---|---|---|
| [SingleStepTests/z80](https://github.com/SingleStepTests/z80/tree/ebe1875d48f374bcfd4b505d8eb8ee751568b5f7), `v1`, `ebe1875d48f374bcfd4b505d8eb8ee751568b5f7` | Copyright 2024 SingleStepTests; JSMoo-based Z80 instruction vectors | [MIT](https://github.com/SingleStepTests/z80/blob/ebe1875d48f374bcfd4b505d8eb8ee751568b5f7/LICENSE) |
| [SingleStepTests/65x02](https://github.com/SingleStepTests/65x02/tree/2f6980a2d95757486c7bee24355c360e40e2a224), `6502/v1`, `2f6980a2d95757486c7bee24355c360e40e2a224` | Copyright 2024 Thomas Harte et al.; NMOS 6502 instruction vectors | [MIT](https://github.com/SingleStepTests/65x02/blob/2f6980a2d95757486c7bee24355c360e40e2a224/LICENSE) |
| [SingleStepTests/8088](https://github.com/SingleStepTests/8088/tree/aea84484abc79d09639d855b7b0ab32bc9e4dbeb), `v2` and `v2_undefined`, `aea84484abc79d09639d855b7b0ab32bc9e4dbeb` | Copyright 2024 SingleStepTests; hardware-generated AMD D8088 vectors, project by Daniel Balsom and contributors | [MIT](https://github.com/SingleStepTests/8088/blob/aea84484abc79d09639d855b7b0ab32bc9e4dbeb/LICENSE) |

The fetchers pin complete Git commits and verify each downloaded Git blob. Preserve upstream copyright and licence notices if you redistribute downloaded data. See [Testing](docs/TESTING.md) for fetch and reproduction commands.

## Semantic and research references

- BFF is the Brainfuck-family language described by Agüera y Arcas et al. in [Computational Life (2024)](https://arxiv.org/abs/2406.19108). Zilion's equivalence harness reads the GPU implementation and CPU reference in the author's [Algocell](https://github.com/NeoVand/algocell) checkout, `experiments/micro/bff.py`: file revision `406d69f`, SHA-256 `e4772ef6156712f159c119b32290888203d65f2e109535a5474a49369c685ed2`. Algocell currently has no repository licence file; it is a separately accessed reference, and its external reference files are not vendored here. Public access does not grant a redistribution licence.
- The independent NMOS decimal-mode check implements the algorithm in Bruce Clark's *Decimal Mode*, Appendix A, [6502.org source](https://github.com/6502org/6502.org/blob/main/public/tutorials/decimal_mode.html). The tutorial is a cited specification, not a bundled dataset or copied test program. No separate software licence is assumed for the tutorial.
- Intel semantics are checked against the [1979 8086 Family User's Manual](https://bitsavers.org/components/intel/8086/9800722-03_The_8086_Family_Users_Manual_Oct79.pdf) and Ken Shirriff's original [multiplication](https://www.righto.com/2023/03/8086-multiplication-microcode.html) and [division](https://www.righto.com/2023/04/reverse-engineering-8086-divide-microcode.html) analyses. These are external copyrighted references, not distributed source code. See [I8086](docs/I8086.md) for the hardware abstraction and validation limits.
- [py65](https://github.com/mnaberez/py65), by Mike Naberezny and contributors, uses the [BSD 3-Clause licence](https://github.com/mnaberez/py65/blob/master/LICENSE.txt). No py65 code or data is included, imported or used as the decimal-mode oracle in Zilion's committed harness.

## Build and test dependencies

There are no JavaScript runtime dependencies. Build tools are installed separately: [TypeScript](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) (Apache-2.0) and [WebGPU types](https://github.com/gpuweb/types/blob/main/LICENSE) (BSD-3-Clause, WebGPU Developers). The headless test host uses [wgpu-py](https://github.com/pygfx/wgpu-py/blob/main/LICENSE) (BSD-2-Clause), [NumPy](https://github.com/numpy/numpy/blob/main/LICENSE.txt) (BSD-3-Clause), and, for BFF reference tests, [pytest](https://github.com/pytest-dev/pytest/blob/main/LICENSE) (MIT). These dependencies and their datasets are not vendored into Zilion.
