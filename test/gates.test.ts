// Hook tests and gate runs (src/gates.ts) against a made-up sandbox: its
// exec answers from a table, so no Docker is needed.
//
//   pnpm exec tsx --test test/gates.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { failureKey, gateLine, gateResultLines, runGates, runHookTests } = await import("../src/gates.ts");

type Result = { exitCode: number; stdout: string; stderr: string };
// Each command answers with the first entry whose key it contains.
const sandbox = (answers: [string, Partial<Result>][]) => {
  const ran: string[] = [];
  return {
    ran,
    exec: async (cmd: string) => {
      ran.push(cmd);
      if (cmd === "pwd") return { exitCode: 0, stdout: "/home/agent/workspace\n", stderr: "" };
      const hit = answers.find(([key]) => cmd.includes(key));
      return { exitCode: 0, stdout: "", stderr: "", ...hit?.[1] };
    },
  };
};

const guard = (command: string) => ({ event: "PreToolUse", matcher: "Bash", command });
const allowTest = { name: "plain command", tool: "Bash", input: { command: "ls" }, expect: "allow" as const };
const blockTest = { name: "force push", tool: "Bash", input: { command: "git push -f" }, expect: "block" as const };

test("an allow test fails when a matching guard errors: the guard is dead, not allowing", async () => {
  const [r] = await runHookTests([allowTest], [guard("node guard-a.js"), guard("node guard-b.js")], sandbox([
    ["guard-b.js", { exitCode: 1, stderr: "Error: Cannot find module 'zod'" }],
  ]));
  assert.equal(r.pass, false);
  assert.match(r.detail, /errored .*guard-b\.js exited 1: Error: Cannot find module 'zod'/);
});

test("an allow test passes when every matching guard exits 0", async () => {
  const [r] = await runHookTests([allowTest], [guard("node guard-a.js")], sandbox([]));
  assert.equal(r.pass, true);
});

test("a block test passes on exit 2 or a JSON deny, and fails when every guard lets it through", async () => {
  const exit2 = await runHookTests([blockTest], [guard("node guard-a.js")], sandbox([["guard-a.js", { exitCode: 2 }]]));
  assert.equal(exit2[0].pass, true);
  const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } });
  const json = await runHookTests([blockTest], [guard("node guard-a.js")], sandbox([["guard-a.js", { stdout: deny }]]));
  assert.equal(json[0].pass, true);
  const open = await runHookTests([blockTest], [guard("node guard-a.js")], sandbox([["guard-a.js", { exitCode: 1 }]]));
  assert.equal(open[0].pass, false);
  assert.match(open[0].detail, /fails open/);
});

test("running every gate still stops at one that timed out", async () => {
  const project = {
    name: "fixture",
    gates: [
      { name: "lint", command: "run-lint" },
      { name: "test", command: "run-tests" },
      { name: "build", command: "run-build" },
    ],
  } as Parameters<typeof runGates>[0];
  const box = sandbox([["run-tests", { exitCode: 124 }]]);
  const run = await runGates(project, box, "fixture gates", true);
  assert.deepEqual(run.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", false]]);
  assert.ok(!box.ran.some((c) => c.includes("run-build")), "build ran beside a timed-out test gate");
  // The first gate command, not the first command the sandbox saw: the memory read as the pass starts comes before it.
  assert.match(box.ran.find((c) => c.includes("run-lint")) ?? "", /^timeout -k \d+ /);
  // Said as a timeout wherever the operator reads it, not as a bare exit 124.
  assert.equal(gateLine(run.gates), "lint=pass test=TIMEOUT");
  assert.match(run.failure?.output ?? "", /^The gate timed out after 45 min and was stopped/);
  assert.match(gateResultLines(project.gates, run.gates)[1], /^ {2}TIMEOUT {2}test {2}\$ run-tests$/);
});

test("a repair that turns up a different failure is told apart, even when no line says fail or error", () => {
  const count = { name: "readme", output: "README.md's export count marker says 12, but src/text.js exports 13." };
  const trailer = { name: "readme", output: "The branch's last commit has no `Gate-Checked: yes` trailer." };
  assert.notEqual(failureKey(count), failureKey(trailer));
  // The same failure with other numbers (a duration, a count) is the same one.
  assert.equal(failureKey(count), failureKey({ ...count, output: count.output.replace("12", "14").replace("13", "15") }));
  // With fail/error lines, only those count: the noise around them does not.
  assert.equal(failureKey({ name: "t", output: "run 1\nFAIL a.test" }), failureKey({ name: "t", output: "run 2 took 9s\nFAIL a.test" }));
});
