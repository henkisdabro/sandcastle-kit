// The run record's `retried` (the tickets a later autonomy turn re-runs by itself) and where `burndown()` hands it:
// the ledger and the Herdr TUI view. `burndown()` needs Docker, so its call sites are held by their source text.
//
//   pnpm test:file test/retried-wiring.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { recordRun } = await import("../src/run.ts");

test("the run record names its own not landed and conflict tickets as retried while a turn can follow", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-retried-run-"));
  const run = recordRun({ root, name: "fixture" } as never, { settings: { autonomy: "drain", turn: 1, cap: 5 } as never });
  // recordRun finishes its record in an exit handler: the directory goes after it.
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  run.ticket("1", { state: "not landed" });
  run.ticket("2", { state: "conflict" });
  run.ticket("3", { state: "merged" });
  assert.deepEqual([...run.retried()].sort(), ["1", "2"]);
  run.ticket("2", { state: "merged" });
  assert.deepEqual([...run.retried()], ["1"]);
});

test("burndown() hands the run's retried set to the ledger and to the Herdr TUI view", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /openSandboxView\([^\n]*run\.usage, run\.paused, run\.retried\)/);
  assert.match(source, /createLedger\(\{[^\n]*retried: \(id\) => run\.retried\(\)\.has\(id\)/);
});
