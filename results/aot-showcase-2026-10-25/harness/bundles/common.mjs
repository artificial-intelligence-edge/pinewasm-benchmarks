import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);

var Unsupported = class extends Error {
};
var Measure = class {
  stages = [];
  async phase(name, operation, detail) {
    const start = performance.now();
    try {
      return await operation();
    } finally {
      this.stages.push({ name, ms: performance.now() - start, detail });
    }
  }
};
var finite = (x) => typeof x === "number" && Number.isFinite(x) ? x : null;
function values(xs) {
  return Array.from(xs, (x) => {
    if (x === Infinity || x === -Infinity)
      throw new Error("Engine emitted an infinite plot value");
    if (x != null && typeof x !== "number")
      throw new Error(`Non-numeric plot value: ${typeof x}`);
    return finite(x);
  });
}
var noStrategy = (note = "No broker result is exposed by this adapter.") => ({
  available: false,
  trades: null,
  equity: null,
  metrics: {},
  raw: null,
  notes: [note]
});
function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(
      value,
      (_key, x) => typeof x === "bigint" ? x.toString() : x
    )
  );
}
function nativeReport(input, materialize) {
  return input.nativeReport === "omit" ? null : materialize();
}
function diagnostics(xs) {
  return Array.isArray(xs) ? xs.map((x) => typeof x === "string" ? x : JSON.stringify(x)) : [];
}
function validateOverrides(inputs, schema) {
  for (const [title, value] of Object.entries(inputs)) {
    const matches = schema.filter((s2) => s2.title === title);
    if (matches.length !== 1)
      throw new Unsupported(
        `Input '${title}' must match exactly one declared input title`
      );
    const s = matches[0], kind = s.kind.toLowerCase();
    if (!["int", "float", "bool", "string"].includes(kind))
      throw new Unsupported(
        `Input type '${kind}' is outside the shared override contract`
      );
    if (kind === "int" || kind === "float" ? typeof value !== "number" || !Number.isFinite(value) || kind === "int" && !Number.isSafeInteger(value) : kind === "bool" ? typeof value !== "boolean" : typeof value !== "string")
      throw new Unsupported(`Input '${title}' requires ${kind}`);
    if (typeof value === "number" && (s.min !== void 0 && value < s.min || s.max !== void 0 && value > s.max))
      throw new Unsupported(`Input '${title}' is outside its declared bounds`);
    if (s.options?.length && !s.options.includes(value))
      throw new Unsupported(`Input '${title}' is outside its declared options`);
  }
}
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
export {
  Measure,
  Unsupported,
  commonStrategyMetrics,
  diagnostics,
  finite,
  jsonSafe,
  nativeReport,
  noStrategy,
  validateOverrides,
  values
};
