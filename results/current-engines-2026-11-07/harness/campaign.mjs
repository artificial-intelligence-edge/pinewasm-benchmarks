import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { fixture, params, workloads } from "../../aot-showcase-2026-10-25/harness/bundles/fixtures.mjs";
import { gate } from "../../aot-showcase-2026-10-25/harness/smoke.mjs";

const engines = ["aot-main", "pinets", "pineforge", "pynecore"];
const cases = ["momentum", "periodic", "weighted", "window"];
const seed = 934;

const profiles = {
  smoke: { bars: 4096, trials: 6, repetitions: 1, workloads: cases },
  campaign: { bars: 4096, trials: 500, repetitions: 5, workloads: cases },
  long: { bars: 65536, trials: 30, repetitions: 5, workloads: ["periodic", "window"] },
};

// Parameter sequence used in the November four-engine benchmark run.
export function parameterSequence(workload, bars, count) {
  let state = [...`${workload}:${bars}`].reduce(
    (hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, seed,
  );
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const rows = [{ ...params }];
  while (rows.length < count) {
    rows.push({
      Period: 4 + Math.floor(next() * 97),
      Length: 1 + Math.floor(next() * 100),
      Threshold: Math.round((next() * 10 - 5) * 100) / 100,
    });
  }
  return rows;
}

export function metricDifferences(expected, actual) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual ?? {})]);
  return [...keys].filter((key) => {
    const left = expected[key];
    const right = actual?.[key];
    if (left === null && right === null) return false;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
    return Math.abs(left - right) > 1e-8 + 1e-8 * Math.max(Math.abs(left), Math.abs(right));
  });
}

function fileHash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function shuffledOrders() {
  let state = 4242;
  return () => {
    const order = [...engines];
    for (let i = order.length - 1; i > 0; --i) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = Math.floor(state / 2 ** 32 * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  };
}

function engineWorker(engine, workload, feed, scratch) {
  let executable = process.execPath;
  let args = [fileURLToPath(new URL("../../aot-showcase-2026-10-25/harness/worker.mjs", import.meta.url)), engine];
  const isJs = engine === "aot-main" || engine === "pinets";
  if (engine === "pineforge") {
    executable = process.env.PINEFORGE_WORKER;
    args = [workload, feed];
  } else if (engine === "pynecore") {
    executable = process.env.PYNE_PYTHON;
    args = [fileURLToPath(new URL("./pyne-worker.py", import.meta.url)), workload, feed, scratch];
  }
  const child = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONPYCACHEPREFIX: resolve(scratch, "pycache") },
  });
  let stderr = "";
  let processError;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => { stderr = (stderr + text).slice(-6000); });
  child.on("error", (error) => { processError = error; });
  child.stdin.on("error", (error) => { processError = error; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stream = lines[Symbol.asyncIterator]();
  async function read() {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    try {
      const { value, done } = await stream.next();
      if (done) throw new Error(processError?.message ?? (stderr.trim() || "worker exited"));
      const response = JSON.parse(value);
      if (response.ok === false) throw new Error(response.error);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    read,
    async prepare(input, inputs) {
      if (!isJs) return;
      child.stdin.write(JSON.stringify({ action: "prepare", input: { ...input, inputs } }) + "\n");
      await read();
    },
    async execute(inputs, projection) {
      const request = isJs
        ? JSON.stringify({ action: "execute", inputs, project: projection })
        : [projection, inputs.Period, inputs.Length, inputs.Threshold].join(" ");
      child.stdin.write(request + "\n");
      const result = await read();
      if (!Number.isFinite(result.elapsedMs) || result.elapsedMs <= 0)
        throw new Error("missing or invalid engine timing");
      return result;
    },
    close() {
      child.stdin.end();
      child.kill();
      lines.close();
    },
  };
}

function buildCase(workload, profile, scratch) {
  const { input } = fixture(workload, profile.bars, seed);
  const rows = parameterSequence(workload, profile.bars, profile.trials);
  const columns = ["open", "high", "low", "close", "volume"];
  const feed = input.data.time.map((time, i) => (
    [time, ...columns.map((column) => input.data[column][i])].join("\t")
  )).join("\n") + "\n";
  const feedPath = resolve(scratch, `bars-${profile.bars}.tsv`);
  writeFileSync(feedPath, feed);
  const oracle = workloads[workload].oracle;
  const expectations = rows.map((inputs) => oracle(input.data, inputs).strategy.metrics);
  const endpoints = [0, rows.length - 1].map((index) => ({
    index,
    expected: oracle(input.data, rows[index]),
  }));
  return {
    workload, input, rows, expectations, endpoints, feedPath,
    identity: {
      sourceSha256: fileHash(input.source),
      feedSha256: fileHash(feed),
      parameterSha256: fileHash(JSON.stringify(rows)),
    },
  };
}

async function campaign(engine, repetition, testCase, scratch, evidence) {
  const { workload, input, rows, expectations, endpoints, feedPath } = testCase;
  const run = { engine, repetition, workload, load: os.loadavg(), samples: [], fullGate: [] };
  const started = performance.now();
  const worker = engineWorker(engine, workload, feedPath, scratch);
  try {
    const ready = await worker.read();
    if (!ready.ready) throw new Error("worker did not acknowledge startup");
    run.workerVersion = ready.version ?? null;
    run.startupMs = performance.now() - started;
    await worker.prepare(input, rows[0]);
    run.preparedMs = performance.now() - started;
    for (let i = 0; i < rows.length; ++i) {
      const result = await worker.execute(rows[i], "metrics");
      const differences = metricDifferences(expectations[i], result.metrics);
      run.samples.push({ elapsedMs: result.elapsedMs, metrics: result.metrics, differences });
    }
    // Check detailed output outside the measured samples.
    const endpointOutputs = [];
    for (const { index, expected } of endpoints) {
      const { output } = await worker.execute(rows[index], "full");
      const verdict = gate(expected, output);
      run.fullGate.push({ index, ...verdict });
      endpointOutputs.push({ index, output });
    }
    if (repetition === 0) {
      const file = `${workload}-${engine}.json.gz`;
      const bytes = gzipSync(JSON.stringify(endpointOutputs));
      writeFileSync(resolve(evidence, file), bytes);
      run.endpointEvidence = { file, sha256: fileHash(bytes) };
    }
    run.ok = run.samples.every((sample) => sample.differences.length === 0)
      && run.fullGate.every((check) => check.pass);
  } catch (error) {
    run.ok = false;
    run.error = error.message;
  } finally {
    worker.close();
  }
  return run;
}

async function main() {
  const [profileName, outputPath, scratchPath] = process.argv.slice(2);
  const profile = profiles[profileName];
  if (!profile || !outputPath || !scratchPath)
    throw new Error("usage: node campaign.mjs smoke|campaign|long OUTPUT_JSON SCRATCH_DIRECTORY");
  for (const name of ["PINEWASM_PKG_MAIN", "ENGINE_NODE_MODULES", "PINEFORGE_WORKER", "PYNE_PYTHON"]) {
    if (!process.env[name]) throw new Error(`set ${name}`);
  }
  const scratch = resolve(scratchPath);
  mkdirSync(scratch, { recursive: true });
  const evidence = resolve(dirname(outputPath), `${profileName}-endpoints`);
  mkdirSync(evidence, { recursive: true });
  const compiler = JSON.parse(readFileSync(resolve(process.env.PINEWASM_PKG_MAIN, "identity.json"), "utf8"));
  const pinets = JSON.parse(readFileSync(resolve(process.env.ENGINE_NODE_MODULES, "pinets/package.json"), "utf8"));
  const report = {
    schema: 1, profileName, profile, seed, engines, startedAt: new Date().toISOString(),
    compiler: compiler.version, pinets: pinets.version,
    wasmSha256: fileHash(readFileSync(resolve(process.env.PINEWASM_PKG_MAIN, "pinewasm_bg.wasm"))),
    forgeExecutableSha256: fileHash(readFileSync(process.env.PINEFORGE_WORKER)),
    host: { cpu: os.cpus()[0].model, cores: os.cpus().length, os: os.release(), arch: os.arch(), node: process.version },
    fixtures: {}, runs: [],
  };
  const matrix = profile.workloads.map((workload) => buildCase(workload, profile, scratch));
  for (const entry of matrix) report.fixtures[entry.workload] = entry.identity;
  const order = shuffledOrders();
  const save = () => {
    writeFileSync(outputPath + ".tmp", JSON.stringify(report));
    renameSync(outputPath + ".tmp", outputPath);
  };
  for (let repetition = 0; repetition < profile.repetitions; ++repetition) {
    for (const testCase of matrix) {
      for (const engine of order()) {
        const run = await campaign(engine, repetition, testCase, scratch, evidence);
        report.runs.push(run);
        save();
        const firstMismatch = run.samples.findIndex((sample) => sample.differences.length > 0);
        console.log(repetition + 1, testCase.workload, engine, run.ok ? "PASS" : "FAIL",
          run.samples.length, run.error ?? (firstMismatch >= 0 ? `first metric mismatch at ${firstMismatch}` : ""),
          `full ${run.fullGate.filter((entry) => entry.pass).length}/2`);
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  save();
  if (report.runs.some((run) => !run.ok)) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
