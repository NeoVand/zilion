# M4 architectural-core throughput

262,144 lanes, random 32-byte pair rings, seed 20261010, budget 128 world steps,
median of five warm dispatches. The timing includes restoring pristine memory,
excludes bulk uploads/readbacks (a 16-byte queue fence is included), and counts
steps actually executed (an Intel REP iteration is one step). Every
short GPU configuration was followed by an equal pause. Apple M4, Metal.
Measured source: `0586025`; architectural vector-core SHA-256
`979f0ae19c6ea6d69d5cf7949ce27dcbfbeb5f7824d4fe64b6643c7048597b12`.

| Core | ms/dispatch | million executed steps/s | mean steps | halted share |
|---|---:|---:|---:|---:|
| Z80, compat 0.3 classic, native HALT | 28.96 | 1091.4 | 120.6 | 0.067 |
| NMOS 6502, native JAM | 15.32 | 860.4 | 50.3 | 0.736 |
| NMOS 6502, JAM ignored | 20.98 | 1599.7 | 128.0 | 0.000 |
| 8086 coherent fetch (formerly `none`) | 89.48 | 333.7 | 113.9 | 0.144 |

The 8086 is now experimental under the coherent-fetch paper abstraction; queued
timing is excluded and hidden-state forms use the declared zero-ea policy. These timings do not describe a cycle-accurate
8088 implementation. Different halt rates make lane throughput less comparable
than executed-step throughput. The 8086 ran at 31% of the Z80's executed-step rate,
and 39% of the 6502's native-JAM rate for these inputs. The small warm workload is
a local pilot, not a large-soup performance claim.

Reproduce with:

```
ZILION_PYTHON=../algocell/experiments/.venv/bin/python \
node test/bench/bench-cores.mjs --lanes 262144 --reps 5 --budgets 128 --json test/baselines/8086-throughput.json
```

The JSON records unrounded timing and each configuration.
