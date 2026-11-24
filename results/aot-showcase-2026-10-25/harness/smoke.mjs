// One full + one prepared evaluation per route on one fixture, gated by
// the fixture model and comparator bundle.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fixture, compareOutputs, commonStrategyMetrics } from "./bundles/fixtures.mjs";

export function gate(reference, output) {
  if (!output || output.bars !== reference.bars) return { pass: false, reason: "Incomplete bar count" };
  if (!Array.isArray(output.plots) || output.plots.some((p) => !Array.isArray(p.values) || p.values.length !== reference.bars))
    return { pass: false, reason: "Incomplete plot columns" };
  const s = output.strategy;
  if (s?.available && Array.isArray(s.trades) && Array.isArray(s.equity) && !s.metrics)
    s.metrics = commonStrategyMetrics(10000, s.trades, s.equity, s.positionSize ?? 0);
  const ref = { ...reference, strategy: reference.strategy ?? { available: false, trades: null, equity: null, metrics: {}, raw: null, notes: [] } };
  const comparison = compareOutputs(ref, output);
  const parts = reference.strategy ? ["plots", "trades", "equity", "metrics"] : ["plots"];
  return { pass: parts.every((k) => comparison[k].status === "match"), comparison };
}

export function startWorker(id) {
  const p = spawn(process.execPath, [...(process.env.WORKER_FLAGS ? process.env.WORKER_FLAGS.split(" ") : []), new URL("./worker.mjs", import.meta.url).pathname, id], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
  const queue = [], waiters = [];
  createInterface({ input: p.stdout }).on("line", (l) => {
    let r; try { r = JSON.parse(l); } catch { return; }
    const w = waiters.shift(); if (w) w(r); else queue.push(r);
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((res) => waiters.push(res));
  return {
    p, next, get stderr() { return stderr; },
    async request(req) { const t = performance.now(), n = next(); p.stdin.write(JSON.stringify(req) + "\n"); const r = await n; return { ...r, roundtripMs: performance.now() - t }; },
    close() { p.stdin.end(); p.kill(); },
  };
}

if (import.meta.main ?? process.argv[1]?.endsWith("smoke.mjs")) {
  const [fx = "periodic", bars = "256", seed = "934", ...ids] = process.argv.slice(2);
  const f = fixture(fx, Number(bars), Number(seed));
  for (const id of ids) {
    const w = startWorker(id);
    try {
      const t0 = performance.now(); const ready = await w.next(); const initMs = performance.now() - t0;
      const full = await w.request({ action: "full", input: f.input });
      const g = full.ok ? gate(f.reference, full.output) : { pass: false, reason: full.error };
      const prep = await w.request({ action: "prepare", input: f.input });
      let exec = null;
      for (let i = 0; i < 3; i++) exec = await w.request({ action: "execute" });
      const g2 = exec.ok ? gate(f.reference, exec.output) : { pass: false, reason: exec.error };
      const bad = (x) => x.pass ? "PASS" : "FAIL " + (x.reason ?? JSON.stringify(Object.fromEntries(Object.entries(x.comparison ?? {}).filter(([, v]) => v?.status && v.status !== "match"))).slice(0, 300));
      console.log(id, ready.id, "init", initMs.toFixed(1), "ms | full", full.roundtripMs.toFixed(2), "ms", bad(g), "| prepared#3", exec.roundtripMs?.toFixed(2), "ms", bad(g2), prep.ok ? "" : "PREP ERR " + prep.error);
      if (full.ok && full.stages) console.log("   stages", JSON.stringify(full.stages).slice(0, 600));
    } finally { w.close(); }
  }
}
