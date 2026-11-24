import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fixture, workloads } from "../../aot-showcase-2026-10-25/harness/bundles/fixtures.mjs";
import { gate } from "../../aot-showcase-2026-10-25/harness/smoke.mjs";
import { metricDifferences, parameterSequence } from "./campaign.mjs";

const expectedEngines = ["aot-main", "pinets", "pineforge", "pynecore"];
const expectedWorkloads = ["momentum", "periodic", "weighted", "window"];
const expectedVersions = {
  aot: "21.1.0",
  revision: "20d6304ebe3faad6d14238eab79c6a03f42f7a2e",
  pinets: "0.13.1",
  pineforge: "1.10.0+59f98ba",
  pynecore: "6.12.1",
};

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  const bytes = readFileSync(file);
  return JSON.parse(file.endsWith(".gz") ? gunzipSync(bytes) : bytes);
}

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function verify(file) {
  const report = readJson(file);
  const { profile, profileName, seed, engines, fixtures, runs } = report;
  requireCondition(report.schema === 1 && report.finishedAt && seed === 934, "unexpected report identity");
  requireCondition(JSON.stringify(engines) === JSON.stringify(expectedEngines), "unexpected engines");
  requireCondition(report.compiler.compilerVersion === expectedVersions.aot
    && report.compiler.sourceRevision === expectedVersions.revision
    && report.pinets === expectedVersions.pinets, "wrong engine build");
  if (profileName === "campaign") {
    requireCondition(profile.bars === 4096 && profile.trials === 500 && profile.repetitions === 5
      && JSON.stringify(profile.workloads) === JSON.stringify(expectedWorkloads), "wrong campaign matrix");
  } else if (profileName === "long") {
    requireCondition(profile.bars === 65536 && profile.trials === 30 && profile.repetitions === 5
      && JSON.stringify(profile.workloads) === JSON.stringify(["periodic", "window"]), "wrong long matrix");
  } else {
    requireCondition(profileName === "smoke", "unknown profile");
  }
  const rows = {};
  const failures = [];
  let metricsChecked = 0;
  let recordedOutputsChecked = 0;
  const expectedTotal = profile.workloads.length * profile.repetitions * engines.length;
  requireCondition(runs.length === expectedTotal, `expected ${expectedTotal} runs`);
  for (const workload of profile.workloads) {
    const { input } = fixture(workload, profile.bars, seed);
    const sequence = parameterSequence(workload, profile.bars, profile.trials);
    const { sourceSha256, feedSha256, parameterSha256 } = fixtures[workload];
    const feed = input.data.time.map((time, i) => (
      [time, input.data.open[i], input.data.high[i], input.data.low[i], input.data.close[i], input.data.volume[i]].join("\t")
    )).join("\n") + "\n";
    requireCondition(hash(input.source) === sourceSha256 && hash(feed) === feedSha256
      && hash(JSON.stringify(sequence)) === parameterSha256, `wrong fixture data for ${workload}`);
    const oracle = workloads[workload].oracle;
    const reference = sequence.map((parameters) => oracle(input.data, parameters).strategy.metrics);
    const endpoints = [0, sequence.length - 1].map((index) => oracle(input.data, sequence[index]));
    const totals = {};
    let eligible = true;
    for (const engine of engines) {
      const engineRuns = runs.filter((run) => run.workload === workload && run.engine === engine)
        .sort((a, b) => a.repetition - b.repetition);
      requireCondition(engineRuns.length === profile.repetitions, `missing ${engine} ${workload}`);
      totals[engine] = [];
      for (const [repetition, run] of engineRuns.entries()) {
        const cell = `${engine}/${workload}/${repetition}`;
        requireCondition(run.repetition === repetition, `wrong repetition ${cell}`);
        if ((engine === "pineforge" || engine === "pynecore") && !run.error)
          requireCondition(run.workerVersion === expectedVersions[engine], `wrong worker version ${cell}`);
        requireCondition(run.samples.length <= sequence.length, `unexpected sample count ${cell}`);
        let differences = 0;
        for (const [index, sample] of run.samples.entries()) {
          requireCondition(Number.isFinite(sample.elapsedMs) && sample.elapsedMs > 0, `invalid timing ${cell}`);
          const changed = metricDifferences(reference[index], sample.metrics);
          requireCondition(JSON.stringify(changed) === JSON.stringify(sample.differences), `gate disagrees ${cell}`);
          differences += changed.length > 0 ? 1 : 0;
          metricsChecked += 1;
        }
        const passed = run.samples.length === sequence.length && differences === 0
          && run.fullGate.length === 2 && run.fullGate.every((check) => check.pass) && !run.error;
        requireCondition(passed === run.ok, `wrong run status ${cell}`);
        if (!passed) {
          eligible = false;
          failures.push({ engine, workload, repetition, differences, error: run.error ?? null,
            failedFull: run.fullGate.filter((check) => !check.pass).map((check) => check.index) });
        }
        totals[engine].push(run.samples.reduce((sum, sample) => sum + sample.elapsedMs, 0));
        if (run.endpointEvidence) {
          const directory = resolve(dirname(file), `${profileName}-endpoints`);
          const fileName = `${workload}-${engine}.json.gz`;
          requireCondition(run.endpointEvidence.file === fileName, `unexpected endpoint filename ${cell}`);
          const bytes = readFileSync(resolve(directory, fileName));
          requireCondition(hash(bytes) === run.endpointEvidence.sha256, `wrong endpoint digest ${cell}`);
          const actual = JSON.parse(gunzipSync(bytes));
          requireCondition(actual.length === endpoints.length, `wrong endpoint count ${cell}`);
          for (const [i, endpoint] of actual.entries()) {
            requireCondition(endpoint.index === run.fullGate[i].index
              && gate(endpoints[i], endpoint.output).pass === run.fullGate[i].pass, `endpoint gate disagrees ${cell}`);
            recordedOutputsChecked += 1;
          }
        } else if (passed && repetition === 0) {
          throw new Error(`missing first-repetition endpoint output ${cell}`);
        }
      }
    }
    rows[workload] = {
      eligible,
      totalsMs: totals,
      medianMs: Object.fromEntries(engines.map((engine) => [engine, median(totals[engine])])),
      pairedSpeedup: eligible ? Object.fromEntries(engines.slice(1).map((engine) => [
        engine, median(totals[engine].map((time, i) => time / totals["aot-main"][i])),
      ])) : null,
    };
  }
  const admitted = Object.entries(rows).filter(([, row]) => row.eligible).map(([workload]) => workload);
  const speedup = Object.fromEntries(engines.slice(1).map((engine) => [
    engine, admitted.length > 0
      ? Math.exp(admitted.reduce((sum, workload) => sum + Math.log(rows[workload].pairedSpeedup[engine]), 0) / admitted.length)
      : null,
  ]));
  return {
    profileName, profile, seed, admitted, speedup, rows, failures, metricsChecked, recordedOutputsChecked,
    compiler: report.compiler, host: report.host, startedAt: report.startedAt, finishedAt: report.finishedAt,
    load1: [Math.min(...runs.map((run) => run.load[0])), Math.max(...runs.map((run) => run.load[0]))],
  };
}

if (process.argv.length !== 3) throw new Error("usage: node verify.mjs CAMPAIGN_JSON[.gz]");
console.log(JSON.stringify(verify(process.argv[2]), null, 2));
