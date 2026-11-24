// Compares PineWASM and PineForge on the strategy set and feed named by PINEFORGE_CHECKOUT.
// Per slot, in randomized engine order (so both see the same host conditions):
//  - PineWASM: fresh worker; compile once (stage times kept); one untimed run with the
//    full native report for the trade cross-check; warmups; measured repeated runs.
//  - PineForge: pf_time (the engine's own throughput loop: create + pinned overrides +
//    run_backtest over the whole feed + free), all iterations timed, plus an untimed
//    run for its trades.
// Run the output comparison first and time only eligible slots.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { startWorker } from "../../aot-showcase-2026-10-25/harness/smoke.mjs";

const ENGINE = process.env.PINEFORGE_CHECKOUT;
const PF_TIME = process.env.PINEFORGE_CORPUS_WORKER;
if (!ENGINE || !PF_TIME) throw new Error("set PINEFORGE_CHECKOUT and PINEFORGE_CORPUS_WORKER");
const SLOTS = ENGINE + "/benchmarks/assets/strategies";
const FEED = ENGINE + "/benchmarks/assets/data/ETHUSDT_15.csv";
const OUT = process.argv[2] ?? "pf-vs-pw.json";
const only = process.argv.slice(3);
const PW_WARM = 3, PW_RUNS = 20, PF_ITERS = PW_WARM + PW_RUNS;

const feed = readFileSync(FEED, "utf8");
const rows = feed.trim().split("\n").slice(1).map((l) => l.split(",").map(Number));
const data = { open: [], high: [], low: [], close: [], volume: [], time: [] };
for (const [t, o, h, l, c, v] of rows) { data.time.push(t); data.open.push(o); data.high.push(h); data.low.push(l); data.close.push(c); data.volume.push(v); }
const dataset = { id: "pineforge-ethusdt-15", title: "ETHUSDT 15m (benchmark feed)", file: "", sha256: "", rows: rows.length, symbol: "ETHUSDT", mintick: 0.01, mincontract: 1e-8, missingVolume: 0, timeframe: "15", timezone: "UTC", sourcePath: "benchmarks/assets/data/ETHUSDT_15.csv" };

function overridesOf(slot) {
  const f = `${SLOTS}/${slot}/inputs.json`;
  if (!existsSync(f)) return {};
  return JSON.parse(readFileSync(f, "utf8")).strategy_overrides ?? {};
}
function pinnedSource(src, ov) {
  // Only initial_capital is pinned by any slot; apply it to the strategy() declaration.
  let out = src;
  for (const [k, v] of Object.entries(ov)) {
    if (k !== "initial_capital") throw Error("unsupported pin " + k);
    out = /initial_capital\s*=\s*[\d.]+/.test(out) ? out.replace(/initial_capital\s*=\s*[\d.]+/, `initial_capital=${v}`) : out.replace(/strategy\(\s*("[^"]*"|'[^']*')/, (m) => `${m}, initial_capital=${v}`);
  }
  return out;
}
const close = (a, b, rel = 1e-6) => Number.isFinite(a) && Number.isFinite(b)
  && Math.abs(a - b) <= 1e-6 + rel * Math.max(Math.abs(a), Math.abs(b));
function compareTrades(pf, pw) {
  // exact: every closed trade matches. signals: same trades on the same bars, sides and
  // fill prices, with quantity/PnL differing only through the sizing convention.
  const a = pf.filter((t) => t[7] === 0), b = pw;
  if (a.length !== b.length) return { agree: false, tier: "diverge", why: `closed trades ${a.length} vs ${b.length}` };
  let tier = "exact", why = "";
  for (let i = 0; i < a.length; i++) {
    const [eb, xb, ep, xp, q, pnl, isLong] = a[i], t = b[i];
    if (eb !== t.entryBar || xb !== t.exitBar || (isLong ? 1 : -1) !== t.direction) return { agree: false, tier: "diverge", why: `trade ${i} bars/side ${eb}->${xb} vs ${t.entryBar}->${t.exitBar}` };
    if (!close(ep, t.entryPrice) || !close(xp, t.exitPrice)) return { agree: false, tier: "diverge", why: `trade ${i} prices ${ep}/${xp} vs ${t.entryPrice}/${t.exitPrice}` };
    if (tier === "exact" && (!close(q, t.quantity) || !close(pnl, t.profit, 1e-5))) { tier = "signals"; why = `first sizing difference at trade ${i}: qty ${q} vs ${t.quantity}`; }
  }
  return { agree: true, tier, trades: a.length, why };
}
function med(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function waitForWorker(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("worker request timed out")), 120_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function runPineWASM(source, timed) {
  const r = { route: "aot-main" };
  const wk = startWorker("aot-main");
  try {
    const t0 = performance.now(); await waitForWorker(wk.next()); r.readyMs = performance.now() - t0;
    const p = await waitForWorker(wk.request({ action: "prepare", input: { source, data, inputs: {}, dataset, residentData: true, nativeReport: "omit" } }));
    if (!p.ok) { r.error = String(p.error).slice(0, 400); return r; }
    r.prepareMs = p.elapsedMs; r.stages = Object.fromEntries((p.stages ?? []).map((s) => [s.name, s.ms]));
    const full = await waitForWorker(wk.request({ action: "execute" }));
    if (!full.ok) { r.error = "run: " + String(full.error).slice(0, 400); return r; }
    r.firstRunMs = full.elapsedMs;
    const s = full.output.strategy;
    if (!Array.isArray(s?.trades) || !Array.isArray(s?.equity))
      throw new Error("missing full strategy output");
    r.trades = s.trades;
    r.equity = s.equity;
    r.metrics = s.metrics;
    r.ms = [];
    for (let i = 0; timed && i < PW_WARM + PW_RUNS; i++) {
      const e = await waitForWorker(wk.request({ action: "execute", project: "metrics" }));
      if (!e.ok) { r.error = "repeat: " + e.error; return r; }
      if (i >= PW_WARM) r.ms.push(e.elapsedMs);
    }
  } catch (error) {
    r.error = error.message;
  } finally { wk.close(); }
  return r;
}
function runPineForge(slot, ov, timed) {
  const lib = `${SLOTS}/${slot}/strategy.${os.platform() === "darwin" ? "dylib" : "so"}`;
  if (!existsSync(lib)) return { error: "missing native module for " + slot };
  try {
    const out = execFileSync(PF_TIME, [lib, FEED, String(timed ? PF_ITERS : 0), ...Object.entries(ov).map(([k, v]) => `${k}=${v}`)], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 120_000 });
    const value = JSON.parse(out);
    if (!value.ok || !Array.isArray(value.trades) || !Array.isArray(value.equity)
      || value.equity.length !== rows.length)
      return { error: value.error ?? "native benchmark run returned incomplete output" };
    value.ms = value.ms.slice(PW_WARM);
    return value;
  } catch (e) { return { error: String(e.message).slice(0, 300) }; }
}

function admission(pf, pw) {
  if (pf.error || pw.error)
    return { agreement: { agree: false, why: pf.error ? "PineForge error" : "PineWASM error" }, matched: false };
  const agreement = compareTrades(pf.trades, pw.trades);
  const pfBars = pf.equity.length;
  const pwBars = pw.equity.length;
  const firstDifference = pf.equity.findIndex((value, i) => !close(value, pw.equity[i], 1e-8));
  const pass = pfBars === rows.length && pwBars === rows.length && firstDifference === -1;
  return { agreement, equity: { pfBars, pwBars, firstDifference, pass }, matched: agreement.tier === "exact" && pass };
}

const slots = readdirSync(SLOTS).filter((d) => /^\d{3}-/.test(d) && (!only.length || only.some((o) => d.startsWith(o)))).sort();
const digest = (contents) => createHash("sha256").update(contents).digest("hex");
const report = { schema: 1, createdAt: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model, logical: os.cpus().length, node: process.version }, feed: { path: dataset.sourcePath, bars: rows.length, sha256: digest(feed) }, pfIterations: PF_ITERS, pwWarmups: PW_WARM, pwRuns: PW_RUNS, slots: [] };
const save = () => { writeFileSync(OUT + ".tmp", JSON.stringify(report)); renameSync(OUT + ".tmp", OUT); };
let rng = 20261025;
for (const slot of slots) {
  const probe = slot.replace(/^\d{3}-/, "");
  const ov = overridesOf(slot);
  const source = pinnedSource(readFileSync(`${SLOTS}/${slot}/strategy.pine`, "utf8"), ov);
  rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
  const pfFirst = (rng >>> 16) % 2 === 0;
  const load = os.loadavg()[0];
  async function pair(timed) {
    if (pfFirst) {
      const pf = runPineForge(slot, ov, timed);
      const pw = await runPineWASM(source, timed);
      return { pf, pw };
    }
    const pw = await runPineWASM(source, timed);
    const pf = runPineForge(slot, ov, timed);
    return { pf, pw };
  }
  let { pf, pw } = await pair(false);
  const initial = admission(pf, pw);
  if (initial.matched) ({ pf, pw } = await pair(true));
  const row = { slot, probe, pins: ov, order: pfFirst ? "pineforge-first" : "pinewasm-first", loadavg1: load, sourceSha256: digest(source) };
  row.pineforge = pf.error ? { error: pf.error } : { totalTrades: pf.totalTrades, netProfit: pf.netProfit, ms: pf.ms, medianMs: med(pf.ms) };
  row.pinewasm = pw.error ? { error: pw.error, stages: pw.stages } : { readyMs: pw.readyMs, prepareMs: pw.prepareMs, stages: pw.stages, firstRunMs: pw.firstRunMs, ms: pw.ms, medianMs: med(pw.ms), closedTrades: pw.metrics?.closedTrades, netProfit: pw.metrics?.netProfit };
  Object.assign(row, admission(pf, pw));
  row.timed = row.matched && pf.ms?.length === PW_RUNS && pw.ms?.length === PW_RUNS;
  report.slots.push(row);
  save();
  const f = (x) => (x == null ? "-" : x.toFixed(1));
  console.log(slot.padEnd(52), (row.agreement.tier ?? "diverge").padEnd(8), `pf ${f(row.pineforge.medianMs)} ms`, `pw ${f(row.pinewasm.medianMs)} ms`, row.agreement.agree ? "" : `| ${row.agreement.why}`);
}
report.completedAt = new Date().toISOString();
save();
const ok = report.slots.filter((r) => r.matched);
console.log(`slots with matching closed trades and equity ${ok.length}/${report.slots.length}`);
