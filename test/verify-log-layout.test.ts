// The verify log (the gates on the merged base) streams the layout of a ticket's gates log, unclipped, and a
// gates log holds no ANSI control sequences, so `grep "Test Files"` finds the summary line.
//
//   pnpm test:file test/verify-log-layout.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { runGates } = await import("../src/gates.ts");

const RED = "\u001b[31m";
const RESET = "\u001b[39m";

const gated = async (stdout: string[], stderr: string, exitCode = 1) => {
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "gates.log");
  const project = { name: "fixture", gates: [{ name: "unit", command: "run-unit" }] } as Parameters<typeof runGates>[0];
  const sandbox = {
    exec: async (_cmd: string, options?: { onLine?: (line: string) => void }) => {
      for (const line of stdout) options?.onLine?.(line);
      return { exitCode, stdout: stdout.join("\n"), stderr };
    },
  };
  await runGates(project, sandbox, "fixture verify", true, { log });
  return readFileSync(log, "utf8");
};

test("a gates log holds no colour codes, in stdout or stderr, so the summary line greps", async () => {
  const text = await gated([`${RED}Test Files${RESET}  1 failed (1)`, "     Tests  2 failed"], `${RED}FAIL${RESET} a.test.ts`);
  assert.ok(!text.includes("\u001b"), JSON.stringify(text));
  assert.match(text, /^Test Files {2}1 failed \(1\)$/m);
  assert.match(text, /^FAIL a\.test\.ts$/m);
});

test("a long gate output is kept whole, its summary at the end, with the gate's time", async () => {
  const body = Array.from({ length: 5000 }, (_, i) => `line ${i} of a long test run`);
  const text = await gated([...body, "Test Files  3 failed (9)"], "");
  assert.ok(!text.includes("characters cut"));
  assert.match(text, /^line 0 of a long test run$/m);
  assert.match(text, /^Test Files {2}3 failed \(9\)$/m);
  assert.match(text, /^# unit RED \(exit 1\) in \d/m);
});
