// The ticket a plan limit cut short is recorded as it ends, with its own note (not started, runnable again, the reset
// time) - its row never reads as still working while the rest of the run finishes. The tickets the stop left unstarted
// keep the run's last words, the most severe cause: a `.git` change found after the limit heads them, not the limit.
// Driven through `createSchedule(plan).run(work)` with fake attempts and the real ledger (createLedger in
// src/ledger.ts) over a fake run record. No Docker, no model, no network.
//
//   pnpm test:file test/plan-limit-ledger.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLedger } = await import("../src/ledger.ts");
const { createSchedule } = await import("../src/schedule.ts");
type TicketRecord = import("../mod/hooks/run-record.ts").TicketRecord;

const LIMITED = "not started: the plan's usage limit stopped it (resets 2:10pm (UTC))";

/** 1's agent dies of the plan's limit; 2 and 3, behind it on the one worker, never begin. */
const limitRun = async () => {
  const records = new Map<string, TicketRecord>();
  const ledger = createLedger({
    run: { ticket: (id, fields) => void records.set(id, fields) },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  const { endings } = await createSchedule<{ id: string }, { issue: string }, unknown, string>({ tickets: ["1", "2", "3"].map((id) => ({ id })) }).run({
    workers: 1,
    attempt: async (t: { id: string }) => ({ kind: "crashed" as const, error: new Error("claude-code exited with code 1:"), causes: [{ kind: "plan limit" as const, ticket: t.id, resets: "2:10pm (UTC)" }] }),
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    // The fake greens carry only an issue: the ledger reads no more of an ending that never lands.
    tell: (c: unknown) => ledger.tell(c as never),
  } as never);
  return { records, ledger, endings };
};

test("the ticket the limit cut short is recorded as it ends; the unstarted ones wait for the run's last words", async () => {
  const { records, ledger, endings } = await limitRun();
  // Before the close: only 1 is written, already not started with its reset time.
  assert.deepEqual([...records.keys()], ["1"]);
  assert.deepEqual(records.get("1"), { state: "skipped", note: LIMITED });
  ledger.close(endings as never, "#1 hit the plan's usage limit (resets 2:10pm (UTC))");
  assert.deepEqual(records.get("1"), { state: "skipped", note: LIMITED });
  assert.deepEqual(records.get("2"), { state: "skipped", note: "not started: #1 hit the plan's usage limit (resets 2:10pm (UTC))" });
  assert.deepEqual(records.get("3"), { state: "skipped", note: "not started: #1 hit the plan's usage limit (resets 2:10pm (UTC))" });
});

test("a more severe cause than the limit heads the unstarted tickets' notes", async () => {
  const { records, ledger, endings } = await limitRun();
  ledger.close(endings as never, ".git/config changed while sandboxes ran");
  assert.deepEqual(records.get("1"), { state: "skipped", note: LIMITED });
  assert.deepEqual(records.get("2"), { state: "skipped", note: "not started: .git/config changed while sandboxes ran" });
  assert.deepEqual(records.get("3"), { state: "skipped", note: "not started: .git/config changed while sandboxes ran" });
});
