// A gate's opt-in `rerun` command: the red gate's in-slot re-run (and the third run after a re-run red on different
// tests) runs it, filled with the failing tests the kit read, in place of the gate's whole command; the failure `runGates`
// returns stays the first full run's, with the targeted run beside it (`Failure.rerun`). A fake sandbox records each
// command it is handed, as test/gates-rerun-keeps-slot.test.ts does: no Docker, model or network.
//
//   pnpm test:file test/gates-rerun-command.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, slots } from "./pool-sim.ts";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runGates, failureKey, flakedTests, threeRunsNote } = await import("../src/gates.ts");
type Gate = { name: string; command: string; rerun?: string };

afterEach(cleanup);

/** What the fake sandbox answers one gate command with: its exit code and output. */
type Answer = { exitCode: number; stdout?: string; stderr?: string };
const red = (...tests: string[]): Answer => ({ exitCode: 1, stdout: tests.map((t) => `FAILED ${t}`).join("\n") });
const GREEN: Answer = { exitCode: 0 };

const project = (gates: Gate[]) => ({ name: "fixture", gates }) as Parameters<typeof runGates>[0];
const PYTEST = (rerun?: string): Gate[] => [
  { name: "lint", command: "run-lint" },
  { name: "test", command: "pytest", ...(rerun ? { rerun } : {}) },
  { name: "build", command: "run-build" },
];

/** The command inside `execGate`'s `timeout ... sh -c '<command>'` wrapper. */
const unwrap = (cmd: string) => {
  const at = cmd.indexOf("sh -c '");
  return cmd.slice(at + "sh -c '".length, -1).replaceAll("'\\''", "'");
};

/** Answers the gate commands in order (green after the list ends); every other command (git) is a quiet success. */
const sandbox = (answers: Answer[]) => {
  const ran: string[] = [];
  const held: number[] = [];
  // Lock files of the gates pool: the lease the run holds (this test file is the pool's only user).
  const mine = () => readdirSync(slots).filter((f) => f.startsWith("gates-") && f.endsWith(".lock")).length;
  return {
    ran,
    held,
    exec: async (cmd: string) => {
      if (!cmd.startsWith("timeout ")) return { exitCode: 0, stdout: "", stderr: "" };
      ran.push(unwrap(cmd));
      held.push(mine());
      const a = answers[ran.length - 1] ?? GREEN;
      return { exitCode: a.exitCode, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
    },
  };
};

const A1 = "tests/a.py::t1";
const A2 = "tests/a.py::t2";
const B2 = "tests/b.py::t2";

test("a red pytest-style gate re-runs only its failing tests, quoted, in the same gates slot", async () => {
  const box = sandbox([GREEN, red(A1, B2), GREEN, GREEN]);
  const result = await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, undefined, true);
  assert.deepEqual(box.ran, ["run-lint", "pytest", `pytest '${A1}' '${B2}'`, "run-build"]);
  // One lease held by the first run and by its re-run alike.
  assert.deepEqual(box.held.slice(1, 3), [1, 1]);
  assert.equal(result.failure, undefined);
  assert.equal(result.rerunOf?.failure?.command, "pytest");
});

test("{files} gives each failing test's file once", async () => {
  const box = sandbox([red(A1, A2, B2), GREEN]);
  await runGates(project(PYTEST("pytest {files}")), box, "fixture gates", false, {}, false, "test", true);
  assert.equal(box.ran[1], "pytest 'tests/a.py' 'tests/b.py'");
});

test("a test id with a quote in it is quoted safely", async () => {
  const id = "tests/a.py::t[it's]";
  const box = sandbox([red(id), GREEN]);
  await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, "test", true);
  assert.equal(box.ran[1], "pytest 'tests/a.py::t[it'\\''s]'");
});

test("the full command re-runs when the gate has no rerun", async () => {
  const box = sandbox([red(A1), GREEN]);
  await runGates(project(PYTEST()), box, "fixture gates", false, {}, false, "test", true);
  assert.deepEqual(box.ran.slice(0, 2), ["pytest", "pytest"]);
});

test("the full command re-runs when the output may be cut", async () => {
  // Over half of the exec tail on stderr: a test missing from the list is not known to be green.
  const cut: Answer = { exitCode: 1, stdout: `FAILED ${A1}`, stderr: "x".repeat(5 * 1024 * 1024) };
  const box = sandbox([cut, GREEN]);
  await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, "test", true);
  assert.deepEqual(box.ran, ["pytest", "pytest", "run-build"]);
});

test("the full command re-runs when the output names no test", async () => {
  const box = sandbox([{ exitCode: 1, stdout: "boom" }, GREEN]);
  await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, "test", true);
  assert.deepEqual(box.ran.slice(0, 2), ["pytest", "pytest"]);
});

test("the full command re-runs when {files} meets an id that names no file", async () => {
  const box = sandbox([red("test_one", A1), GREEN]);
  await runGates(project(PYTEST("pytest {files}")), box, "fixture gates", false, {}, false, "test", true);
  assert.deepEqual(box.ran.slice(0, 2), ["pytest", "pytest"]);
  // {tests} takes the same ids as they are.
  const tests = sandbox([red("test_one", A1), GREEN]);
  await runGates(project(PYTEST("pytest {tests}")), tests, "fixture gates", false, {}, false, "test", true);
  assert.equal(tests.ran[1], `pytest 'test_one' '${A1}'`);
});

test("a targeted re-run red again returns the first full run's failure, with the targeted run beside it", async () => {
  const box = sandbox([red(A1, B2), { exitCode: 1, stdout: `FAILED ${B2}\nthe targeted output` }]);
  const result = await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, "test", true);
  const first = result.rerunOf?.failure;
  assert.ok(first && result.failure);
  assert.equal(result.failure.name, "test");
  assert.equal(result.failure.command, "pytest");
  assert.equal(result.failure.exitCode, 1);
  assert.equal(result.failure.output, `FAILED ${A1}\nFAILED ${B2}`);
  assert.deepEqual(result.failure.tests, [A1, B2]);
  assert.equal(failureKey(result.failure), failureKey(first));
  assert.deepEqual(result.failure.rerun, { command: `pytest '${A1}' '${B2}'`, tests: [B2] });
  assert.deepEqual(result.failures, [result.failure]);
  // The recorded first run has no `rerun`.
  assert.equal(first.rerun, undefined);
});

test("a test red in the first run and green in the targeted re-run is flaked", async () => {
  const box = sandbox([red(A1, A2), red(A1)]);
  const result = await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, "test", true);
  assert.deepEqual(flakedTests([result.rerunOf!.failure!, result.failure!], false), [A2]);
});

test("a third run after disjoint reds is filled from both reds' files, each once", async () => {
  const box = sandbox([red(A1), red(B2), GREEN]);
  const result = await runGates(project(PYTEST("pytest {files}")), box, "fixture gates", false, {}, false, "test", true, true);
  assert.deepEqual(box.ran.slice(0, 3), ["pytest", "pytest 'tests/a.py'", "pytest 'tests/a.py' 'tests/b.py'"]);
  assert.equal(result.failure, undefined);
});

test("a third run after disjoint reds is filled from both reds' test ids", async () => {
  const box = sandbox([red(A1, A2), red(B2), GREEN]);
  await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, "test", true, true);
  assert.deepEqual(box.ran.slice(0, 3), ["pytest", `pytest '${A1}' '${A2}'`, `pytest '${A1}' '${A2}' '${B2}'`]);
});

test("a red third run of the rerun command says the output below is the first run's", async () => {
  const box = sandbox([red(A1), red(B2), red("tests/c.py::t3")]);
  const result = await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, "test", true, true);
  const second = result.rerunOf!;
  const first = second.rerunOf!;
  assert.equal(result.failure?.output, `FAILED ${A1}`);
  assert.deepEqual(result.failure?.rerun?.tests, ["tests/c.py::t3"]);
  const note = threeRunsNote("test", [first.failure!, second.failure!, result.failure!]);
  assert.match(note, /the output below is the first run's/);
  assert.doesNotMatch(note, /the third run's only/);
  assert.match(note, new RegExp(`run 2: ${B2}`));
  assert.match(note, /run 3: tests\/c\.py::t3/);
});

test("the gates after the red one run their own commands", async () => {
  const box = sandbox([GREEN, red(A1), GREEN, GREEN]);
  await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, undefined, true);
  assert.deepEqual(box.ran.map((c) => c.split(" ")[0]), ["run-lint", "pytest", "pytest", "run-build"]);
  assert.equal(box.ran[3], "run-build");
});

test("a landing-style call, a re-run alone, uses rerun and starts no third run", async () => {
  const box = sandbox([red(A1), red(B2), GREEN]);
  const result = await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, true, "test", true);
  assert.deepEqual(box.ran, ["pytest", `pytest '${A1}'`]);
  assert.deepEqual(result.failure?.rerun, { command: `pytest '${A1}'`, tests: [B2] });
});

test("a targeted re-run that times out returns its own 124 failure and starts no third run", async () => {
  const box = sandbox([red(A1), { exitCode: 124, stdout: "partial" }, GREEN]);
  const result = await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, {}, false, "test", true, true);
  assert.equal(box.ran.length, 2);
  assert.equal(result.failure?.exitCode, 124);
  assert.match(result.failure?.output ?? "", /partial/);
  assert.equal(result.failure?.command, `pytest '${A1}'`);
  assert.equal(result.failure?.rerun, undefined);
});

test("the gates log shows the filled command and says it re-runs the failing tests", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "gates.log");
  const box = sandbox([red(A1), GREEN]);
  await runGates(project(PYTEST("pytest {tests}")), box, "fixture gates", false, { log }, false, "test", true);
  const text = readFileSync(log, "utf8");
  assert.match(text, /^\$ pytest   # gate 2\/3: test, /m);
  assert.match(text, new RegExp(`^\\$ pytest '${A1}'   # re-runs the failing tests of gate 2/3: test, `, "m"));
});
