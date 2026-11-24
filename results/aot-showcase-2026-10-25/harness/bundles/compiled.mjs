import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);

var Unsupported = class extends Error {
};
var finite = (x) => typeof x === "number" && Number.isFinite(x) ? x : null;
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

var decoder = new TextDecoder();
var littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function decodeStandaloneWasmOutput(bytes) {
  if (decoder.decode(bytes.subarray(0, 8)) !== "PWSWOUT1") {
    const result2 = JSON.parse(decoder.decode(bytes));
    const numeric = (lane2) => Array.isArray(lane2) && lane2.every(
      (x) => x === null || typeof x === "number" && Number.isFinite(x)
    );
    if (!Array.isArray(result2.plots) || !result2.plots.every(numeric) || !numeric(result2.strategy?.equity))
      throw new Error("Invalid numeric JSON results");
    return result2;
  }
  if (bytes.byteLength < 24) throw new Error("Truncated binary result header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const plots = view.getUint32(8, true), bars = view.getUint32(12, true);
  const metadataLength = view.getUint32(16, true);
  const laneStart = Math.ceil((24 + metadataLength) / 8) * 8;
  const end = laneStart + (plots + 1) * bars * 8;
  if (!bars || view.getUint32(20, true) !== 0 || !Number.isSafeInteger(end) || end !== bytes.byteLength)
    throw new Error("Invalid binary result layout");
  const result = JSON.parse(
    decoder.decode(bytes.subarray(24, 24 + metadataLength))
  );
  if (result.version !== 1 || !Array.isArray(result.plots) || result.plots.length || !Array.isArray(result.strategy?.equity) || result.strategy.equity.length)
    throw new Error("Invalid binary result metadata");
  const decoded = (value) => {
    if (value === Infinity || value === -Infinity)
      throw new Error("Compiled WebAssembly emitted an infinite numeric value");
    return Number.isNaN(value) ? null : value;
  };
  const lane = (index) => {
    const start = laneStart + index * bars * 8;
    const result2 = new Array(bars);
    if (littleEndian && (bytes.byteOffset + start) % 8 === 0) {
      const source = new Float64Array(
        bytes.buffer,
        bytes.byteOffset + start,
        bars
      );
      for (let i = 0; i < bars; i++) result2[i] = decoded(source[i]);
    } else {
      for (let i = 0; i < bars; i++) {
        result2[i] = decoded(view.getFloat64(start + i * 8, true));
      }
    }
    return result2;
  };
  result.plots = Array.from({ length: plots }, (_, i) => lane(i));
  result.strategy.equity = lane(plots);
  return result;
}

import { readFileSync as nodeReadFile } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
// Directory of a PineWASM `cargo xtask wasm` package plus its identity.json (see harness README).
const PINEWASM_PKG = () => { if (!process.env.PINEWASM_PKG) throw Error("Set PINEWASM_PKG to a PineWASM package directory"); return process.env.PINEWASM_PKG; };
var api;
var compilerMemory;
var identity;
async function initialize(m) {
  if (api) return;
  await m.phase("Wasm loader + engine initialization", async () => {
    api = await import(pathToFileURL(resolvePath(PINEWASM_PKG(), "pinewasm.js")).href);
    compilerMemory = api.initSync({ module: nodeReadFile(resolvePath(PINEWASM_PKG(), "pinewasm_bg.wasm")) }).memory;
    identity = JSON.parse(nodeReadFile(resolvePath(PINEWASM_PKG(), "identity.json"), "utf8"));
    if (api.version().sourceRevision !== identity.sourceRevision) throw Error("Compiler identity mismatch");
  });
}
function loadedApi() {
  if (!api) throw new Error("PineWASM not initialized");
  return { api, identity };
}
function compilerMemoryBytes() {
  return compilerMemory.buffer.byteLength;
}

// SHA-256 digest of a string or byte buffer, as lowercase hex.
async function hash(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((n) => n.toString(16).padStart(2, "0")).join("");
}

// Compiles the source to a standalone strategy module and checks its imports and metadata.
async function prepare(input, m) {
  await initialize(m);
  const { api: api2, identity: identity2 } = loadedApi();
  const c = await m.phase(
    "Source compilation",
    () => api2.compile(input.source, {
      emitAst: false,
      emitHir: false,
      emitMir: false,
      emitIl: false
    })
  );
  if (!c.success || !c.program)
    throw new Unsupported(diagnostics(c.diagnostics).join("\n"));
  if (!c.program.metadata?.strategy)
    throw new Unsupported(
      "Compiled WebAssembly requires strategy() source. Use the bytecode VM for indicators."
    );
  const artifact = await m.phase(
    "Compiled WebAssembly strategy Wasm emission",
    () => api2.compileStandaloneWasmProgram(c.program, {
      module_type: "strategy",
      signal_plot: null,
      signal_semantics: "posture-events"
    })
  );
  if (!artifact.wasm)
    throw new Unsupported(JSON.stringify(artifact.refused ?? artifact));
  const module = await m.phase(
    "Generated-Wasm compilation + audit",
    () => WebAssembly.compile(artifact.wasm)
  );
  const imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
  if (imports.length)
    throw new Unsupported(
      `Compiled WebAssembly module is not direct: ${JSON.stringify(imports)}`
    );
  const metadataBytes = WebAssembly.Module.customSections(
    module,
    "module_metadata"
  );
  const metadata = metadataBytes[0] ? JSON.parse(new TextDecoder().decode(metadataBytes[0])) : null;
  const capabilityBytes = WebAssembly.Module.customSections(
    module,
    "pinewasm_capabilities"
  )[0];
  const capabilities = capabilityBytes ? JSON.parse(new TextDecoder().decode(capabilityBytes)) : null;
  if (input.residentData && (capabilities?.schema_version !== 1 || !["PWSWBIN2", "PWSWREF1"].every(
    (p) => capabilities.input_protocols?.includes(p)
  )))
    throw new Unsupported(
      "This compiler does not advertise resident dataset inputs"
    );
  if (input.residentData && (!Object.isFrozen(input.data) || !Object.values(input.data).every(Object.isFrozen)))
    throw new Error(
      "Resident data must be immutable and owned by the campaign worker"
    );
  if (metadata?.signal?.source !== "strategy" || metadata?.signal?.semantics !== "posture-events")
    throw new Unsupported("Unexpected Compiled WebAssembly signal metadata");
  const schemaBytes = WebAssembly.Module.customSections(
    module,
    "parameter_schema"
  )[0];
  if (!schemaBytes)
    throw new Error("Compiled WebAssembly parameter schema missing");
  const schema = JSON.parse(new TextDecoder().decode(schemaBytes));
  resolveParams(c.program.inputs, schema, input.inputs);
  const instance = await m.phase(
    "Reusable Wasm instantiation",
    () => WebAssembly.instantiate(module, {})
  );
  const wasm = instance.exports;
  for (const name of [
    "reset",
    "alloc",
    "dealloc",
    "evaluate_indicator_cabi",
    "last_error"
  ])
    if (typeof wasm[name] !== "function")
      throw new Error(`Missing Compiled WebAssembly export ${name}`);
  return {
    wasm,
    residentData: input.residentData ? input.data : void 0,
    residentReady: false,
    poisoned: false,
    uploadedBytes: 0,
    datasetUploads: 0,
    datasetReferences: 0,
    declarations: c.program.inputs,
    schema,
    plotDeclarations: c.program.plots,
    initialCapital: c.program.metadata.strategy.initial_capital,
    identity: {
      ...identity2,
      wasmSha256: await hash(artifact.wasm),
      bytes: artifact.wasm.length,
      imports,
      exports,
      metadata,
      capabilities,
      executionMode: "native-zero-imports",
      profile: "Compiled WebAssembly full native strategy results",
      instancePolicy: input.residentData ? "One immutable dataset upload and persistent instance; fresh broker/series/inputs every trial; reference alloc/write/evaluate/copy/dealloc" : "One persistent instance per prepared artifact; reset and fresh broker each evaluation; binary input alloc/write/evaluate/copy/dealloc"
    },
    diagnostics: diagnostics(c.diagnostics)
  };
}
function resolveParams(declarations, schema, inputs) {
  const untag = (value) => value ? Object.values(value)[0] : void 0;
  validateOverrides(
    inputs,
    declarations.map((d) => ({
      title: d.title ?? "",
      kind: d.kind,
      min: untag(d.constraints.min),
      max: untag(d.constraints.max),
      options: d.constraints.options.map(untag)
    }))
  );
  const params = {};
  for (const [title, value] of Object.entries(inputs)) {
    const fields = schema.filter((field) => field.label === title);
    if (fields.length !== 1)
      throw new Unsupported(
        `Input '${title}' must map to one compiled parameter`
      );
    const decl = declarations.find((d) => d.title === title);
    if (typeof value === "string") {
      const options = decl.constraints.options.map(untag);
      const index = options.indexOf(value);
      if (index < 0)
        throw new Unsupported(`Input '${title}' is not a declared option`);
      params[fields[0].name] = index;
    } else params[fields[0].name] = value;
  }
  return params;
}
function unpack(packed, wasm) {
  const handle = BigInt.asUintN(64, packed), ptr = Number(handle >> 32n), len = Number(handle & 0xffffffffn);
  if (ptr < 0 || len < 0 || ptr + len > wasm.memory.buffer.byteLength)
    throw new Error("Compiled WebAssembly output handle out of bounds");
  return { ptr, len };
}
async function execute(prepared, input, m) {
  return evaluate(prepared, input, m, false);
}
async function executeObjectives(prepared, input, m) {
  if (!(prepared.identity.capabilities?.output_projections ?? []).includes(
    "retained-objectives-v1"
  ))
    throw new Unsupported("Compiler lacks native objective projection");
  return evaluate(prepared, input, m, true);
}
async function evaluate(prepared, input, m, objectives) {
  const { wasm } = prepared;
  if (prepared.poisoned)
    throw new Error("Discard the failed Compiled WebAssembly instance");
  if (prepared.residentData && input.data !== prepared.residentData)
    throw new Error("Start a new campaign when replacing resident data");
  const resident = !!prepared.residentData;
  const reference = resident && prepared.residentReady;
  const bytes = await m.phase("Binary input packing", () => {
    const n = input.data.close.length;
    const metadata = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        params: resolveParams(
          prepared.declarations,
          prepared.schema,
          input.inputs
        ),
        include_results: !objectives,
        binary_results: !objectives,
        objective_results: objectives,
        mintick: input.dataset.mintick,
        mincontract: input.dataset.mincontract ?? 1,
        pointvalue: 1
      })
    );
    const metadataStart = resident ? 24 : 16;
    const laneStart = Math.ceil((metadataStart + metadata.length) / 8) * 8;
    const bytes2 = new Uint8Array(laneStart + (reference ? 0 : n * 48));
    bytes2.set(
      new TextEncoder().encode(
        reference ? "PWSWREF1" : resident ? "PWSWBIN2" : "PWSWBIN1"
      )
    );
    const header = new DataView(bytes2.buffer);
    header.setUint32(8, n, true);
    header.setUint32(12, metadata.length, true);
    if (resident) header.setBigUint64(16, 1n, true);
    bytes2.set(metadata, metadataStart);
    if (!reference)
      ["open", "high", "low", "close", "volume", "time"].forEach((name, i) => {
        const lane = input.data[name];
        if (lane.length !== n) throw new Error("Primary lane length mismatch");
        new Float64Array(bytes2.buffer, laneStart + i * n * 8, n).set(lane);
      });
    return bytes2;
  });
  let inputPtr = 0, outputPtr = 0, outputLen = 0;
  try {
    await m.phase(
      "Instance reset + input memory write",
      () => {
        if (!reference) wasm.reset();
        inputPtr = wasm.alloc(bytes.length) >>> 0;
        if (!inputPtr || inputPtr + bytes.length > wasm.memory.buffer.byteLength)
          throw new Error("Compiled WebAssembly allocation failed");
        new Uint8Array(wasm.memory.buffer, inputPtr, bytes.length).set(bytes);
        prepared.uploadedBytes += bytes.length;
        if (reference) prepared.datasetReferences++;
        else prepared.datasetUploads++;
      },
      "Keeps compiled code and linear-memory pages; resets arena. The exported evaluate function initializes broker/runtime afresh."
    );
    const packed = await m.phase(
      "Direct strategy evaluation + ABI serialization",
      () => wasm.evaluate_indicator_cabi(inputPtr, bytes.length),
      "Compiled WebAssembly validates the versioned binary layout, parses small parameter metadata, copies numeric lanes, executes the native strategy/broker and returns metadata plus owned binary plot/equity lanes."
    );
    if (packed === 0n) {
      const error = unpack(wasm.last_error(), wasm);
      throw new Error(
        new TextDecoder().decode(
          new Uint8Array(wasm.memory.buffer, error.ptr, error.len)
        ) || "Compiled WebAssembly evaluation failed"
      );
    }
    const out = unpack(packed, wasm);
    outputPtr = out.ptr;
    outputLen = out.len;
    if (objectives) {
      const output2 = await m.phase("Compact native objective decoding", () => {
        const decoded = JSON.parse(
          new TextDecoder().decode(
            new Uint8Array(wasm.memory.buffer, outputPtr, outputLen)
          )
        );
        const keys = [
          "initialCapital",
          "netProfit",
          "grossProfit",
          "grossLoss",
          "closedTrades",
          "totalCommission",
          "finalEquity",
          "positionSize",
          "maxDrawdown"
        ];
        if (decoded.version !== 1 || decoded.projection !== "retained-objectives-v1" || decoded.bars !== input.data.close.length || !decoded.metrics || JSON.stringify(Object.keys(decoded.metrics).sort()) !== JSON.stringify(keys.sort()) || !keys.every(
          (key) => typeof decoded.metrics[key] === "number" && Number.isFinite(decoded.metrics[key])
        ) || !Number.isSafeInteger(decoded.firstRetainedTradeIndex) || decoded.firstRetainedTradeIndex < 0)
          throw new Error("Invalid native objective result");
        return {
          bars: decoded.bars,
          metrics: decoded.metrics,
          artifact: {
            ...prepared.identity,
            memoryBytes: wasm.memory.buffer.byteLength,
            compilerMemoryBytes: compilerMemoryBytes(),
            outputBytes: outputLen,
            uploadedBytes: prepared.uploadedBytes,
            datasetUploads: prepared.datasetUploads,
            datasetReferences: prepared.datasetReferences,
            outputProjection: decoded.projection,
            firstRetainedTradeIndex: decoded.firstRetainedTradeIndex
          }
        };
      });
      prepared.residentReady = resident;
      return output2;
    }
    const output = await m.phase("Full binary output copy + conversion", () => {
      const decoded = decodeStandaloneWasmOutput(
        new Uint8Array(wasm.memory.buffer, outputPtr, outputLen)
      );
      if (decoded.version !== 1 || !Array.isArray(decoded.signals))
        throw new Error("Invalid Compiled WebAssembly output schema");
      let index = 0;
      input.data.time.forEach((time, i) => {
        const signal = decoded.signals[index];
        if (signal && signal.time === time) {
          if (![1, 0, -1].includes(signal.direction) || signal.price !== input.data.close[i])
            throw new Error("Invalid posture-event direction/price");
          index++;
        }
      });
      if (index !== decoded.signals.length)
        throw new Error(
          "Compiled WebAssembly signals are not ordered/aligned to the shared data"
        );
      const strategy = decoded.strategy;
      if (!strategy || !Array.isArray(strategy.trades) || !Array.isArray(strategy.equity) || strategy.equity.length !== input.data.close.length || !Array.isArray(decoded.plots) || decoded.plots.length !== prepared.plotDeclarations.length)
        throw new Error(
          "Compiled WebAssembly artifact does not expose complete native results"
        );
      if (decoded.plots.some(
        (plot) => !Array.isArray(plot) || plot.length !== input.data.close.length
      ))
        throw new Error("Compiled WebAssembly plot length mismatch");
      const equity = strategy.equity;
      const trades = strategy.trades.map((t) => ({
        entryId: t.entryId,
        direction: Math.sign(t.sign),
        quantity: Math.abs(t.qty),
        entryBar: t.entryBar,
        exitBar: t.exitBar,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        profit: finite(t.pnl),
        commission: finite(t.commission)
      }));
      return {
        projection: "full-chart",
        signals: decoded.signals,
        bars: input.data.close.length,
        plots: decoded.plots.map((plot, i) => ({
          title: prepared.plotDeclarations[i].title ?? "Untitled plot",
          values: plot,
          offset: prepared.plotDeclarations[i].style?.offset ?? 0
        })),
        strategy: {
          available: true,
          trades,
          equity,
          metrics: commonStrategyMetrics(
            prepared.initialCapital,
            trades,
            equity,
            strategy.position.size
          ),
          raw: nativeReport(input, () => strategy),
          notes: [
            "Native broker ledger and metrics plus full numeric plot/equity lanes, copied from the generated module."
          ]
        },
        diagnostics: prepared.diagnostics,
        notes: [
          "Zero imports verified from emitted bytes. Prepared calls reuse the same WebAssembly.Instance and memory, with fresh evaluation state.",
          "Full numeric plot lanes and native strategy results; no hosted interpreter or adapter-side broker. Symbol tick size and quantity increment are passed explicitly."
        ],
        artifact: {
          ...prepared.identity,
          memoryBytes: wasm.memory.buffer.byteLength,
          compilerMemoryBytes: compilerMemoryBytes(),
          outputBytes: outputLen,
          uploadedBytes: prepared.uploadedBytes,
          datasetUploads: prepared.datasetUploads,
          datasetReferences: prepared.datasetReferences
        }
      };
    });
    prepared.residentReady = resident;
    return output;
  } catch (error) {
    prepared.residentReady = false;
    prepared.poisoned = true;
    throw error;
  } finally {
    await m.phase("Output + input release", () => {
      if (!prepared.poisoned && outputPtr) wasm.dealloc(outputPtr, outputLen);
      if (!prepared.poisoned && inputPtr) wasm.dealloc(inputPtr, bytes.length);
    });
  }
}
export {
  execute,
  executeObjectives,
  prepare,
  initialize as __initialize
};
