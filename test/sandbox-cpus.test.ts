// Each sandbox container gets a CPU limit: agents run the project's whole suite in their own
// sandboxes, outside `maxGates`, and several suites at once slowed every gate beside them. The
// limit is the VM's CPUs (`docker info`'s NCPU) divided by the run's concurrency, at least 2 and
// never more than the VM has; the project's `cpus` overrides it, `false` for none. No Docker here:
// `docker info` is handed in as made-up JSON.
//
//   node --test test/sandbox-cpus.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Before the kit's modules load: they read XDG_CONFIG_HOME once, for the credentials file.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { loadProject } = await import("../src/config.ts");
const { OperatorError } = await import("../src/errors.ts");
const { cpusLine, sandboxCpus } = await import("../src/sandbox.ts");

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-cpus-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const pool = { concurrency: 4, maxGates: 2 };
const info = (ncpu: number) => () => JSON.stringify({ NCPU: ncpu, MemTotal: 16 * 2 ** 30 });
let n = 0;
const load = (extra: string) => {
  const root = join(tmp, `p${n++}`);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }]${extra} };\n`);
  return loadProject(root);
};

test("12 CPUs at concurrency 4 give each sandbox 3", async () => {
  const project = await load("");
  assert.equal(sandboxCpus(project, "ticket", pool, info(12)), 3);
  assert.equal(cpusLine(project, 3, 3), "Sandbox CPUs: 3 each");
});

test("4 CPUs at concurrency 4 still give each sandbox 2", async () => {
  assert.equal(sandboxCpus(await load(""), "ticket", pool, info(4)), 2);
});

test("a one-CPU VM never gets a limit above what it has", async () => {
  assert.equal(sandboxCpus(await load(""), "ticket", pool, info(1)), 1);
});

test("the project's cpus wins over the VM's split", async () => {
  const project = await load(", cpus: 5");
  assert.equal(sandboxCpus(project, "ticket", pool, info(12)), 5);
  assert.equal(cpusLine(project, 5, 5), "Sandbox CPUs: 5 each (cpus in the project config)");
});

test("a project's cpus above the VM's CPUs is cut to what the VM has, which docker would otherwise refuse", async () => {
  const project = await load(", cpus: 16");
  assert.equal(sandboxCpus(project, "ticket", pool, info(8)), 8);
  assert.equal(cpusLine(project, 8, 8), "Sandbox CPUs: 8 each (cpus 16 in the project config, but the VM has 8)");
  assert.equal(sandboxCpus(project, "ticket", pool, () => undefined), 16, "with no CPU count to check against, the project's figure stands");
});

test("cpus: false sets no limit", async () => {
  const project = await load(", cpus: false");
  assert.equal(sandboxCpus(project, "ticket", pool, info(12)), undefined);
  assert.equal(cpusLine(project, undefined, undefined), "Sandbox CPUs: no limit (cpus: false)");
});

test("docker info failing sets no limit rather than a guess", async () => {
  const project = await load("");
  assert.equal(sandboxCpus(project, "ticket", pool, () => undefined), undefined);
  assert.equal(sandboxCpus(project, "ticket", pool, () => "not json"), undefined);
  assert.equal(sandboxCpus(project, "ticket", pool, () => "{}"), undefined);
  assert.equal(cpusLine(project, undefined, undefined), "Sandbox CPUs: no limit (docker info gave no CPU count)");
});

test("a cpus that is neither a positive number nor false is refused", async () => {
  for (const bad of ["0", "-2", '"4"', "true"]) {
    await assert.rejects(load(`, cpus: ${bad}`), (e: Error) => e instanceof OperatorError && /`cpus` must be a number of 0\.01 or more \(CPUs per sandbox\) or false/.test(e.message));
  }
});
