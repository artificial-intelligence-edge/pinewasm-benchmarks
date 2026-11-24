import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const resultsDir = dirname(fileURLToPath(import.meta.url));
const bundle = realpathSync(resolve(resultsDir, "../.."));
const pineWasmRevision = "20d6304ebe3faad6d14238eab79c6a03f42f7a2e";
const pineForgeRevision = "59f98ba80e69a624f97ada11935e1bc973fd0e19";
const corpusRevision = "5759bf2813862886b0661df2f864381598039e4b";
const corpusFeedDigest = "c4e3aafade38e399e65a674b1b8ee8e877d769a8714284adfb0afa6a1beb75c6";
const eigenDigest = "8586084f71f9bde545ee7fa6d00288b264a2b7ac3607b974e54d13e7162c1c72";
const jobs = String(Math.min(8, availableParallelism()));

const usage = `Usage: node results/current-engines-2026-11-07/bench.mjs [command] [options]

  verify    Check archived files and recompute the published results offline (default)
  smoke     Build pinned engines and check the four synthetic workloads
  campaign  Run the four-engine prepared benchmark after a smoke check
  long      Run the 65,536-bar comparison after a smoke check
  pinets    Replay the end-to-end JavaScript-engine comparison with the pinned builds
  corpus    Replay the 100-strategy comparison with the pinned builds

  --pinewasm-source DIR   Fetch the pinned revision from a local Git checkout
  --scratch-root DIR      Use an existing trusted directory for the new workspace
  --help                  Show this help`;

function run(program, args, { allow = [0], captureOutput = false, ...options } = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit",
    ...options,
  });
  if (result.error) throw new Error(`Could not run ${program}: ${result.error.message}`);
  if (!allow.includes(result.status)) throw new Error(`${program} exited with ${result.signal ?? result.status}`);
  return result;
}

const node = (script, args, options) => run(process.execPath, [script, ...args], options);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path) => JSON.parse(path.endsWith(".gz") ? gunzipSync(readFileSync(path)) : readFileSync(path));
const speedup = (ratio) => `${ratio.toFixed(1)}×`;

function verifiedFiles() {
  const paths = new Set();
  for (const line of readFileSync(join(resultsDir, "SHA256SUMS"), "utf8").trimEnd().split("\n")) {
    const entry = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(entry, "Invalid SHA256SUMS entry");
    const file = realpathSync(resolve(resultsDir, entry[2]));
    const name = relative(bundle, file);
    assert.ok(name && name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name), "Checksum target leaves the bundle");
    assert.ok(!paths.has(name), `Duplicate checksum entry for ${entry[2]}`);
    assert.equal(sha256(file), entry[1], `Checksum mismatch for ${entry[2]}`);
    paths.add(name);
  }
  return paths;
}

function corpusSummary(path) {
  const { completedAt, feed, slots } = readJson(path);
  assert.ok(completedAt);
  assert.equal(feed.sha256, corpusFeedDigest);
  assert.equal(slots.length, 100);
  assert.equal(new Set(slots.map((slot) => slot.slot)).size, 100);
  const median = (values) => {
    assert.equal(values.length, 20);
    assert.ok(values.every((value) => Number.isFinite(value) && value > 0));
    const ordered = [...values].sort((a, b) => a - b);
    return (ordered[9] + ordered[10]) / 2;
  };
  const ratios = slots.filter((slot) => slot.timed).map((slot) => {
    assert.equal(slot.matched, true);
    assert.equal(slot.agreement.tier, "exact");
    assert.equal(slot.equity.pass, true);
    return median(slot.pineforge.ms) / median(slot.pinewasm.ms);
  });
  const ratio = ratios.length ? Math.exp(ratios.reduce((sum, value) => sum + Math.log(value), 0) / ratios.length) : null;
  return { eligible: ratios.length, total: slots.length, speedup: ratio };
}

function verify(paths) {
  const bound = (name) => {
    const path = join(resultsDir, name);
    assert.ok(paths.has(relative(bundle, path)), `Missing checksum for ${name}`);
    return path;
  };
  for (const [profile, script] of [
    ["campaign", "verify.mjs"], ["long", "verify.mjs"], ["pinets-cold", "verify-pinets-cold.mjs"],
  ]) {
    const actual = node(bound(`harness/${script}`), [bound(`data/${profile}.json.gz`)], { captureOutput: true }).stdout;
    const result = JSON.parse(actual);
    assert.deepEqual(result, readJson(bound(`data/${profile}-summary.json`)), `Summary mismatch for ${profile}`);
    if (profile === "pinets-cold") console.log(`End-to-end comparison: ${speedup(result.endToEndSpeedup)}`);
    else console.log(`${profile}: ${Object.entries(result.speedup).map(([engine, ratio]) => `${engine} ${speedup(ratio)}`).join(", ")}`);
  }
  const corpus = corpusSummary(bound("data/corpus.json.gz"));
  assert.equal(corpus.eligible, 22);
  assert.equal(speedup(corpus.speedup), "7.2×");
  console.log(`100-strategy comparison: ${speedup(corpus.speedup)} on ${corpus.eligible} of ${corpus.total} slots`);
  console.log(`Verified ${paths.size} checksums and recomputed the archived results.`);
}

function freshWorkspace(root) {
  const path = realpathSync(root);
  // The pinned Wasm build requires stable ancestors, including its Cargo configuration.
  for (let dir = path; ; dir = dirname(dir)) {
    const info = statSync(dir);
    if (!info.isDirectory() || info.mode & 0o022 || (info.uid !== 0 && info.uid !== process.getuid()))
      throw new Error("Choose --scratch-root inside a trusted directory writable only by you or an administrator.");
    if (dir === dirname(dir)) break;
  }
  if (/[^A-Za-z0-9/_.-]/.test(path))
    throw new Error("Choose a scratch root with letters, digits, slashes, periods, underscores or hyphens.");
  const work = mkdtempSync(join(path, "pine-engine-bench-"));
  console.log(`Working directory: ${work}`);
  return work;
}

function copyHarness(paths, work) {
  const checkout = join(work, "benchmark");
  const pathFromRoot = relative(bundle, resultsDir);
  const prefixes = [
    join(pathFromRoot, "harness"), join("results", "aot-showcase-2026-10-25", "harness"),
    join("benchmarks", "workloads"),
  ];
  for (const file of paths) {
    if (!prefixes.some((prefix) => file.startsWith(prefix + sep))) continue;
    const target = join(checkout, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(bundle, file), target);
  }
  return join(checkout, pathFromRoot, "harness");
}

function buildWasm(work, harness, source) {
  const pineWasm = join(work, "pinewasm");
  run("git", ["init", "--quiet", pineWasm]);
  run("git", ["-C", pineWasm, "fetch", "--depth=1", "--no-tags", source, pineWasmRevision]);
  run("git", ["-C", pineWasm, "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  assert.equal(run("git", ["-C", pineWasm, "rev-parse", "HEAD"], { captureOutput: true }).stdout.trim(), pineWasmRevision);
  const cargoHome = join(work, "cargo-home");
  mkdirSync(cargoHome);
  run("cargo", ["xtask", "wasm"], { cwd: pineWasm, env: { ...process.env, CARGO_HOME: cargoHome } });
  const wasm = join(pineWasm, "target/wasm-pkg");
  node(join(harness, "identify-wasm.mjs"), [wasm]);
  return wasm;
}

function fetchCorpusInputs(source, paths) {
  const manifest = join(resultsDir, "corpus-inputs.json");
  assert.ok(paths.has(relative(bundle, manifest)), "Missing corpus input manifest checksum");
  const inputs = readJson(manifest);
  assert.equal(inputs["data/ETHUSDT_15.csv"], corpusFeedDigest);
  const gitlink = run("git", ["-C", source, "ls-tree", "HEAD", "benchmarks/assets"], { captureOutput: true });
  assert.equal(gitlink.stdout.trim(), `160000 commit ${corpusRevision}\tbenchmarks/assets`);
  const base = `https://raw.githubusercontent.com/pineforge-4pass/pineforge-benchmarks-assets/${corpusRevision}`;
  for (const [file, digest] of Object.entries(inputs)) {
    const strategyInput = /^strategies\/[0-9]{3}-[a-z0-9-]+\/(?:generated\.cpp|strategy\.pine|inputs\.json)$/.test(file);
    assert.ok(strategyInput || file === "strategies/CMakeLists.txt" || file === "data/ETHUSDT_15.csv",
      `Unexpected strategy input: ${file}`);
    assert.match(digest, /^[0-9a-f]{64}$/);
    const target = join(source, "benchmarks/assets", file);
    mkdirSync(dirname(target), { recursive: true });
    run("curl", ["--disable", "--fail", "--silent", "--show-error", "--retry", "2",
      "--output", target, `${base}/${file}`]);
    assert.equal(sha256(target), digest, `Corpus input checksum mismatch: ${file}`);
  }
}

function buildPineForge(work, harness, corpus, paths) {
  const source = join(work, "pineforge");
  run("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--no-recurse-submodules", "--depth=1", "--branch", "v1.10.0",
    "https://github.com/pineforge-4pass/pineforge-engine.git", source]);
  assert.equal(run("git", ["-C", source, "rev-parse", "HEAD"], { captureOutput: true }).stdout.trim(), pineForgeRevision);
  const archive = join(work, "eigen.tar.gz");
  run("curl", ["--fail", "--silent", "--show-error", "--location", "--retry", "2", "--output", archive,
    "https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz"]);
  assert.equal(sha256(archive), eigenDigest, "Eigen 3.4.0 archive checksum");
  run("tar", ["-xzf", archive, "-C", work]);

  const build = join(work, "forge-build");
  const options = [
    "-DCMAKE_BUILD_TYPE=Release", "-DPINEFORGE_BUILD_TESTS=OFF", "-DPINEFORGE_BUILD_TUTORIAL=OFF",
    "-DCMAKE_DISABLE_FIND_PACKAGE_Eigen3=TRUE", `-DFETCHCONTENT_SOURCE_DIR_EIGEN=${join(work, "eigen-3.4.0")}`,
  ];
  if (corpus) {
    fetchCorpusInputs(source, paths);
    const shim = join(work, "corpus-retention.o");
    run("c++", ["-std=c++17", "-fPIC", "-c", join(harness, "pineforge-corpus-retention.cpp"), "-o", shim]);
    options.push("-DPINEFORGE_BUILD_BENCH_STRATEGIES=ON", `-DCMAKE_SHARED_LINKER_FLAGS=${shim}`);
  }
  run("cmake", ["-S", source, "-B", build, "-G", "Ninja", ...options]);
  run("cmake", ["--build", build, "--target", corpus ? "bench_strategies" : "pineforge", "--parallel", jobs]);
  const worker = join(work, "pineforge-worker");
  const files = corpus ? [join(harness, "pineforge-corpus.cpp")] : [
    join(harness, "pineforge.cpp"), join(build, "lib/libpineforge.a"),
  ];
  run("c++", ["-std=c++17", "-O3", "-ffp-contract=off", `-I${join(source, "include")}`,
    `-I${join(build, "include")}`, ...files, "-o", worker]);
  return { source, worker };
}

function installPineTS(work, harness) {
  const npm = join(work, "npm");
  mkdirSync(npm);
  for (const file of ["package.json", "package-lock.json"])
    copyFileSync(join(harness, "npm", file), join(npm, file));
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"], { cwd: npm });
  return join(npm, "node_modules");
}

function installPyneCore(work, harness) {
  const venv = join(work, "python");
  run("python3.12", ["-m", "venv", venv]);
  const python = join(venv, "bin/python");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PIP_")));
  run(python, ["-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--no-deps",
    "--index-url", "https://pypi.org/simple", "-r", join(harness, "pynecore-requirements.txt")],
  { env: { ...env, PIP_CONFIG_FILE: "/dev/null" } });
  return python;
}

function reproduce(mode, options, paths) {
  assert.ok(["darwin", "linux"].includes(process.platform), "Benchmark builds require macOS or Linux");
  const required = ["git", "cargo", "rustup"];
  if (mode !== "corpus") required.push("npm");
  if (mode !== "pinets") required.push("cmake", "ninja", "c++", "curl", "tar");
  if (["smoke", "campaign", "long"].includes(mode)) required.push("python3.12");
  const missing = required.filter((tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status !== 0);
  if (missing.length) throw new Error(`Install the required tools first: ${missing.join(", ")}`);
  const source = options["pinewasm-source"] ? realpathSync(options["pinewasm-source"])
    : "https://github.com/artificial-intelligence-edge/PineWASM.git";
  const work = freshWorkspace(options["scratch-root"] ?? tmpdir());
  const harness = copyHarness(paths, work);
  const output = join(work, "results");
  mkdirSync(output);
  const env = { ...process.env, PINEWASM_PKG_MAIN: buildWasm(work, harness, source) };
  delete env.WORKER_FLAGS;
  if (mode !== "corpus") env.ENGINE_NODE_MODULES = installPineTS(work, harness);
  if (mode !== "pinets") {
    const forge = buildPineForge(work, harness, mode === "corpus", paths);
    if (mode === "corpus") {
      env.PINEFORGE_CHECKOUT = forge.source;
      env.PINEFORGE_CORPUS_WORKER = forge.worker;
    } else {
      env.PINEFORGE_WORKER = forge.worker;
      env.PYNE_PYTHON = installPyneCore(work, harness);
    }
  }

  const file = join(output, `${mode}.json`);
  let summary;
  if (mode === "pinets") {
    node(join(harness, "pinets-cold.mjs"), [file], { env });
    summary = node(join(harness, "verify-pinets-cold.mjs"), [file], { captureOutput: true }).stdout;
  } else if (mode === "corpus") {
    node(join(harness, "corpus.mjs"), [file], { env });
    summary = JSON.stringify(corpusSummary(file), null, 2) + "\n";
  } else {
    const runner = join(harness, "campaign.mjs");
    if (mode !== "smoke")
      node(runner, ["smoke", join(output, "smoke.json"), join(work, "smoke")], { env });
    const measured = node(runner, [mode, file, join(work, mode)], { env, allow: [0, 2] });
    summary = node(join(harness, "verify.mjs"), [file], { captureOutput: true }).stdout;
    process.exitCode = measured.status;
  }
  const summaryPath = join(output, `${mode}-summary.json`);
  writeFileSync(summaryPath, summary);
  console.log(`Raw results: ${file}\nSummary: ${summaryPath}`);
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean" }, "pinewasm-source": { type: "string" }, "scratch-root": { type: "string" } },
  });
  if (values.help) {
    console.log(usage);
  } else {
    const mode = positionals[0] ?? "verify";
    assert.ok(positionals.length <= 1 && ["verify", "smoke", "campaign", "long", "pinets", "corpus"].includes(mode), usage);
    assert.ok(mode !== "verify" || !Object.keys(values).length, "verify takes no options");
    assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "Use Node.js 22 or later");
    const paths = verifiedFiles();
    if (mode === "verify") verify(paths);
    else reproduce(mode, values, paths);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
