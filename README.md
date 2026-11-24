# PineWASM benchmarks

This repository contains the measurements behind PineWASM’s November 7, 2026
benchmark report, the four workload scripts, and the harness used to compare
PineWASM 21.1.0 with PineTS 0.13.1, PineForge 1.10.0, and PyneCore 6.12.1.
AI Edge develops PineWASM and maintains this comparison.

## Verify the results

From the repository root, with Node.js 22 or newer, run:

```sh
node bench.mjs verify
```

Verification works offline with the committed files. It checks the manifest,
regenerates the synthetic reference data, validates the stored outputs, and
recomputes the timing ratios. Repeating the timed runs requires a separate
PineWASM checkout containing revision `20d6304`, the 21.1.0 compiler used
for these measurements. The current PineWASM repository omits that revision.
The [full report](results/current-engines-2026-11-07/README.md#rerun-from-source)
lists the toolchains and shows how to supply that checkout with `--pinewasm-source`.

## Results

Each engine ran five repetitions of 500 prepared backtests per workload on the
same 4,096 synthetic bars and parameter sets. The table reports the geometric
mean of four workload speedups on one Apple M5 Max. Each workload contributes
the median of its five paired time ratios. PineForge and PyneCore used
equivalent local ports. Initial compilation and process startup are outside
this timer.

| Baseline | PineWASM speedup across four workloads | Largest speedup (periodic workload) |
| --- | ---: | ---: |
| PineTS | 14.6× | 18.5× |
| PineForge | 5.5× | 15.4× |
| PyneCore | 21.0× | 23.6× |

- **Startup included.** A separate end-to-end replay measured 13.4× over PineTS across the four workloads.
- **Long histories.** At 65,536 bars, the window workload passed. The periodic workload exceeded PineWASM’s retained-order limit on three parameter sets and was excluded from speedup comparisons.
- **PineForge's strategy set.** On the 22 of PineForge's 100 benchmark strategies where both engines produced identical trades and equity, PineWASM measured 7.2× over PineForge. PineWASM 21.1.0 could not run 42 of the others, and 36 gave different results.

The [license](LICENSE) and [notice](NOTICE) cover the first-party fixtures and harness.

TradingView® and Pine Script® are trademarks of TradingView, Inc. PineWASM and these benchmarks are independent AI Edge LLC projects and are not affiliated with, authorized by, sponsored by, or endorsed by TradingView, Inc.
