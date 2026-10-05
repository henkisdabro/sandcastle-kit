// A sandbox's CPU limit depends on what it is for. A ticket's sandbox (an agent works in it, and
// runs the suite as often as it likes) gets the VM's CPUs divided by the run's concurrency. A
// gate-only one - a landing, the base and verify gates, `sandcastle gates` and `land` - runs one
// gate pass on one worker, which sets the run's end, so it gets the VM's CPUs divided by `maxGates`.
// The project's own `cpus` overrides both, cut to the VM's CPUs. No Docker here: `docker info` is
// handed in as made-up JSON; test/sandbox-cpus-commands.test.ts runs the two commands themselves.
//
//   pnpm exec tsx --test test/sandbox-cpus-kinds.test.ts

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

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-cpus-kinds-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const info = (ncpu: number) => () => JSON.stringify({ NCPU: ncpu, MemTotal: 16 * 2 ** 30 });
let n = 0;
const load = (extra: string) => {
  const root = join(tmp, `p${n++}`);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }]${extra} };\n`);
  return loadProject(root);
};

test("12 CPUs, concurrency 5 and 2 gates: a ticket's sandbox gets 2, a landing, base or verify gate's 6", async () => {
  const project = await load("");
  const pool = { concurrency: 5, maxGates: 2 };
  const ticket = sandboxCpus(project, "ticket", pool, info(12));
  const gate = sandboxCpus(project, "gate", pool, info(12));
  assert.equal(ticket, 2);
  assert.equal(gate, 6);
  assert.equal(cpusLine(project, ticket, gate), "Sandbox CPUs: 2 each, 6 for landing and base gates");
});

test("a project's cpus above the VM's CPUs is cut to what the VM has, for a ticket's sandbox and a gate-only one", async () => {
  const project = await load(", cpus: 16");
  const pool = { concurrency: 4, maxGates: 2 };
  assert.equal(sandboxCpus(project, "ticket", pool, info(8)), 8);
  assert.equal(sandboxCpus(project, "gate", pool, info(8)), 8);
  assert.equal(cpusLine(project, 8, 8), "Sandbox CPUs: 8 each (cpus 16 in the project config, but the VM has 8)");
});

test("a project's cpus is the limit of both kinds, whatever the split", async () => {
  const project = await load(", cpus: 5");
  const pool = { concurrency: 4, maxGates: 2 };
  assert.equal(sandboxCpus(project, "ticket", pool, info(12)), 5);
  assert.equal(sandboxCpus(project, "gate", pool, info(12)), 5);
  assert.equal(cpusLine(project, 5, 5), "Sandbox CPUs: 5 each (cpus in the project config)");
  assert.equal(sandboxCpus(project, "gate", pool, () => undefined), 5, "with no CPU count to check against, the project's figure stands");
});

test("the start line says each limit once when the two kinds get the same", async () => {
  const project = await load("");
  const pool = { concurrency: 4, maxGates: 4 };
  assert.equal(cpusLine(project, sandboxCpus(project, "ticket", pool, info(12)), sandboxCpus(project, "gate", pool, info(12))), "Sandbox CPUs: 3 each");
});

test("a gate-only sandbox is never cut below 2 CPUs, nor above what the VM has", async () => {
  const project = await load("");
  // 4 CPUs shared by 4 gates would be 1 each.
  assert.equal(sandboxCpus(project, "gate", { concurrency: 1, maxGates: 4 }, info(4)), 2);
  assert.equal(sandboxCpus(project, "gate", { concurrency: 1, maxGates: 4 }, info(1)), 1);
  // One gate at a time on a 12-CPU VM is the whole VM.
  assert.equal(sandboxCpus(project, "gate", { concurrency: 1, maxGates: 1 }, info(12)), 12);
});

test("cpus: false sets no limit for either kind", async () => {
  const project = await load(", cpus: false");
  const pool = { concurrency: 4, maxGates: 2 };
  assert.equal(sandboxCpus(project, "ticket", pool, info(12)), undefined);
  assert.equal(sandboxCpus(project, "gate", pool, info(12)), undefined);
  assert.equal(cpusLine(project, undefined, undefined), "Sandbox CPUs: no limit (cpus: false)");
});

test("docker info giving no CPU count sets no limit for either kind rather than a guess", async () => {
  const project = await load("");
  const pool = { concurrency: 4, maxGates: 2 };
  for (const reading of [() => undefined, () => "not json", () => "{}"]) {
    assert.equal(sandboxCpus(project, "ticket", pool, reading), undefined);
    assert.equal(sandboxCpus(project, "gate", pool, reading), undefined);
  }
  assert.equal(cpusLine(project, undefined, undefined), "Sandbox CPUs: no limit (docker info gave no CPU count)");
});

test("a cpus below 0.01, which docker refuses, is refused at load with the key named", async () => {
  for (const bad of ["0.005", "0.0099"]) {
    await assert.rejects(load(`, cpus: ${bad}`), (e: Error) => e instanceof OperatorError && /`cpus` must be a number of 0\.01 or more \(CPUs per sandbox\) or false \(no limit\), not 0\.0/.test(e.message));
  }
});

test("a cpus of 0.01, the least docker accepts, and a fraction above it load", async () => {
  assert.equal((await load(", cpus: 0.01")).cpus, 0.01);
  assert.equal((await load(", cpus: 1.5")).cpus, 1.5);
});
