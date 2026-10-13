# History rewrite before publication (2026-10-12)

Before the first public push of the 0.3 line, unpublished commits were rewritten to remove local filesystem paths
from documentation and test-baseline metadata. No source file changed. The table maps each original commit ID
(cited in the Algocell paper's provenance records) to its published ID, and reports whether `src/`, `test/world/`,
`test/unit.mjs` and `package.json` are byte-identical between the two.

| original | published | src etc. | subject |
|---|---|---|---|
| `3c3534d76f228ce48c766df4aed98970f5dd4bd2` | `89391511f90b224091be4e55902f345b9d2ee01a` | identical | Merge reviewed 8086 seeded bootstrap regression probes |
| `1857d6f2a7c8099d330248e8481199e75efc3498` | `ab4d1533a86cda4f1902582e8969876f0a977b47` | identical | test(i8086): pin full bootstrap outcomes on seeded random panel |
| `39a60429a9b16c77cd845f6087062c4e2cc12c53` | `05bd6fa2219c90b34574189864631a42ef80ea66` | identical | Merge reviewed coherent-fetch 8086 Gate 1 machine |
| `fdf978d1ffc2a4aa467c150daa8fddb1e3618bc4` | `6abfcf3ed25cf53f6dfc19fb359d4a0ca7cf6175` | identical | feat(i8086): freeze validated coherent-fetch paper machine |
| `2a4ba6fbb67713a3a3714c48e1dea382aa2ac50d` | `6d0c0f781472129e889110735e931ff5bf8584b0` | identical | style: remove trailing blank line from Intel vector adapter |
| `1f264c55ac8b9a557b65a91588281ab9b5c2c8f2` | `fad6a5d3b299d82f37d6f4c3d044872967995573` | identical | docs(i8086): record architectural ledger, queue gap and M4 throughput |
| `e6aefbfa0c3885c190f91fd6582b154d689c3a8f` | `0586025178530cc67cbf25c41fa3b19da5d071be` | identical | fix(i8086): read reserved FLAGS bits correctly on pushes |
| `677ea66f570b010d92c8ded40bedd044b5f1abcd` | `6af2c2a846e75f15aa9bdb6ed50c17ee34623e0e` | identical | fix: preserve unsigned DIV results under REP prefixes |
| `c79ad830365e98258814f37bd7439421c70964d6` | `7827e7e063568f5f6353fb42632a30ebec631244` | identical | test: protect 8086 trap boundaries, open-channel probe and REP mutant coverage |
| `42451392c14844e65ef8b56138cf5ad187fdedd2` | `b4a0933c120fdf1b62deb47d1aeeb9f1e6b7d298` | identical | i8086: add architectural core, strict hardware adapter, world probes and mutants |
| `bbf55cba9d7644135ad5c0a0699c1fc78740e55d` | `bd0e6e1929188ce362a684a2e5e61f3eacc2180f` | identical | tools: fetch pinned 8088 hardware vector data with size guard and blob verification |
| `183ff5c7429403439c664487980a40bf62f49b7b` | `a6a90d2780271dd3a90555f72fd293cb2528525c` | identical | Merge m2/bff: full BFF core, bit-identical to Algocell's bff.py (GPU kernel and CPU reference) in 20 configurations x 1,048,576 pairs; generic table params; dial hash verified |
| `41e653cdd0246b0f14b5be031844c5e41d538fc3` | `4f0480037f270036f5d9cf8e12dcf408f3d74269` | identical | BFF equivalence baseline: 1,048,576 pairs per configuration, all identical |
| `a499584eaf400e95b139a4a3e5a711dc975e0bf2` | `a623339ae620405c7baf362ca2916d2500ea51b1` | identical | Merge next (ed93b7c: Z80 compat required, machine presets, export by core id, the full 6502 core) into m2/bff |
| `ed93b7c3aecdfe6a0cedf6dcb3f63aebb78bac8d` | `0befb51decc07be64c65ccd976b69573208cc7d1` | identical | Export test: the full 6502 core exports as compat 0.3 / 0.3.0 without a skeleton note (fixes the test left stale by the 6502 merge, which I committed before running it) |
| `d9563fc3b3d75750d8e6628897efe7ad290c7903` | `18fc39114fef2558089c252ed3d1afe4deaa33e0` | identical | Re-review nits: gates and the dial selection keyed on bff.py's halt_q, an odd-k tie, an exact table input type, CHANGELOG |
| `a32f207b875befe3d75fb6e683bf6c3fa0efedae` | `f3013f6107e01af47d9f1e524c8322c3af89189b` | identical | Merge m2/6502: full NMOS 6502 core (all 256 opcodes; 2,560,000 SingleStepTests vectors, 0 divergences, 0 rules; decimal mode gated exhaustively against Clark's Appendix A), exported as experimental |
| `c01d65cb33bbc796dea8615c05b4d66324c8d36e` | `e93664b837b2b4c11e020011b27fc5238034af9b` | identical | Machine presets instead of world.compat; export-machines takes the core selection beside the world, any core by id |
| `c066a38626d617a4cb855a4417317df5608a66ba` | `c4e89c87393a4e1d0c5acd1ac078db83fdfb557f` | identical | 6502: decimal mode gated exhaustively against Clark's NMOS algorithm; m6502 exported and shipped |
| `d1b7ce1322c61ba6f97230b770164dfb8e538320` | `ec9cf5c7e758f1309f2c6790da37ac2f097553cc` | identical | Baseline report for zilog-nmos after the host-halt Q change (ledger 06c049e76ffd0f7d, 0 unexpected) |
| `c542a9027a1e83276e23c2fc0b595c6e5a64130d` | `987f2e1057e614cb2c31772b8bac5e17b55671bc` | identical | Z80 follow-up decisions: compat named (no default through 0.3.x), manifests report the semantics that ran, host halt freezes Q |
| `77797b9e7736b4189534d1b7845b72abb119288b` | `f9be2d3782ca98e268fa0b1a732948e1699d872f` | identical | Review fixes: typed-array table input type, the dial corners and normalised selections in the bff.py mapping, non-vacuity gates, edge configurations |
| `b91e8506d1da2eded65f76eb7eedd8cd24d55fec` | `cec900bd8e6c4c2194fb34fff7cd0f9f32377bf4` | identical | Merge next (81c88dc: Z80 0.3 semantics, zilog-nmos variant, compat 0.2 frozen) into m2/6502 |
| `f87f32c8ed6f08e3841047547944a6ed2358235d` | `0255444338a8c58188b60d14deba85372878475f` | identical | Merge next (81c88dc: Z80 0.3 semantics, zilog-nmos, compat '0.2' frozen) into m2/bff |
| `81c88dc01083ebd940264d4e4a0708bf97f186f7` | `bd7b94fb13c5388310388e79b39cfaaa71512d8d` | identical | Merge m1/z80-fixes: Z80 0.3 semantics (wasted-prefix R, full MEMPTR, IM, block-repeat flags, ports, halt reasons), zilog-nmos Q-latch variant, compat '0.2' frozen and byte-identical; ledgers: 0.3 0 unexpected, nmos 0 unexpected (EI-P only), 0.2 unchanged |
| `04caf3a8ac9222e5d0077434f9804c527edf5022` | `9fe4fe1d45d8b04022d3dfa2cfeb0fc88d93483e` | identical | 6502 baseline report regenerated with the review's analysis (ledger unchanged: da7f6d9e...) |
| `35c8c3918a33024f0b8c68c6b540056abf3496f8` | `ca1c6e40f4f28a7327d51cf0370367c913638083` | identical | Review fixes: legacy manifest names the 0.2.0 core; Q latch without a step wrapper; nits |
| `34e0c0930b2b91877bf9a59786161dfd121788ea` | `12cafd29cbefd26c4d0104319a49732b4a88f07d` | identical | Review fixes: vectors on the hooked 6502 text, coverage limits documented, wording |
| `73ba75e0bd87a39b8ccad1c57dd9f0b323507840` | `0c5d9e2bf46464e2514be137f1dbbfd21a7b4c75` | identical | Docs: the BFF core, table params, the bff.py mapping and equivalence harness |
| `b540e09aa82b6175d467d8296593aa388eb4e7e0` | `fa0c907e1c0f893b64a183192f6b9faff6970a4c` | identical | BFF core: brackets, literal push, alphabet as a table param; bff.py equivalence harness |
| `fb6f53cf242c90b765cf3077b29c51cf4e2e3460` | `daa2cc277415cff360fb9c7b966a43df05bb5ca9` | identical | Full 6502 SingleStepTests baseline for the 0.3.0-dev core: 2,560,000 tests, zero divergences, zero rules |
| `fb6c6081311deaf931890cde0538704a3aab115f` | `8771235b7b382156f7b2c3fb61f3dcae8fd7ce98` | identical | 6502: opcode table on the descriptor; docs for the full core; report footer counts clean files |
| `b2f8644b5962587cd4e93d821add6135d4144e3a` | `0aa597d810c2b1f79071f8eebf123171b22b7273` | identical | Docs and baselines for the Z80 0.3 semantics |
| `af4f0dbf31c07f1d92aa5448d829986442ac9f52` | `489efebaa8e8cc50d9d799bc88df437789974b74` | identical | Merge next (stack follow-up: covering the stack fields gives the stack, stackless ISAs accept init.stack) into m2/6502 |
| `c975bd90a2232d9f8dab2ec9fabad91d2484a69b` | `ed84e35c33a80a678ba608a5025048c8b75e909f` | identical | Merge next (contract: firstPushAt, trapCause, explicit stack and budget, core params, manifest/2) into m2/6502 |
| `3625cd5df06c84af256c8573d422348bdb88039f` | `4b99aaa84d75aa5ce8a3cb16aebf1017c981b308` | identical | Merge next (adf70f9: stack follow-up) into m1/z80-fixes |
| `15d4704c158fc379280ca2c43c2079a597a8fd8e` | `f37de2145dd724906e2e378cc07057119b9fd5b6` | identical | Merge next (contract: firstPushAt, trapCause, no silent defaults, core params, resumable runs) into m1/z80-fixes |
| `adf70f99cae1721ef0ebff1cb6294a42e65b893d` | `695822688ceb23090913f79063cee7bf41bba0e6` | identical | Stack follow-up: covering the stack fields gives the stack, stackless ISAs accept init.stack, defaults listed |
| `2bc2a105d07c9ab3c2e238efa377f1e8b31904a0` | `10346059f17c3d07cfc962c83511bd17f1b9e7cf` | identical | Z80 0.3 semantics: wasted-prefix R, full MEMPTR, IM, block-repeat flags, ports, halt reasons; compat '0.2' frozen |
| `1a3898d193f6e8830305e008e35e326a23e651e1` | `e3a348fc048d989fcd131ed7484a7653c5570230` | identical | 6502 core v2: a fixed sequence of short phases driven by a per-opcode decode word |
| `c9aba934e2ddd6d394ae30cdafaafcb03ba926a6` | `611de389e03ee77c61c9a1cf5993d05c16d9b760` | identical | Merge m1/contract: firstPushAt, trapCause, no silent stack/budget defaults, core params, resumable runs (manifest/2); 0.2 output byte-identical |
| `6ebfa6814acb29ed23e2656c504eb8b79462c17d` | `409db3a66d26434cd5a761ec7046102eb5d86456` | identical | Review fixes: trapCause gated on a trap halt, raw-hook state is not resumable, descriptor checks, docs |
| `caf2d489bccd2fc1a99dc0e4f9ae787abd18fe45` | `b480058c25e692720cfcb836fd4006160eb86d2b` | identical | 6502 (NMOS): full core, vector adapter with bus-write comparison, mutants, world tests, benchmark |
| `93eb02f3da6bca7024b890a40229dfba76fe4617` | `29636647ae0aeb188f81d08f53c3386286923000` | identical | Contract decisions 1-5: firstPushAt, trapCause, no silent stack/budget, core params, resumable runs |
| `496d8d2c236da58fae1d303215f03ced1ccbcba0` | `95eb6467d850bd182d2aa049d47c021067471a42` | identical | Record 0.2.0 outputs for the compat '0.2' test (design §5.5) |
| `de3f24ef14597f951721b1d93d41df564040fa2d` | `dc454a16f53315c03c5262737a282cf9ffdb2d22` | identical | Architecture: decide the six open questions (stack meaning, trap cause, no silent defaults, core params, step base, anchors) |
| `0bcf076c1387f2d43be6586a461122d6631a2241` | `bfd0358f28c7778e240e64654203b4bb2a353594` | identical | Full Z80 SingleStepTests baseline for the 0.2.0 core: 1,604,384 tests, all explained |
| `c743212adca73e64939297f8562474647d95ec8a` | `bec009b6ce33683494052e1851b1c3604b333c80` | identical | Merge m1/architecture: IsaCore contract, shared world spec (memory models, hooks, halting, traces, budgets), batch engine, manifests, 6502/BFF skeletons; Z80 0.2 output byte-identical |
| `3e615d2029a7848c2a97a66221f1f63a729bf331` | `3e615d2029a7848c2a97a66221f1f63a729bf331` | identical | Fix the review findings: read snapshots, 0.2 lifecycle, on_reset order, staging limits |
| `4509861a4b0d6e2e8fb58b6466d6486dd6938cd5` | `800945d98d48086416144ce0a208e2f845abc364` | identical | Merge m1/test-infra: headless wgpu-py harness, generic per-instruction vector runner, Z80 adapter, 0.2.0 baseline (partial) |
| `a80e136bfe446a208b82832182207e6b8412f5be` | `a80e136bfe446a208b82832182207e6b8412f5be` | identical | Export machines for other hosts; keep skeleton cores out of the tarball |
| `3f421520273b22b3f89e112ca1618ea734338fd5` | `0700103da1265f8ca9e005be2b374be1154d0f4f` | identical | test: skip files emptied by --test; count only files that ran |
| `054bfdd4ebb609b8b22aa93db6fd81545cbbdd47` | `5e119e331f131a990f91d2ad64834c429c275a92` | identical | test: Z80 per-instruction baseline for Zilion 0.2.0 (partial: base 00-CA) |
| `5ab12989af0f008f5baa1444bb90cf1e088d9cb2` | `5ab12989af0f008f5baa1444bb90cf1e088d9cb2` | identical | test: restore the self-test's rule cases, dropped by cd0b6ee |
| `3e943496cc27f59e6d1c8f75214ea4a0c4764cbf` | `3e943496cc27f59e6d1c8f75214ea4a0c4764cbf` | identical | Engine: serialise concurrent runs on one instance |
| `cd0b6ee277a851202baeb2031d2a6ca5b1eeb9b8` | `cd0b6ee277a851202baeb2031d2a6ca5b1eeb9b8` | identical | test: ledger hash independent of the git commit; --core override; table fix |
| `03984362df9027bb40d48fa3ebe603dc35145b5b` | `03984362df9027bb40d48fa3ebe603dc35145b5b` | identical | Docs: ARCHITECTURE.md, ADDING_A_CORE.md, README and CHANGELOG for 0.3.0-dev |
| `2afd528d44c6821bc7768d6c6870bcbf8a07695f` | `2afd528d44c6821bc7768d6c6870bcbf8a07695f` | identical | test: pinned, verified vector fetch script (not run) |
| `d75f987d389e7f61521bd0a1ba6e31ca751fac56` | `d75f987d389e7f61521bd0a1ba6e31ca751fac56` | identical | Contract validation: 6502 (NMOS) and BFF skeleton cores |
| `7f4432cc71b5050c49ff5565b8e25e356da9d158` | `7f4432cc71b5050c49ff5565b8e25e356da9d158` | identical | Batch engine (L2): chunking, resident batches, typed results, compile errors |
| `034448f84218925e6d2276bb52611f79b4e66d8b` | `034448f84218925e6d2276bb52611f79b4e66d8b` | identical | test: model-checked block-repeat rules; LDIR rule case in the self-test |
| `c37bbff2b3871274fef06e3c8e7b3a04c4cdc530` | `c37bbff2b3871274fef06e3c8e7b3a04c4cdc530` | identical | World tests: io hook port semantics and ZIL_SKIP |
| `bcd6c0be484cb133311f50fda4af14cca63d5641` | `bcd6c0be484cb133311f50fda4af14cca63d5641` | identical | test: model-checked I/O rules, per-field rule masks |
| `3ff2e2c0d022eeaa64dcfdfd6a10f0623e6fce97` | `3ff2e2c0d022eeaa64dcfdfd6a10f0623e6fce97` | identical | World spec (L1) and buildMachine: one world for every ISA |
| `970d5e34fd8e480c1855f321383ba3c3204d2600` | `970d5e34fd8e480c1855f321383ba3c3204d2600` | identical | docs: TESTING.md for the headless harness and the vector runner |
| `b2415a7f42e87b6078b48cb4fefbf4ec32cc0e66` | `b2415a7f42e87b6078b48cb4fefbf4ec32cc0e66` | identical | test: generic per-instruction vector runner, divergence ledger, Z80 adapter |
| `0198508940cb119d3b484821798790f2c48726fe` | `0198508940cb119d3b484821798790f2c48726fe` | identical | test: headless harness on wgpu-py; port test/conformance.js |
| `94167b707c2d96d1233c61fd3dd5049282dde62d` | `94167b707c2d96d1233c61fd3dd5049282dde62d` | identical | Restructure: the Z80 becomes one core behind the IsaCore contract |
