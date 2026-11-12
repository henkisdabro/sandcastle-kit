// The live line of a landing that did not land says why, and that a later turn retries it: a read
// timeout and a red gate read alike as "failed to land." before. Pure: fake ports, no git, no Docker.
//
//   pnpm test:file test/ledger-not-landed-cause.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";

// sandbox.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLedger } = await import("../src/ledger.ts");

const said = (landed: Landed, retried: boolean) => {
  const lines: string[] = [];
  const ledger = createLedger({
    run: { ticket: () => {} },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: (line) => void lines.push(line),
    retried: () => retried,
  });
  const green = { issue: "7", branch: "agent/issue-7", status: "green", commits: 1, repairs: 0, head: "abc1234" };
  ledger.record("7", { kind: "landing", green, landed, attempts: 1 });
  return lines;
};

test("a landing that failed says its cause and that a later turn retries it", () => {
  assert.deepEqual(said({ kind: "not-landed", reason: "gh issue view failed: no answer in 30 s" }, true), [
    "#7: failed to land: gh issue view failed: no answer in 30 s; a later turn retries it.",
  ]);
});

test("a landing that failed says its cause, with no retry when no later turn retries it", () => {
  assert.deepEqual(said({ kind: "not-landed", reason: "gh issue view failed: no answer in 30 s" }, false), [
    "#7: failed to land: gh issue view failed: no answer in 30 s.",
  ]);
});

test("a landing that was skipped says why it was not merged", () => {
  assert.deepEqual(said({ kind: "skipped", reason: "its ticket was closed" }, false), ["#7: not merged: its ticket was closed."]);
});
