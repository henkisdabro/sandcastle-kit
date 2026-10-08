// What a carried branch's lines call its source: "its first attempt" when this run requeued the
// ticket (the requeue-once state, the ledger's `requeuedAs`, is what burndown.ts asks),
// "an earlier run" for a branch kept from an earlier `sandcastle run`. No Docker, no git, no network.
//
//   pnpm test:file test/carried-wording.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { carriedBranch, carriedMergeLine, greenCarriedLine } = await import("../src/landing.ts");
const { createLedger } = await import("../src/ledger.ts");

const requeueRecord = () => {
  const said: string[] = [];
  const record = createLedger({
    run: { ticket: () => {} },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: (line) => void said.push(line),
  });
  return { record, said };
};

test("a requeued ticket's second attempt names its first attempt, not an earlier run", () => {
  const { record, said } = requeueRecord();
  record.requeued("139", { kind: "red", with: ["141", "142"] } as never);
  assert.equal(said.length, 1);
  const requeued = record.requeuedAs.has("139");
  assert.equal(requeued, true);

  assert.equal(
    greenCarriedLine("#139", "16bf0620000", requeued),
    "#139: reviewed and green at 16bf062 in its first attempt - no implement or full review; the gates decide.",
  );
  assert.equal(carriedMergeLine("#139", "main", 4, requeued), "#139: merged main (4 commit(s)) into its branch from its first attempt.");
  assert.equal(
    carriedMergeLine("#139", "main", 4, requeued, { files: ["a.lock", "b.lock"], regen: ["pnpm install"] }),
    "#139: merged main (4 commit(s)) into its branch from its first attempt; regenerated a.lock, b.lock with `pnpm install`.",
  );
  assert.equal(carriedBranch(false, requeued), "its branch from its first attempt");
  assert.equal(carriedBranch(true, requeued), "its green branch");
  for (const line of [greenCarriedLine("#139", "abc1234", requeued), carriedMergeLine("#139", "main", 1, requeued), carriedBranch(false, requeued)]) {
    assert.doesNotMatch(line, /earlier run/);
  }
});

test("a branch kept from an earlier run says so", () => {
  const { record } = requeueRecord();
  const requeued = record.requeuedAs.has("140");
  assert.equal(requeued, false);

  assert.equal(
    greenCarriedLine("#140", "16bf0620000", requeued),
    "#140: reviewed and green at 16bf062 in an earlier run - no implement or full review; the gates decide.",
  );
  assert.equal(carriedMergeLine("#140", "main", 2, requeued), "#140: merged main (2 commit(s)) into its branch from an earlier run.");
  assert.equal(
    carriedMergeLine("#140", "main", 2, requeued, { files: ["a.lock"], regen: ["pnpm install"] }),
    "#140: merged main (2 commit(s)) into its branch from an earlier run; regenerated a.lock with `pnpm install`.",
  );
  assert.equal(carriedBranch(false, requeued), "its branch from an earlier run");
});

test("a requeued ticket whose second attempt never began is a branch from an earlier run again", () => {
  const { record } = requeueRecord();
  record.requeued("141", { kind: "conflict", with: [] } as never);
  assert.equal(record.requeuedAs.has("141"), true);
  record.record("141", { kind: "landing", attempts: 1, green: { issue: "141", branch: "agent/issue-141", status: "green", commits: 1, repairs: 0 }, landed: { kind: "conflict", files: ["a"], with: [] } });
  assert.equal(record.requeuedAs.has("141"), false);
});
