import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);

var Unsupported = class extends Error {
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

// Bar rows for the in-memory market data provider.
function barRows(data) {
  return data.close.map((close, i) => ({
    time: data.time[i],
    openTime: data.time[i],
    closeTime: data.time[i] + 864e5 - 1,
    open: data.open[i],
    high: data.high[i],
    low: data.low[i],
    close,
    volume: data.volume[i]
  }));
}

// Plot normalization for PineTS output.
var visualStyles = /* @__PURE__ */ new Set([
  "background",
  "barcolor",
  "shape",
  "char",
  "bar",
  "candle",
  "fill",
  "label",
  "drawing_line",
  "drawing_box",
  "linefill",
  "drawing_polyline",
  "table"
]);
function normalizePineTSPlots(raw) {
  const plots = [];
  const unrenderedVisuals = [];
  for (const [key, plot] of Object.entries(raw)) {
    const title = plot.title ?? key;
    const style = plot.options?.style;
    if (style && visualStyles.has(style)) {
      unrenderedVisuals.push({ title, style });
      continue;
    }
    try {
      plots.push({ title, values: values(plot.data.map((r) => r.value)) });
    } catch (error) {
      throw new Error(
        `Plot '${title}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { plots, unrenderedVisuals };
}

// PineTS adapter: prepare and execute.
function createAdapter(runtime, compatibility = false) {
  const { PineTS, Indicator } = runtime;
  const datasets = /* @__PURE__ */ new WeakMap();
  function providerRows(input) {
    return barRows(input.data).map((bar) => ({
      ...bar,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      ignore: 0
    }));
  }
  async function prepare(input, m) {
    const prepared = await m.phase(
      "Source + generated-JS compilation",
      () => {
        const indicator = Indicator.from(input.source);
        validateOverrides(
          input.inputs,
          indicator.getInputsMeta().map((d) => ({
            title: d.title ?? "",
            kind: d.type,
            min: d.minval,
            max: d.maxval,
            options: d.options
          }))
        );
        return {
          ...indicator.prepare({ debug: false }),
          inputSchema: indicator.getInputsMeta().map((d) => ({
            title: d.title ?? "",
            kind: d.type,
            min: d.minval,
            max: d.maxval,
            options: d.options
          }))
        };
      },
      "Indicator.prepare; compilation stages combined. Lazy JIT may occur during execution."
    );
    if (input.residentData) {
      const rows = await m.phase(
        "Resident provider rows",
        () => providerRows(input)
      );
      rows.forEach(Object.freeze);
      Object.freeze(rows);
      datasets.set(prepared, { data: input.data, rows });
    }
    return prepared;
  }
  async function execute(prepared, input, m) {
    validateOverrides(input.inputs, prepared.inputSchema);
    const dataset = datasets.get(prepared);
    if (dataset && dataset.data !== input.data)
      throw new Error("Start a new campaign when replacing resident data");
    const rows = dataset?.rows ?? await m.phase("Input conversion", () => providerRows(input));
    const instance = await m.phase(
      "Fresh runtime initialization",
      () => new PineTS(
        {
          async getMarketData(symbol, timeframe) {
            if (symbol !== input.dataset.symbol || !["1D", "D"].includes(timeframe))
              throw new Error(
                "Only the selected local daily dataset is available"
              );
            return rows;
          },
          async getSymbolInfo() {
            return {
              tickerid: input.dataset.symbol,
              main_tickerid: input.dataset.symbol,
              ticker: input.dataset.symbol.split(":").at(-1),
              prefix: input.dataset.symbol.split(":")[0],
              mintick: input.dataset.mintick,
              mincontract: input.dataset.mincontract,
              pricescale: 1 / input.dataset.mintick,
              minmove: 1,
              pointvalue: 1,
              timezone: input.dataset.timezone
            };
          },
          configure() {
          }
        },
        input.dataset.symbol,
        "1D",
        rows.length
      )
    );
    const equity = [];
    const observed = compatibility ? prepared.fn : Object.assign(async (context) => {
      const value = await prepared.fn(context);
      if (context.strategy) equity.push(finite(context.strategy.equity));
      return value;
    }, prepared.fn);
    const result = await m.phase(
      compatibility ? "Execution" : "Execution + equity sampling",
      () => instance.runPretranspiled(observed, input.inputs, rows.length)
    );
    return m.phase("Output conversion", () => ({
      bars: result.marketData.length,
      ...normalizePineTSPlots(result.plots),
      strategy: result.strategy ? {
        available: true,
        trades: result.strategy.closedtrades.map((t) => {
          if (t.exit_price == null || t.exit_bar_index == null)
            throw new Error("PineTS closed trade is missing its exit");
          return {
            entryId: t.entry_id,
            direction: Math.sign(t.size),
            quantity: Math.abs(t.size),
            entryBar: t.entry_bar_index,
            exitBar: t.exit_bar_index,
            entryPrice: t.entry_price,
            exitPrice: t.exit_price,
            profit: finite(t.profit),
            commission: finite(t.commission)
          };
        }),
        equity: values(
          compatibility ? result.strategy.compatEquityCurve ?? equity : equity
        ),
        metrics: commonStrategyMetrics(
          result.strategy.initial_capital,
          result.strategy.closedtrades.map((t) => ({
            profit: finite(t.profit),
            commission: finite(t.commission)
          })),
          values(
            compatibility ? result.strategy.compatEquityCurve ?? equity : equity
          ),
          result.strategy.position_size
        ),
        raw: nativeReport(input, () => jsonSafe(result.strategy)),
        notes: [
          compatibility ? "Compatibility build: native fills, commissions and bar-close equity. Common metrics use closed-trade net profit and bar-close drawdown; original native reports are kept in raw output." : "Native PineTS closed trades and metrics; equity sampled from the script context after each script bar. No simulated fills or forced final liquidation. PineTS fills process_orders_on_close=true orders on the next bar, and its capital and margin checks can reject orders that PineWASM fills. Quantity uses six-decimal truncation. These native differences can change trades, equity and position-dependent plots."
        ]
      } : noStrategy("Indicator source; no strategy broker comparison."),
      diagnostics: diagnostics(result.warnings),
      notes: [
        "Fresh PineTS runtime; prepared function reused only on the prepared path.",
        "Local in-memory provider uses the selected dataset, symbol, tick size and timezone; no network data is fetched.",
        "Numeric plots and native broker output. Color masks, markers and drawing outputs are classified by PineTS style and listed separately as unrendered visuals; boolean masks are not price values."
      ],
      artifact: {
        package: "pinets",
        version: "0.9.33",
        backend: "Indicator.prepare/runPretranspiled"
      }
    }));
  }
  return { prepare, execute };
}
export {
  createAdapter
};
