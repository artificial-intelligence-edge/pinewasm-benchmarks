// Replays the end-to-end timing method on the four shared 4,096-bar workloads.
// Parameter sweep: one fresh worker process per campaign. The clock starts
// before the process is spawned and every trial result is timestamped, so the
// cumulative cost curve T(n) is measured, not extrapolated. Trial 1 uses the
// default inputs (the first run a user sees); later trials sweep the declared
// input ranges. Every engine gets the same source, data, parameter sequence and
// reuse opportunity (compiled code and data stay resident; fresh state per trial).
// Correctness, all outside the clock: every trial's common metrics against the
// workload model, plus the full plot/trade/equity gate on the first and last trial.
import { writeFileSync, renameSync, readFileSync } from "node:fs";
import os from "node:os";
import { fixture, workloads, params } from "../../aot-showcase-2026-10-25/harness/bundles/fixtures.mjs";
import { gate, startWorker } from "../../aot-showcase-2026-10-25/harness/smoke.mjs";

const OUT = process.argv[2];
if (process.argv.length !== 3) throw new Error("usage: node pinets-cold.mjs OUTPUT_JSON");
const engines = ["aot-main", "pinets"];
const REPS = 5;
const configs = [{ workloads: ["periodic", "window", "weighted", "momentum"], bars: 4096, trials: 500, caps: {} }];
const compiler = JSON.parse(readFileSync(process.env.PINEWASM_PKG_MAIN + "/identity.json", "utf8")).version;
const pinets = JSON.parse(readFileSync(process.env.ENGINE_NODE_MODULES + "/pinets/package.json", "utf8")).version;
if (compiler.sourceRevision !== "20d6304ebe3faad6d14238eab79c6a03f42f7a2e" || pinets !== "0.13.1")
  throw new Error("unexpected compiler or PineTS build");

function parameterSequence(workload, bars, n) {
  let x = [...`${workload}:${bars}`].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 2166136261);
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const seq = [{ ...params }];
  while (seq.length < n)
    seq.push({ Period: 4 + Math.floor(next() * 97), Length: 1 + Math.floor(next() * 100), Threshold: Math.round((next() * 10 - 5) * 100) / 100 });
  return seq;
}

const close = (a, b) => (a === null && b === null) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-8 + 1e-8 * Math.max(Math.abs(a), Math.abs(b)));
function metricsMatch(ref, got) {
  const keys = new Set([...Object.keys(ref), ...Object.keys(got ?? {})]);
  return got && [...keys].every((k) => k in ref && k in got && close(ref[k], got[k]));
}

const report = {
  schema: 1, createdAt: new Date().toISOString(),
  host: { cpus: os.cpus()[0]?.model, logical: os.cpus().length, node: process.version, loadavgStart: os.loadavg() },
  method: "Fresh process per campaign; clock from spawn; per-trial timestamps; metrics-only transport for every engine; output checks outside the clock",
  engines, configs, reps: REPS, campaigns: [], compiler, pinets,
};
const save = () => { writeFileSync(OUT + ".tmp", JSON.stringify(report)); renameSync(OUT + ".tmp", OUT); };
const oracleCache = new Map();
const oracleFor = (w, bars, data, i, p) => {
  const k = `${w}|${bars}|${i}`;
  if (!oracleCache.has(k)) oracleCache.set(k, workloads[w].oracle(data, p));
  return oracleCache.get(k);
};

let rng = 4242;
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; const j = rng % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function campaign(engine, w, cfg, rep) {
  const f = fixture(w, cfg.bars, 934);
  const n = Math.min(cfg.trials, cfg.caps[engine] ?? Infinity);
  const seq = parameterSequence(w, cfg.bars, n);
  const c = { engine, workload: w, bars: cfg.bars, rep, trials: n, t: [], trialWorkerMs: [] };
  const t0 = performance.now();
  const wk = startWorker(engine);
  try {
    await wk.next();
    c.readyMs = performance.now() - t0;
    const p = await wk.request({ action: "prepare", input: { ...f.input, inputs: seq[0] } });
    if (!p.ok) throw Error("prepare: " + p.error);
    c.preparedMs = performance.now() - t0;
    const metrics = [];
    for (let i = 0; i < n; i++) {
      const r = await wk.request({ action: "execute", inputs: seq[i], project: "metrics" });
      if (!r.ok) throw Error(`trial ${i}: ${r.error}`);
      c.t.push(performance.now() - t0);
      c.trialWorkerMs.push(r.elapsedMs);
      metrics.push(r.metrics);
    }
    // ---- clock stopped; correctness only below ----
    c.metrics = metrics;
    c.fullGate = [];
    for (const i of [0, n - 1]) {
      const r = await wk.request({ action: "execute", inputs: seq[i] });
      const ref = oracleFor(w, cfg.bars, f.input.data, i, seq[i]);
      c.fullGate.push(r.ok && gate(ref, r.output).pass);
    }
    c.metricsPass = metrics.filter((m, i) => metricsMatch(oracleFor(w, cfg.bars, f.input.data, i, seq[i]).strategy.metrics, m)).length;
    c.ok = c.metricsPass === n && c.fullGate.every(Boolean);
  } catch (e) { c.ok = false; c.error = String(e); }
  finally { wk.close(); }
  return c;
}

for (let rep = 0; rep < REPS; rep++) {
  for (const cfg of configs) for (const w of cfg.workloads) for (const engine of shuffle(engines)) {
    const c = await campaign(engine, w, cfg, rep);
    report.campaigns.push(c);
    save();
    console.log("campaign", rep, engine, w, c.trials, c.ok ? "PASS" : "FAIL " + (c.error ?? "output check failed"), (c.t.at(-1) ?? 0).toFixed(0), "ms");
  }
  console.log("rep", rep + 1, "of", REPS, "done", new Date().toISOString(), "loadavg", os.loadavg().map((x) => x.toFixed(2)).join(" "));
}
report.completedAt = new Date().toISOString();
report.host.loadavgEnd = os.loadavg();
save();
console.log("complete", report.campaigns.length, "campaigns");
if (report.campaigns.some((entry) => !entry.ok)) process.exitCode = 2;
