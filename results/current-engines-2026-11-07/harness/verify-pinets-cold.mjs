import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fixture, params, workloads } from "../../aot-showcase-2026-10-25/harness/bundles/fixtures.mjs";
import { metricDifferences } from "./campaign.mjs";

const bars = 4096;
const trials = 500;
const repetitions = 5;
const engines = ["aot-main", "pinets"];
const cases = ["periodic", "window", "weighted", "momentum"];

// This is the parameter generator for the harness.
function parameters(workload) {
  let state = [...`${workload}:${bars}`].reduce(
    (hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 2166136261,
  );
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const rows = [{ ...params }];
  while (rows.length < trials) {
    rows.push({
      Period: 4 + Math.floor(next() * 97),
      Length: 1 + Math.floor(next() * 100),
      Threshold: Math.round((next() * 10 - 5) * 100) / 100,
    });
  }
  return rows;
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

if (process.argv.length !== 3) throw new Error("usage: node verify-pinets-cold.mjs INPUT_JSON[.gz]");
const file = process.argv[2];
const bytes = readFileSync(file);
const report = JSON.parse(file.endsWith(".gz") ? gunzipSync(bytes) : bytes);
assert.ok(report.completedAt);
assert.equal(report.schema, 1);
assert.equal(report.compiler.sourceRevision, "20d6304ebe3faad6d14238eab79c6a03f42f7a2e");
assert.equal(report.compiler.compilerVersion, "21.1.0");
assert.equal(report.pinets, "0.13.1");
assert.equal(report.reps, repetitions);
assert.deepEqual(report.engines, engines);
assert.deepEqual(report.configs, [{ workloads: cases, bars, trials, caps: {} }]);
assert.equal(report.campaigns.length, cases.length * engines.length * repetitions);

const rows = {};
for (const workload of cases) {
  const { input } = fixture(workload, bars, 934);
  const reference = parameters(workload).map((row) => workloads[workload].oracle(input.data, row).strategy.metrics);
  const totals = {};
  for (const engine of engines) {
    const campaigns = report.campaigns.filter((run) => run.workload === workload && run.engine === engine)
      .sort((a, b) => a.rep - b.rep);
    assert.equal(campaigns.length, repetitions);
    totals[engine] = campaigns.map((run, repetition) => {
      const context = `${engine}/${workload}/${repetition}`;
      assert.equal(run.rep, repetition, context);
      assert.equal(run.bars, bars, context);
      assert.equal(run.trials, trials, context);
      assert.equal(run.ok, true, context);
      assert.equal(run.metricsPass, trials, context);
      assert.deepEqual(run.fullGate, [true, true], context);
      assert.equal(run.t.length, trials, context);
      assert.equal(run.trialWorkerMs.length, trials, context);
      assert.equal(run.metrics.length, trials, context);
      let previous = run.preparedMs;
      assert.ok(Number.isFinite(previous) && previous > 0, context);
      for (let index = 0; index < trials; ++index) {
        const sample = `${context}/${index}`;
        assert.deepEqual(metricDifferences(reference[index], run.metrics[index]), [], sample);
        const elapsed = run.t[index];
        assert.ok(Number.isFinite(elapsed) && elapsed > previous, sample);
        assert.ok(Number.isFinite(run.trialWorkerMs[index]) && run.trialWorkerMs[index] > 0, sample);
        previous = elapsed;
      }
      return {
        endToEndMs: run.t.at(-1),
        workerMs: run.trialWorkerMs.reduce((sum, time) => sum + time, 0),
      };
    });
  }
  rows[workload] = {
    endToEnd: median(totals.pinets.map((run, i) => run.endToEndMs / totals["aot-main"][i].endToEndMs)),
    worker: median(totals.pinets.map((run, i) => run.workerMs / totals["aot-main"][i].workerMs)),
    totals,
  };
}
const aggregate = (metric) => Math.exp(
  cases.reduce((sum, workload) => sum + Math.log(rows[workload][metric]), 0) / cases.length,
);
console.log(JSON.stringify({
  bars, trials, repetitions,
  engine: report.pinets,
  compiler: report.compiler,
  host: report.host,
  completedAt: report.completedAt,
  metricsChecked: report.campaigns.length * trials,
  endpointChecks: report.campaigns.length * 2,
  endToEndSpeedup: aggregate("endToEnd"),
  workerSpeedup: aggregate("worker"),
  rows,
}, null, 2));
