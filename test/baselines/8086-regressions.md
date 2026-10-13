# Existing-ledger regression gate

All four full canonical ledgers reproduce exactly after adding the Intel adapter.

| ISA configuration | SHA-256 |
|---|---|
| z80 | `e2c76b5c9371987add06b2d5ef5b9d7ce9aab436369275f94ab490386e0c9f1f` |
| nmos | `e1317ee63fcece21fb9485b65471f2ea80e9ca8e874b3c598ac0fbe4bb84a096` |
| 02 | `ba15462725903d54d28d6f07677e2a972d605d4ea9bc7bedd277d96f7546e877` |
| 6502 | `5ca3f2b4b3726d5bad30f686c840d623f7c9d88db2a5ede759ace5b59d576f84` |

The 6502 JSON also matches the committed baseline byte for byte. Z80 configs
match the registered prefixes and their reported full ledger hashes. Vector roots
and analytic directories match the original baselines; no filters were used.

All required suites pass: npm test, test:algocell, test:conformance, test:harness
(including eight Intel mutants), and check:bytes against git v0.2.0 and the
installed 0.2.0 package. Intel world probes are additional to these old ledgers.
