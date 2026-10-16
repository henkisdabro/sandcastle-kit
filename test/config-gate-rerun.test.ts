// A gate's `rerun` is opt-in and must name `{tests}` or `{files}`: without either it would re-run the same thing every time
// (`pytest --lf` is no substitute for the failing ids). Refused at config load, with both placeholders named; the config
// `sandcastle init` writes carries a commented example of it.
//
//   pnpm test:file test/config-gate-rerun.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing init.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { loadProject } = await import("../src/config.ts");
const { OperatorError } = await import("../src/errors.ts");
const { init } = await import("../src/init.ts");

const load = (gate: string) => {
  const root = mkdtempSync(join(tmpdir(), "sc-config-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [${gate}] };\n`);
  return loadProject(root);
};
const refused = async (gate: string, message: RegExp) => {
  await assert.rejects(load(gate), (e: Error) => e instanceof OperatorError && message.test(e.message));
};

test("a rerun with neither {tests} nor {files} is refused, naming both", async () => {
  await refused('{ name: "test", command: "pytest", rerun: "pytest --lf" }', /gate `test`: `rerun` must name \{tests\}.* or \{files\}/);
});

test("a rerun that is not a non-empty string is refused", async () => {
  await refused('{ name: "test", command: "pytest", rerun: 3 }', /`rerun` must be a non-empty string that names \{tests\} or \{files\}/);
  await refused('{ name: "test", command: "pytest", rerun: "" }', /`rerun` must be a non-empty string/);
  await refused('{ name: "test", command: "pytest", rerun: ["pytest {tests}"] }', /`rerun` must be a non-empty string/);
});

test("a rerun naming {tests} or {files} loads, and a gate without one still does", async () => {
  const p = await load('{ name: "lint", command: "ruff check ." }, { name: "test", command: "pytest", rerun: "pytest {tests}" }, { name: "unit", command: "pytest", rerun: "pytest {files} -x" }');
  assert.deepEqual(p.gates.map((g) => g.rerun), [undefined, "pytest {tests}", "pytest {files} -x"]);
});

test("init writes a commented rerun example into the gates of a new project", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest" } }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  t.mock.method(console, "log", () => {});
  init(root);
  const config = readFileSync(join(root, ".sandcastle/config.ts"), "utf8");
  assert.match(config, /^ {4}\/\/ \{ name: "test", command: "pytest", rerun: "pytest \{tests\}" \},$/m);
  assert.match(config, /^ {4}\/\/ Optional `rerun`:.*\{tests\}.*\{files\}/m);
});
