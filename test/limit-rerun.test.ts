// A pass re-run after the plan's limit appends to the same log. When that re-run crashes early for
// another reason, the crash's limit check must read only what the re-run wrote, or the old limit
// message stops the queue for "plan limit" again. Temp dirs only; no Docker, no model calls.
//
//   node --test test/limit-rerun.test.ts

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { hitLimit, passStarts } = await import("../src/burndown.ts");

const root = mkdtempSync(join(tmpdir(), "sandcastle-limit-rerun-"));
after(() => rmSync(root, { recursive: true, force: true }));
const logs = join(root, ".sandcastle/logs");
mkdirSync(logs, { recursive: true });
const name = "agent-issue-7-impl-7.log";
const log = join(logs, name);

test("a crash after a re-run reads only the re-run's lines, not the limit message before it", () => {
  writeFileSync(log, "Bash(pnpm test)\nAgent error: You've reached your usage limit\n");
  assert.equal(hitLimit(root, "7"), true, "the first pass did hit the limit");
  // The re-run starts where the first pass ended, and fails early for another reason.
  passStarts.set(name, Buffer.byteLength("Bash(pnpm test)\nAgent error: You've reached your usage limit\n"));
  appendFileSync(log, "# run 2\nAgent error: sandbox exited 137\n");
  assert.equal(hitLimit(root, "7"), false);
});

test("a log with no recorded start is read whole, as before", () => {
  passStarts.clear();
  writeFileSync(log, "Agent error: You've reached your usage limit\n");
  assert.equal(hitLimit(root, "7"), true);
});
