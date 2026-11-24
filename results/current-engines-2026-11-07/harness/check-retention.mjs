import { fixture, workloads } from "../../aot-showcase-2026-10-25/harness/bundles/fixtures.mjs";
import { startWorker } from "../../aot-showcase-2026-10-25/harness/smoke.mjs";
import { parameterSequence } from "./campaign.mjs";

const bars = 65536;
const { input } = fixture("periodic", bars, 934);
const trials = parameterSequence("periodic", bars, 30);
const worker = startWorker("aot-main");
const result = [];
try {
  await worker.next();
  const prepared = await worker.request({
    action: "prepare", input: { ...input, nativeReport: "full", inputs: trials[0] },
  });
  if (!prepared.ok) throw new Error(prepared.error);
  for (const index of [13, 25, 27]) {
    const response = await worker.request({ action: "execute", inputs: trials[index] });
    if (!response.ok) throw new Error(response.error);
    const { trades, raw, equity } = response.output.strategy;
    const reference = workloads.periodic.oracle(input.data, trials[index]).strategy.metrics;
    const row = {
      index, inputs: trials[index], retainedTrades: trades.length,
      firstRetainedTradeIndex: raw.firstRetainedTradeIndex,
      wholeRunClosedTrades: raw.closedTrades, expectedClosedTrades: reference.closedTrades,
      barCloseEquityMatches: equity.at(-1) === reference.finalEquity,
    };
    if (row.firstRetainedTradeIndex <= 0 || row.wholeRunClosedTrades !== row.expectedClosedTrades
      || !row.barCloseEquityMatches) throw new Error(JSON.stringify(row));
    result.push(row);
  }
} finally {
  worker.close();
}
console.log(JSON.stringify(result, null, 2));
