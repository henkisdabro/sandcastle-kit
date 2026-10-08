// Gate times print with one decimal under 10 s (src/gates.ts), against a
// made-up sandbox: its exec answers at once, so no Docker is needed.
//
//   pnpm test:file test/gate-timing.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { runGates, seconds } = await import("../src/gates.ts");

test("seconds: one decimal under 10 s, whole seconds from there", () => {
  assert.equal(seconds(0), "0.0s");
  assert.equal(seconds(400), "0.4s");
  assert.equal(seconds(3_140), "3.1s");
  assert.equal(seconds(9_960), "10s");
  assert.equal(seconds(12_400), "12s");
});

test("a green gate's log line carries a time with one decimal", async () => {
  const project = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }] } as Parameters<typeof runGates>[0];
  const box = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "progress.log");
  await runGates(project, box, "fixture gates", false, { log });
  assert.match(readFileSync(log, "utf8"), /^# \S+ green in \d\.\ds$/m);
});
