# Pine Script® engine benchmark refresh, 7 November 2026

This run compares PineWASM 21.1.0, PineTS 0.13.1, PineForge 1.10.0 and
PyneCore 6.12.1 on four synthetic strategies. The strategies, the shared price
data and a hand-written expected-value model are in this repository. All four
engines get the same parameter sets, drawn from one seed. The run uses 4,096
bars and five 500-trial repetitions per workload. Timings are local
measurements on one Apple M5 Max.

## Verify the published figures

From the repository root, with Node.js 22 or newer, run:

```sh
node bench.mjs verify
```

This works offline with the committed files. It verifies the file hashes,
regenerates the expected data, rechecks the stored outputs and recomputes the
timing ratios.

## Prepared-run results

| Workload | Speedup vs PineTS | Speedup vs PineForge | Speedup vs PyneCore |
| --- | ---: | ---: | ---: |
| Momentum | 12.6× | 7.5× | 18.0× |
| Periodic | 18.5× | 15.4× | 23.6× |
| Weighted | 12.4× | 1.7× | 23.1× |
| Window | 15.6× | 4.7× | 19.8× |
| **Geometric mean** | **14.6×** | **5.5×** | **21.0×** |

All 80 campaigns passed, with 40,000 timed metric sets and 160 detailed output checks.
The one-minute load average ranged from 10.9 to 26.4 at campaign starts. [Summary](data/campaign-summary.json) ·
[All measured trials](data/campaign.json.gz)

## PineTS end-to-end replay

The end-to-end replay uses the four synthetic scripts, the same price data,
parameter sequence and timer as the four-engine campaign, with PineWASM 21.1.0 and
PineTS 0.13.1. The timer starts before the worker
process launches and stops after the 500th result arrives, before correctness
checking. All 40 campaigns passed 20,000 metric checks and 80 output checks.

| Workload | End-to-end speedup | Worker-time speedup |
| --- | ---: | ---: |
| Periodic | 16.3× | 18.3× |
| Window | 13.8× | 15.3× |
| Weighted | 11.9× | 12.8× |
| Momentum | 12.0× | 13.2× |
| **Geometric mean** | **13.4×** | **14.7×** |

Across the sweeps, PineTS's median elapsed time was 21.3 seconds in one session
and 15.3 seconds in another. These timings come from separate sessions.
[Rerun summary](data/pinets-cold-summary.json) · [Rerun samples](data/pinets-cold.json.gz)

## What each engine runs

| Engine | Entry point |
| --- | --- |
| PineWASM 21.1.0 | Pine Script® source compiled to an import-free strategy module by PineWASM 21.1.0. |
| PineTS 0.13.1 | The same Pine source through the npm package's prepared indicator API. The adapter starts a fresh runtime per trial. |
| PineForge 1.10.0 | First-party C++ harness that calls the source adapter, broker, and technical-analysis functions of PineForge 1.10.0 at `59f98ba80e69a624f97ada11935e1bc973fd0e19`. |
| PyneCore 6.12.1 | First-party Pyne ports through the local `ScriptRunner` and the CPython 3.12 ARM64 wheel. Each trial instantiates a fresh runner. |

PyneCore was the highest-star additional backtesting runtime found in the GitHub search on
7 November 2026. Among the three compared repositories, PineTS had 934 stars, PyneCore had
263, and PineForge had 205. [PineTS](https://github.com/LuxAlgo/PineTS) ·
[PyneCore](https://github.com/PyneSys/pynecore) · [PineForge](https://github.com/pineforge-4pass/pineforge-engine)

PineForge and PyneCore execute equivalent local ports. The comparison covers prepared backtests
and uses the Apache-licensed PineForge engine and PyneCore runtime. The source translation and
native build stages sit outside the timer for every engine. [PineForge source adapter](https://github.com/pineforge-4pass/pineforge-engine/tree/v1.10.0/include/pineforge/source) ·
[PyneCore runner](https://pynecore.org/docs/programmatic/script-runner/)

## Measurement and correctness

- Each engine runs alone in a fresh worker per workload and repetition. Worker order is
  deterministically shuffled within each repetition. Each receives the same immutable price
  history and the same input overrides in the same order.
- The worker timer includes fresh strategy state, the backtest, and normalization of full
  plot series, closed trades, equity, and common metrics. It excludes process launch, initial
  preparation, transport, and correctness comparison. Per-trial runner construction and
  lazy optimization that occur during evaluation are part of the timed API path.
- The timed payload consists of nine common metrics computed from native results. The
  synthetic expected-value model checks every metric in every trial. The first and last
  parameter sets also undergo full plot, trade, equity, and metric checks on every repetition.
  The first repetition's normalized outputs are stored so the detailed check can be rerun.
- The stored PineTS output files show version 0.9.33 in `output.artifact.version`
  because the adapter writes that fixed string. The runs used PineTS 0.13.1, as
  pinned in `harness/npm/package-lock.json` and stored in the `pinets` field of the
  campaign and long-history results.
- Each stored PineForge output file is byte-identical to the matching PyneCore file.
  Both ports returned identical normalized outputs, which the same Node harness code
  serializes and compresses.
- Per-workload speedup is the median of the five paired ratios of summed trial times
  (baseline divided by PineWASM). The aggregate is the geometric mean of those medians.
  A workload must pass for every engine on every repetition to enter that aggregate.

The workload set uses synthetic bars and fixed one-unit, bar-close orders. It covers
repeated backtests on those four strategies. Treat magnified intrabar execution, other
script families, source compilation, and time to first result as separate measurements.

## PineForge strategy set

PineWASM and PineForge also ran the 100 strategies of PineForge's own benchmark
set on its ETHUSDT 15-minute feed, from benchmark-assets revision `5759bf2`. A
strategy is timed only when both engines produce exactly the same closed trades
and equity. 22 of the 100 strategies met that test. On those 22, PineWASM was
**7.2×** faster than PineForge (geometric mean of per-strategy median times,
20 measured runs each). Of the other 78, PineWASM 21.1.0 could not run 42
(mostly unsupported strategy features) and produced different trades or equity
on 36. Those 78 are not timed. [All strategy results](data/corpus.json.gz)

## Longer histories

The window and periodic workloads also ran on a 65,536-bar feed, with the
same first 30 parameter sets for every engine. The window workload passed all five
repetitions and measured **14.5× vs PineTS**, **4.5× vs PineForge**, and **17.1× vs PyneCore**.

Three periodic parameter sets exceeded PineWASM's 9,000-order retention window in each
repetition. The ledger therefore produces different trade-derived totals.
The whole-run closed-trade counts still matched the expected values in a separate untimed
check. The periodic workload is excluded from long-history timing ratios.
[Long-history summary](data/long-summary.json) · [Retention check](data/retention.json)

## Rerun from source

The rerun commands build the measured PineWASM 21.1.0 from source revision
`20d6304`. That revision is not in the public PineWASM repository, so these
commands need a PineWASM checkout that contains it. Without one, only `verify`
runs; the other commands stop with a fetch error.

From the repository root on macOS, start with a short run.

```sh
node bench.mjs smoke
```

The launcher fetches the pinned sources, checks dependency hashes, builds the
engines in a fresh workspace, and prints the paths to the raw results and summary.
Pass `--pinewasm-source /path/to/PineWASM` to fetch the pinned PineWASM revision
from a local checkout instead of GitHub.

For the four-engine run, install Node.js 22 or newer, Git, Rustup (which provides
`cargo`), npm, CPython 3.12 as `python3.12`, CMake, Ninja, curl, tar, and a C++17
compiler. The launcher uses macOS's per-user
temporary directory by default. On Linux, pass `--scratch-root /path/to/trusted/build-root`
using an existing directory with trusted ancestors and no inherited Cargo configuration.
Keep a few gigabytes free for the builds. The measurement host was an Apple M5 Max running
macOS 26.6.2, Node.js 22.22.3, CPython 3.12.0, and Apple Clang 21.0.0.

| Command | What it runs |
| --- | --- |
| `node bench.mjs campaign` | Four engines, four workloads, five 500-trial repetitions after a smoke check |
| `node bench.mjs long` | The 65,536-bar run. Exit status 2 preserves qualification failures in the output |
| `node bench.mjs pinets` | The two-engine end-to-end replay using the campaign's parameter sequence |
| `node bench.mjs corpus` | The PineWASM and PineForge run on PineForge's 100-strategy set |

The `pinets` command uses Git, Rustup, and npm. Times will vary with machine load and hardware.
Run `node bench.mjs --help` for options.

The repository contains first-party fixture sources and adapters under AGPL-3.0-only.
It references the other engines at their own distribution points.

TradingView® and Pine Script® are trademarks of TradingView, Inc. PineWASM and these benchmarks are independent AI Edge LLC projects and are not affiliated with, authorized by, sponsored by, or endorsed by TradingView, Inc.
