// A ticket a later autonomy turn re-runs by itself is nobody's to act on yet: the ledger tells the view it landed
// (`ok = true`, so a slot reads idle, not blocked) for every ending recorded `not landed` or `conflict` - and says
// nothing different for the rest, or when no turn will re-run it. Over fake ports; no Docker, no network.
//
//   pnpm test:file test/ledger-retried.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import type { TicketEnding } from "../src/ledger.ts";

// sandbox.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLedger } = await import("../src/ledger.ts");

const green = { issue: "2", branch: "agent/issue-2", status: "green", commits: 2, repairs: 1, head: "abc1234" };
const landing = (landed: Landed): TicketEnding => ({ kind: "landing", green, landed, attempts: 1 });
const found: TicketEnding = {
  kind: "conflict",
  outcome: { issue: "2", branch: "agent/issue-2", status: "conflict", conflict: { files: ["a.txt"], with: ["1"] }, commits: 1, repairs: 0, gates: [] },
  conflict: { files: ["a.txt"], with: ["1"] },
  attempts: 1,
};

const ENDINGS: [string, TicketEnding, string][] = [
  ["a landing that failed", landing({ kind: "not-landed", reason: "No space left on device" }), "failed to land"],
  ["a branch that moved after its gates", landing({ kind: "skipped", reason: "agent/issue-2 moved after its gates passed" }), "not merged"],
  ["a conflict at landing", landing({ kind: "conflict", files: ["a.ts"], with: ["1"] }), "merge conflict"],
  ["a conflict found before landing", found, "merge conflict"],
];

const record = (ending: TicketEnding, retried?: () => boolean) => {
  const views: [string, boolean, string][] = [];
  const ledger = createLedger({
    run: { ticket: () => {} },
    outcomes: () => {},
    view: { landed: (id, ok, word) => void views.push([id, ok, word]) },
    ...(retried && { retried }),
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  ledger.record("2", ending);
  return views;
};

for (const [name, ending, word] of ENDINGS) {
  test(`${name}: the view reads landed when a later turn re-runs it, and a person's when none does`, () => {
    assert.deepEqual(record(ending, () => true), [["2", true, word]]);
    assert.deepEqual(record(ending, () => false), [["2", false, word]]);
    assert.deepEqual(record(ending), [["2", false, word]], "no dependency: as before");
  });
}

test("an ending that is not `not landed` or `conflict` is not made idle by a retried ticket", () => {
  const held = landing({ kind: "held", by: "protected", paths: [".github/workflows/ci.yml"] } as Landed);
  assert.deepEqual(record(held, () => true), record(held, () => false));
  assert.equal(record(held, () => true)[0][1], false);
});

test("the retried question is asked about the ticket whose ending is recorded", () => {
  const asked: string[] = [];
  const views: unknown[] = [];
  const ledger = createLedger({
    run: { ticket: () => {} },
    outcomes: () => {},
    view: { landed: (...a) => void views.push(a) },
    retried: (id) => (asked.push(id), id === "7"),
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  ledger.record("6", ENDINGS[0][1]);
  ledger.record("7", ENDINGS[0][1]);
  assert.deepEqual(views, [["6", false, "failed to land"], ["7", true, "failed to land"]]);
  assert.deepEqual(asked, ["6", "7"]);
});
