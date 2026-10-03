// A green suite's output carries no line of the kit's own making - no FAIL or WARNING line, no
// `[dry run]` or `Archived` line, no git stderr: the tests that drive such output capture it, so a
// person reading a red gate log skips nothing but node:test's own result lines.
//
//   pnpm exec tsx --test test/quiet-output.test.ts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runNode } from "./cli-spawn.ts";

const kit = fileURLToPath(new URL("..", import.meta.url));

// node:test's reporter lines: a result (pass, fail, skip, cancel), a suite or the ℹ summary.
const reporterLine = /^\s*[✔✖﹣▶ℹ]/;

const files = [
  "test/backup-branches.test.ts",
  "test/land-command.test.ts",
  "test/landing.test.ts",
  "test/lean.test.ts",
  "test/preflight-parallel.test.ts",
  "test/raw-log.test.ts",
  "test/release-dependants.test.ts",
  "test/ticket-model.test.ts",
];

for (const file of files) {
  test(`${file} prints nothing but the reporter's lines`, () => {
    // Inside a test run, NODE_TEST_CONTEXT makes a nested run hand its output to the parent; drop it
    // so the child prints as it would on its own.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // Spec named: Node 22 defaults a piped run to TAP, whose every line the pattern above would refuse.
    const r = runNode(["--test", "--test-reporter=spec", file], { cwd: kit, env, encoding: "utf8", timeoutMs: 180_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const noisy = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.trim() !== "" && !reporterLine.test(l));
    assert.deepEqual(noisy, []);
  });
}
