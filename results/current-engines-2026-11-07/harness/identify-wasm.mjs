import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.length !== 3) throw new Error("usage: node identify-wasm.mjs WASM_PACKAGE_DIR");
const packageDir = resolve(process.argv[2]);
const api = await import(pathToFileURL(resolve(packageDir, "pinewasm.js")));
api.initSync({ module: readFileSync(resolve(packageDir, "pinewasm_bg.wasm")) });
const version = api.version();
const expected = "20d6304ebe3faad6d14238eab79c6a03f42f7a2e";
if (version.sourceRevision !== expected || version.compilerVersion !== "21.1.0")
  throw new Error(`unexpected PineWASM identity: ${JSON.stringify(version)}`);
writeFileSync(resolve(packageDir, "identity.json"), JSON.stringify({ sourceRevision: expected, version }) + "\n");
