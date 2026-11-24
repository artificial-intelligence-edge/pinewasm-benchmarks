import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);

// Deterministic fixtures for the benchmark harness.
import { readFileSync } from "node:fs";

// Deterministic synthetic daily bars from a linear congruential generator.
function syntheticData(bars = 1024, seed = 934) {
  if (!Number.isInteger(bars) || bars < 4 || bars > 1e5)
    throw new Error("Invalid bar count");
  const data = {
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    time: []
  };
  let state = seed >>> 0, close2 = 100;
  for (let i = 0; i < bars; i++) {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    const open = close2;
    close2 = Math.max(10, open + ((state >>> 24) - 127) / 256);
    data.open.push(open);
    data.high.push(Math.max(open, close2) + 0.5);
    data.low.push(Math.min(open, close2) - 0.5);
    data.close.push(close2);
    data.volume.push(100 + (state & 255));
    data.time.push(16409952e5 + i * 864e5);
  }
  return data;
}

// Expected-value model for the periodic workload.
function periodicOracle(data, inputs) {
  const period = Number(inputs.Period), length = Number(inputs.Length), threshold = Number(inputs.Threshold);
  const trades = [], equity = [], positions = [];
  let entry, net = 0, grossProfit = 0, grossLoss = 0, peak = 1e4, drawdown = 0;
  for (let bar = 0; bar < data.close.length; bar++) {
    positions.push(entry === void 0 ? 0 : 1);
    if (bar % period === 0) entry = bar;
    if (bar % period === 2 && entry !== void 0) {
      const profit = data.close[bar] - data.close[entry];
      trades.push({
        entryId: "L",
        direction: 1,
        quantity: 1,
        entryBar: entry,
        exitBar: bar,
        entryPrice: data.close[entry],
        exitPrice: data.close[bar],
        profit,
        commission: 0
      });
      net += profit;
      grossProfit += Math.max(0, profit);
      grossLoss += Math.max(0, -profit);
      entry = void 0;
    }
    const value = 1e4 + net + (entry === void 0 ? 0 : data.close[bar] - data.close[entry]);
    equity.push(value);
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, peak - value);
  }
  return {
    bars: data.close.length,
    plots: [
      {
        title: "SMA",
        values: data.close.map(
          (_, bar) => bar + 1 < length ? null : data.close.slice(bar + 1 - length, bar + 1).reduce((sum, v) => sum + v, 0) / length
        )
      },
      { title: "Offset", values: data.close.map((v) => v + threshold) },
      { title: "Position", values: positions }
    ],
    strategy: {
      available: true,
      trades,
      equity,
      raw: null,
      notes: ["Synthetic fixture accounting"],
      metrics: {
        initialCapital: 1e4,
        netProfit: net,
        grossProfit,
        grossLoss,
        closedTrades: trades.length,
        totalCommission: 0,
        finalEquity: equity.at(-1),
        positionSize: entry === void 0 ? 0 : 1,
        maxDrawdown: drawdown
      }
    }
  };
}

// Expected-value model for the window workload.
function windowOracle(data, inputs) {
  const average = (length) => data.close.map(
    (_, bar) => bar + 1 < length ? null : data.close.slice(bar + 1 - length, bar + 1).reduce((sum, value) => sum + value, 0) / length
  );
  const fast = average(Number(inputs.Length)), slow = average(Number(inputs.Period)), threshold = Number(inputs.Threshold);
  const trades = [], equity = [], positions = [];
  let entry, net = 0, grossProfit = 0, grossLoss = 0, peak = 1e4, drawdown = 0;
  for (let bar = 0; bar < data.close.length; bar++) {
    positions.push(entry === void 0 ? 0 : 1);
    const f = fast[bar], s = slow[bar], close2 = data.close[bar];
    if (f !== null && s !== null && close2 > f + threshold && f >= s) {
      if (entry === void 0) entry = bar;
    } else if (f !== null && close2 < f - threshold && entry !== void 0) {
      const profit = close2 - data.close[entry];
      trades.push({
        entryId: "L",
        direction: 1,
        quantity: 1,
        entryBar: entry,
        exitBar: bar,
        entryPrice: data.close[entry],
        exitPrice: close2,
        profit,
        commission: 0
      });
      net += profit;
      grossProfit += Math.max(0, profit);
      grossLoss += Math.max(0, -profit);
      entry = void 0;
    }
    const value = 1e4 + net + (entry === void 0 ? 0 : close2 - data.close[entry]);
    equity.push(value);
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, peak - value);
  }
  return {
    bars: data.close.length,
    plots: [
      { title: "Fast", values: fast },
      { title: "Slow", values: slow },
      { title: "Position", values: positions }
    ],
    strategy: {
      available: true,
      trades,
      equity,
      raw: null,
      notes: ["Window fixture accounting"],
      metrics: {
        initialCapital: 1e4,
        netProfit: net,
        grossProfit,
        grossLoss,
        closedTrades: trades.length,
        totalCommission: 0,
        finalEquity: equity.at(-1),
        positionSize: entry === void 0 ? 0 : 1,
        maxDrawdown: drawdown
      }
    }
  };
}

// Expected-value model for the weighted and momentum workloads.
function extendedOracle(data, inputs, kind) {
  const length = Number(inputs.Length), period = Number(inputs.Period), threshold = Number(inputs.Threshold);
  const mean = (bar, n, weighted) => {
    if (bar + 1 < n) return null;
    let sum = 0;
    for (let i = 0; i < n; i++)
      sum += data.close[bar - n + 1 + i] * (weighted ? i + 1 : 1);
    return sum / (weighted ? n * (n + 1) / 2 : n);
  };
  const fast = data.close.map(
    (c, i) => kind === "weighted" ? mean(i, length, true) : i < length ? null : c - data.close[i - length]
  );
  const slow = data.close.map((_, i) => mean(i, period, kind === "weighted"));
  const positions = [], equity = [], trades = [];
  let entry, net = 0, grossProfit = 0, grossLoss = 0, peak = 1e4, maxDrawdown = 0;
  for (let i = 0; i < data.close.length; i++) {
    positions.push(entry === void 0 ? 0 : 1);
    const f = fast[i], s = slow[i], c = data.close[i];
    const buy = f !== null && s !== null && (kind === "weighted" ? f > s + threshold : f > threshold && c > s);
    const sell = f !== null && (kind === "weighted" ? s !== null && f < s - threshold : f < -threshold);
    if (buy && entry === void 0) entry = i;
    else if (!buy && sell && entry !== void 0) {
      const profit = c - data.close[entry];
      trades.push({
        entryId: "L",
        direction: 1,
        quantity: 1,
        entryBar: entry,
        exitBar: i,
        entryPrice: data.close[entry],
        exitPrice: c,
        profit,
        commission: 0
      });
      net += profit;
      grossProfit += Math.max(0, profit);
      grossLoss += Math.max(0, -profit);
      entry = void 0;
    }
    const value = 1e4 + net + (entry === void 0 ? 0 : c - data.close[entry]);
    equity.push(value);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }
  return {
    bars: data.close.length,
    plots: [
      { title: "Fast", values: fast },
      { title: "Slow", values: slow },
      { title: "Position", values: positions }
    ],
    strategy: {
      available: true,
      trades,
      equity,
      raw: null,
      notes: ["Direct-window fixture specification"],
      metrics: {
        initialCapital: 1e4,
        netProfit: net,
        grossProfit,
        grossLoss,
        closedTrades: trades.length,
        totalCommission: 0,
        finalEquity: equity.at(-1),
        positionSize: entry === void 0 ? 0 : 1,
        maxDrawdown
      }
    }
  };
}
var weightedOracle = (data, inputs) => extendedOracle(data, inputs, "weighted");
var momentumOracle = (data, inputs) => extendedOracle(data, inputs, "momentum");

// Workload definitions: Pine source file and expected-value model.
var workloads = {
  weighted: {
    file: "benchmarks/workloads/weighted-strategy.pine",
    oracle: weightedOracle
  },
  momentum: {
    file: "benchmarks/workloads/momentum-strategy.pine",
    oracle: momentumOracle
  },
  periodic: {
    file: "benchmarks/workloads/periodic-strategy.pine",
    oracle: periodicOracle
  },
  window: {
    file: "benchmarks/workloads/window-strategy.pine",
    oracle: windowOracle
  }
};

// Shared helpers for strategy metrics.
var finite = (x) => typeof x === "number" && Number.isFinite(x) ? x : null;
function commonStrategyMetrics(initialCapital, trades, equity, positionSize) {
  let grossProfit = 0, grossLoss = 0, netProfit = 0, commission = 0;
  for (const trade of trades) {
    if (trade.profit === null)
      throw new Error("Closed trade lacks a finite profit");
    netProfit += trade.profit;
    grossProfit += Math.max(0, trade.profit);
    grossLoss += Math.max(0, -trade.profit);
    commission += trade.commission ?? NaN;
  }
  let peak = initialCapital, maxDrawdown = 0;
  for (const value of equity) {
    if (value === null) throw new Error("Native equity contains a missing bar");
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }
  return {
    initialCapital,
    netProfit,
    grossProfit,
    grossLoss,
    closedTrades: trades.length,
    totalCommission: finite(commission),
    finalEquity: finite(equity.at(-1)),
    positionSize: finite(positionSize),
    maxDrawdown
  };
}

// Comparison of engine output with the expected values.
var unavailable = (detail) => ({
  status: "unavailable",
  detail,
  compared: 0
});
var close = (a, b) => Math.abs(a - b) <= 1e-8 + 1e-8 * Math.max(Math.abs(a), Math.abs(b));
function compareArrays(a, b, label) {
  if (a.length !== b.length)
    return {
      status: "mismatch",
      detail: `${label}: ${a.length} vs ${b.length} values`,
      compared: 0
    };
  let maxAbsError = 0, mismatch = 0, first = -1;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x !== null && y !== null)
      maxAbsError = Math.max(maxAbsError, Math.abs(x - y));
    if (x === null || y === null ? x !== y : !close(x, y)) {
      mismatch++;
      if (first < 0) first = i;
    }
  }
  return {
    status: mismatch ? "mismatch" : "match",
    detail: mismatch ? `${label}: ${mismatch} differences; first bar ${first} (expected ${a[first]}, result ${b[first]})` : `${label}: ${a.length} values agree`,
    compared: a.length,
    maxAbsError
  };
}
function compareOutputs(a, b) {
  const result = {
    plots: unavailable("No plots"),
    trades: unavailable("Broker ledger unavailable"),
    equity: unavailable("Equity unavailable"),
    metrics: unavailable("Strategy metrics unavailable"),
    scope: "Numeric plots, closed-trade fields, bar-close equity and common metrics only."
  };
  const unique = (plots) => new Set(plots.map((p) => p.title)).size === plots.length;
  if (!unique(a.plots) || !unique(b.plots))
    result.plots = unavailable(
      "Duplicate plot titles need an explicit mapping"
    );
  else if (a.plots.length !== b.plots.length)
    result.plots = {
      status: "mismatch",
      detail: `${a.plots.length} vs ${b.plots.length} plot channels`,
      compared: 0
    };
  else if (a.plots.length) {
    const checks = a.plots.map((p) => {
      const q = b.plots.find((q2) => q2.title === p.title);
      return q ? (p.offset ?? 0) !== (q.offset ?? 0) ? {
        status: "mismatch",
        detail: `${p.title}: plot offsets differ`,
        compared: 0
      } : compareArrays(p.values, q.values, p.title) : {
        status: "mismatch",
        detail: `Missing plot '${p.title}'`,
        compared: 0
      };
    });
    result.plotDetails = checks;
    result.plots = checks.find((c) => c.status !== "match") ?? {
      status: "match",
      detail: `${checks.length} numeric plot channels agree`,
      compared: checks.reduce((n, c) => n + c.compared, 0),
      maxAbsError: Math.max(...checks.map((c) => c.maxAbsError ?? 0))
    };
  }
  if (a.strategy.available && b.strategy.available) {
    const x = a.strategy, y = b.strategy;
    if (x.trades && y.trades) {
      let detail = "";
      if (x.trades.length !== y.trades.length)
        detail = `${x.trades.length} vs ${y.trades.length} closed trades`;
      else
        outer: for (let i = 0; i < x.trades.length; i++)
          for (const k of [
            .../* @__PURE__ */ new Set([
              ...Object.keys(x.trades[i]),
              ...Object.keys(y.trades[i])
            ])
          ]) {
            if (!Object.hasOwn(x.trades[i], k) || !Object.hasOwn(y.trades[i], k)) {
              detail = `Trade ${i + 1}, missing or additional field: ${k}`;
              break outer;
            }
            const u = x.trades[i][k], v = y.trades[i][k];
            if (typeof u === "number" && typeof v === "number" ? !Number.isFinite(u) || !Number.isFinite(v) || (k === "quantity" ? Math.abs(u - v) > 1e-8 + 8 * Number.EPSILON * Math.max(Math.abs(u), Math.abs(v)) : ["entryBar", "exitBar", "direction"].includes(k) ? u !== v : !close(u, v)) : u !== v) {
              detail = `Trade ${i + 1}, ${k}: ${u} vs ${v}`;
              break outer;
            }
          }
      result.trades = {
        status: detail ? "mismatch" : "match",
        detail: detail || `${x.trades.length} closed trades agree${x.trades.length === 0 ? " (no trading coverage)" : ""}`,
        compared: Math.min(x.trades.length, y.trades.length)
      };
    }
    if (x.equity && y.equity)
      result.equity = compareArrays(x.equity, y.equity, "Equity");
    const keys = [
      .../* @__PURE__ */ new Set([...Object.keys(x.metrics), ...Object.keys(y.metrics)])
    ].sort();
    if (keys.length) {
      const differs = keys.filter((k) => {
        if (!Object.hasOwn(x.metrics, k) || !Object.hasOwn(y.metrics, k))
          return true;
        const a2 = x.metrics[k], b2 = y.metrics[k];
        if (a2 === null || b2 === null) return a2 !== b2;
        return !Number.isFinite(a2) || !Number.isFinite(b2) || !close(a2, b2);
      });
      result.metrics = {
        status: differs.length ? "mismatch" : "match",
        detail: differs.length ? `Missing or different: ${differs.join(", ")}` : `${keys.length} complete metrics agree, including null states`,
        compared: keys.length
      };
    }
  }
  return result;
}

// Fixture definitions.
var params ={ Period: 20, Length: 10, Threshold: 0 };
function fixture(id, bars = 1024, seed = 934) {
  const data = syntheticData(bars, seed);
  const indicator = (body, plots) => ({ source: '//@version=5\nindicator("Comprehensive ' + id + '")\n' + body + "\n", reference: { bars, plots, strategy: null } });
  let c;
  if (id in workloads) {
    const w = workloads[id];
    c = { source: readFileSync(new URL("../../../../" + w.file, import.meta.url), "utf8"), reference: w.oracle(data, params) };
  }
  const plot = (title, values) => ({ title, values });
  if (id === "arithmetic") c = indicator('plot(close,"Close")\nplot(close-open,"Body")\nplot(close[1],"Previous")', [plot("Close", data.close), plot("Body", data.close.map((x, i) => x - data.open[i])), plot("Previous", data.close.map((_, i) => i ? data.close[i - 1] : null))]);
  if (id === "rolling") c = indicator('plot(ta.sma(close,10),"SMA")\nplot(ta.wma(close,10),"WMA")', [plot("SMA", data.close.map((_, i) => i < 9 ? null : data.close.slice(i - 9, i + 1).reduce((a, b) => a + b, 0) / 10)), plot("WMA", data.close.map((_, i) => i < 9 ? null : data.close.slice(i - 9, i + 1).reduce((a, b, j) => a + b * (j + 1), 0) / 55))]);
  if (id === "state") c = indicator('var float total=0.0\ntotal:=total+close\nplot(total,"Total")\nplot(bar_index,"Index")', [plot("Total", data.close.map((_, i) => data.close.slice(0, i + 1).reduce((a, b) => a + b, 0))), plot("Index", data.close.map((_, i) => i))]);
  if (id === "arrays") c = indicator('a=array.from(close,open,high,low)\nplot(array.sum(a),"Sum")\nplot(array.get(a,0),"First")', [plot("Sum", data.close.map((x, i) => x + data.open[i] + data.high[i] + data.low[i])), plot("First", data.close)]);
  if (id === "nextopen") {
    const trades = [], equity = [], position = [];
    let entry, net = 0;
    for (let i = 0; i < bars; i++) {
      if (i % 20 === 1) entry = i;
      if (i % 20 === 3 && entry !== void 0) {
        const profit = data.open[i] - data.open[entry];
        trades.push({ entryId: "L", direction: 1, quantity: 1, entryBar: entry, exitBar: i, entryPrice: data.open[entry], exitPrice: data.open[i], profit, commission: 0 });
        net += profit;
        entry = void 0;
      }
      position.push(entry === void 0 ? 0 : 1);
      equity.push(1e4 + net + (entry === void 0 ? 0 : data.close[i] - data.open[entry]));
    }
    c = { source: '//@version=6\nstrategy("Next-open schedule",initial_capital=10000,default_qty_type=strategy.fixed,default_qty_value=1)\nif bar_index % 20 == 0\n    strategy.entry("L",strategy.long)\nif bar_index % 20 == 2\n    strategy.close("L")\nplot(close,"Close")\nplot(strategy.position_size,"Position")\n', reference: { bars, plots: [plot("Close", data.close), plot("Position", position)], strategy: { available: true, trades, equity, metrics: commonStrategyMetrics(1e4, trades, equity, position.at(-1) ?? 0) } } };
  }
  if (!c) throw Error("Unknown fixture " + id);
  const d = { id: "synthetic-" + seed, title: "Deterministic daily bars", file: "", sha256: "", rows: bars, symbol: "SYNTHETIC:BENCH", mintick: 1 / 256, mincontract: 1, missingVolume: 0, timeframe: "1D", timezone: "UTC", sourcePath: "benchmarks/synthetic.ts" };
  return { ...c, id, bars, seed, input: { source: c.source, data, inputs: {}, dataset: d, residentData: true, nativeReport: "omit" } };
}
export {
  commonStrategyMetrics,
  compareOutputs,
  fixture,
  params,
  workloads
};
