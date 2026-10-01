// The per-gate result lines `sandcastle gates` and a run's base check print
// (src/gates.ts): each gate's command next to its verdict.
//
//   pnpm exec tsx --test test/gate-commands.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gateResultLines } = await import("../src/gates.ts");

test("a run that stopped early prints one line per result, matched to its command by position", () => {
  const configured = [
    { name: "lint", command: "pnpm run lint" },
    { name: "test", command: "pnpm test" },
    { name: "build", command: "pnpm run build" },
  ];
  assert.deepEqual(
    gateResultLines(configured, [
      { name: "lint", pass: true },
      { name: "test", pass: false },
    ]),
    ["  pass  lint  $ pnpm run lint", "  FAIL  test  $ pnpm test"],
  );
});

test("a command with quotes and && is printed verbatim", () => {
  const command = `cd "site dir" && npm run check -- --grep 'a && b'`;
  assert.deepEqual(gateResultLines([{ name: "check", command }], [{ name: "check", pass: true, ms: 1200 }]), [
    `  pass  check  $ ${command}`,
  ]);
});
