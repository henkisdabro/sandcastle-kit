// A ticket's gates log holds what each gate wrote to stderr as well as stdout (src/gates.ts): the sandbox
// streams stdout through `onLine` and returns stderr apart, and a test runner prints its failures there.
//
//   pnpm test:file test/gate-log-stderr.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { runGates } = await import("../src/gates.ts");
const { hideFromGates } = await import("../src/worktree-lock.ts");

type Answer = { exitCode: number; stdout: string[]; stderr: string };
// Each gate command answers with the first entry whose key it contains; stdout goes through `onLine`, as the
// real sandbox's does when it is given one.
const sandbox = (answers: [string, Answer][]) => ({
  exec: async (cmd: string, options?: { onLine?: (line: string) => void }) => {
    const hit = answers.find(([key]) => cmd.includes(key));
    if (!hit) return { exitCode: 0, stdout: "", stderr: "" };
    for (const line of hit[1].stdout) options?.onLine?.(line);
    return { exitCode: hit[1].exitCode, stdout: hit[1].stdout.join("\n"), stderr: hit[1].stderr };
  },
});

const gated = async (gates: { name: string; command: string }[], answers: [string, Answer][]) => {
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "gates.log");
  const project = { name: "fixture", gates } as Parameters<typeof runGates>[0];
  await runGates(project, sandbox(answers), "fixture gates", false, { log });
  return readFileSync(log, "utf8").split("\n");
};

test("a red gate's log holds its stdout, then its stderr under a marker, and ends on the verdict", async () => {
  const lines = await gated([{ name: "unit", command: "run-unit" }], [
    ["run-unit", { exitCode: 1, stdout: ["Test Files  2 failed", "     Tests  3 failed"], stderr: "FAIL a.test.ts\nTest timed out in 5000ms" }],
  ]);
  const at = lines.indexOf("Test Files  2 failed");
  assert.deepEqual(lines.slice(at, at + 5), [
    "Test Files  2 failed",
    "     Tests  3 failed",
    "# stderr of unit (at most its last 64 KiB):",
    "FAIL a.test.ts",
    "Test timed out in 5000ms",
  ]);
  const last = lines.filter(Boolean).at(-1) ?? "";
  assert.match(last, /^# unit RED \(exit 1\) in \d/);
});

test("a green gate's stderr is logged too, before its verdict line", async () => {
  const lines = await gated([{ name: "lint", command: "run-lint" }], [
    ["run-lint", { exitCode: 0, stdout: ["ok"], stderr: "warning: deprecated" }],
  ]);
  const marker = lines.indexOf("# stderr of lint (at most its last 64 KiB):");
  assert.ok(marker > 0, "no marker line");
  assert.equal(lines[marker + 1], "warning: deprecated");
  assert.match(lines.filter(Boolean).at(-1) ?? "", /^# lint green in /);
});

test("a gate with no stderr adds no marker line", async () => {
  const lines = await gated([{ name: "lint", command: "run-lint" }], [
    ["run-lint", { exitCode: 1, stdout: ["bad"], stderr: "" }],
  ]);
  assert.ok(!lines.some((l) => l.startsWith("# stderr of")), lines.join("\n"));
});

test("a credential in a gate's stderr is redacted in the log", async () => {
  hideFromGates(["not-a-real-value"]);
  const lines = await gated([{ name: "unit", command: "run-unit" }], [
    ["run-unit", { exitCode: 1, stdout: [], stderr: "printed: not-a-real-value" }],
  ]);
  const text = lines.join("\n");
  assert.ok(!text.includes("not-a-real-value"), text);
  assert.ok(text.includes("printed: <redacted>"), text);
});
