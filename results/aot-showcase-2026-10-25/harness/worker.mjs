// Read-only worker for the benchmark harness routes.
// Engines and their npm installs are imported in place (never written);
// everything this process writes goes to stdout/stderr only.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const id = process.argv[2];
const HERE = resolve(import.meta.dirname);
const ENGINE_NPM = process.env.ENGINE_NODE_MODULES ?? resolve(HERE, "node_modules"); // npm installs of piner, pinets and @nullarch/resin
const diagnostic = (...x) => process.stderr.write(x.map(String).join(" ") + "\n");
console.log = console.warn = console.error = diagnostic;
globalThis.self = globalThis;

const mod = async (p) => import(pathToFileURL(p).href);
const bundle = async (name) => mod(resolve(HERE, "bundles", name + ".mjs"));
const pkg = async (name) => {
  const p = JSON.parse(readFileSync(resolve(ENGINE_NPM, name, "package.json"), "utf8"));
  return mod(resolve(ENGINE_NPM, name, p.module ?? p.main ?? "index.js"));
};

const common = await bundle("common");
const { commonStrategyMetrics } = await bundle("fixtures");
let adapter;
// PineWASM routes share one adapter bundle; each route reads its package directory from the environment variable named for it in AOT_PACKAGES.
const AOT_PACKAGES = { "aot-main": "PINEWASM_PKG_MAIN" };
if (id in AOT_PACKAGES) {
  process.env.PINEWASM_PKG = process.env[AOT_PACKAGES[id]];
  adapter = await bundle("compiled");
} else if (id === "piner") adapter = (await bundle("pinerApi")).createAdapter(await pkg("@heyphat/piner"));
else if (id === "pinets") adapter = (await bundle("pinetsApi")).createAdapter(await pkg("pinets"));
else if (id === "resin") adapter = (await bundle("resinApi")).createAdapter(await bundle("resin"));
else throw Error("Unknown route " + id);

let prepared, input;
// Engine start-up happens before "ready" for every route (JS engines load on import).
if (adapter.__initialize) await adapter.__initialize(new common.Measure());
process.stdout.write(JSON.stringify({ ready: true, id, supportsPrepared: true }) + "\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    const req = JSON.parse(line), m = new common.Measure();
    let output;
    if (req.input) {
      input = req.input;
      Object.values(input.data).forEach(Object.freeze);
      Object.freeze(input.data);
    }
    const run = req.inputs ? { ...input, inputs: req.inputs } : input;
    const t = performance.now();
    if (req.action === "prepare") prepared = await adapter.prepare(run, m);
    else if (req.action === "full") {
      const p = await adapter.prepare(input, m);
      try { output = await adapter.execute(p, input, m); } finally { adapter.dispose?.(p); }
    } else if (req.action === "execute") output = await adapter.execute(prepared, run, m);
    else if (req.action === "objectives") output = await adapter.executeObjectives(prepared, run, m);
    else throw Error("Unknown action");
    const elapsedMs = performance.now() - t;
    if (req.project === "metrics") {
      // Same projection as the correctness gate: the adapter's common metrics, computed
      // from its trades and equity only when it does not already report them.
      const st = output.strategy;
      const metrics = st.metrics ?? commonStrategyMetrics(10000, st.trades, st.equity, st.positionSize ?? 0);
      process.stdout.write(JSON.stringify({ ok: true, elapsedMs, metrics }) + "\n");
      continue;
    }
    const encoded = JSON.stringify({ ok: true, elapsedMs, stages: m.stages, output }, (_k, v) => {
      if (v === Infinity || v === -Infinity) throw Error("Infinite output");
      return typeof v === "number" && Number.isNaN(v) ? null : v;
    });
    process.stdout.write(encoded + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e), stack: e?.stack }) + "\n");
  }
}
