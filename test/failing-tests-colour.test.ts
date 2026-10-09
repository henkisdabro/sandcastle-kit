// failingTests and runGates against a coloured vitest run: vitest colours its output when it has no TTY and no
// NO_COLOR, and a workspace project puts a label after FAIL. Pure string parsing and a made-up sandbox, so it
// behaves the same on macOS and Linux.
//
//   pnpm test:file test/failing-tests-colour.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { failingTests, runGates } = await import("../src/gates.ts");

const COLOURED = "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/a.test.ts > adds";

test("a coloured vitest FAIL line names its file", () => {
  assert.deepEqual(failingTests(COLOURED), ["src/a.test.ts"]);
});

test("a vitest workspace project's label is not the test id, with or without colour", () => {
  assert.deepEqual(failingTests(" FAIL  |web| src/a.test.ts > adds"), ["src/a.test.ts"]);
  assert.deepEqual(failingTests(" FAIL   web  src/a.test.ts > adds"), ["src/a.test.ts"]);
  assert.deepEqual(failingTests("\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m \x1b[43m web \x1b[49m src/a.test.ts > adds"), ["src/a.test.ts"]);
});

test("a vitest project named after a scoped package is not the test id", () => {
  assert.deepEqual(failingTests(" FAIL   @acme/web  src/a.test.ts > adds"), ["src/a.test.ts"]);
  assert.deepEqual(failingTests(" FAIL  |@acme/web| src/a.test.ts > adds"), ["src/a.test.ts"]);
  assert.deepEqual(failingTests("\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m \x1b[43m @acme/web \x1b[49m src/a.test.ts > adds"), ["src/a.test.ts"]);
});

test("a tab-separated Go package line still names the package, not its duration", () => {
  assert.deepEqual(failingTests("FAIL\tmymod\t0.004s"), ["mymod"]);
});

test("a red gate's coloured stderr reaches the failure as plain text that names the file", async () => {
  const project = { name: "fixture", gates: [{ name: "test", command: "run-tests" }] } as Parameters<typeof runGates>[0];
  const box = {
    exec: async (cmd: string) => {
      if (cmd.includes("run-tests")) return { exitCode: 1, stdout: "", stderr: `${COLOURED}\n` };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const run = await runGates(project, box, "fixture gates");
  const output = run.failure?.output ?? "";
  assert.ok(output.includes("FAIL"), "the failure kept the FAIL line");
  assert.ok(!output.includes("\x1b"), "an escape code reached the failure output");
  assert.deepEqual(failingTests(output), ["src/a.test.ts"]);
});
