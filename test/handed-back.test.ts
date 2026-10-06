// A ticket the agent handed back through the tracker (GitHub: hold label on, queue label off) ends
// its pipeline with no commits. The attempt reads the hand-back as that pipeline ends (burndown's
// `handBack`), so the ending arrives complete and the ledger records it once: before, it was
// patched in after the schedule. The record, the outcome and the view's word are the ones a run
// wrote then. Each test drives `createSchedule` with burndown's attempt report (`attempted`) and the
// real ledger over memory. No Docker, no gh, no network.
//
//   node --test test/handed-back.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Outcome as Said, TicketRecord } from "../mod/hooks/run-record.ts";

// sandbox.ts and pool.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { attempted, handBack } = await import("../src/burndown.ts");
const { createLedger } = await import("../src/ledger.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Outcome = Parameters<typeof attempted>[1] extends PromiseSettledResult<infer O> ? O : never;
type Tracker = Parameters<typeof handBack>[1];

const NO_CHANGE: Outcome = { issue: "4", branch: "agent/issue-4", status: "nochange", commits: 0, reviewCommits: 0, repairs: 0, gates: [] };

// The tracker as the attempt reads it: one ticket, held or not, or unreadable.
const tracker = (held: boolean | "unreadable", agentsWrite = true): Tracker => ({
  agentsWrite,
  get: (id) => {
    if (held === "unreadable") throw new Error("gh: HTTP 502");
    return { id, title: "Ask a question", body: "", comments: [], open: true, held };
  },
});

/** One ticket whose pipeline changed nothing, through the scheduler and the ledger. */
const run = async (t: Tracker, at = { uncommitted: false, dryRun: false }) => {
  const records: Record<string, TicketRecord> = {};
  const outcomes: Record<string, Said> = {};
  const views: [string, boolean, string][] = [];
  const ledger = createLedger({
    run: { ticket: (id, fields) => void (records[id] = { ...records[id], ...fields }) },
    outcomes: (o) => Object.assign(outcomes, o),
    view: { landed: (id, ok, word) => void views.push([id, ok, word]) },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  const { endings } = await createSchedule<{ id: string }, Outcome, Outcome>({ tickets: [{ id: "4" }] }).run({
    workers: 1,
    attempt: async () => attempted("4", { status: "fulfilled", value: handBack(NO_CHANGE, t, at) }),
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: (c) => ledger.tell(c),
  });
  return { ending: endings.get("4"), record: records["4"], outcome: outcomes["4"], views, ledger };
};

test("a no-change ticket the agent handed back: its ending says so, and the run says it needs a human", async () => {
  const r = await run(tracker(true));
  assert.equal(r.ending?.kind, "pipeline");
  assert.equal(r.ending?.kind === "pipeline" && r.ending.outcome.handedBack, true);
  assert.deepEqual([r.record.state, r.record.note], ["held", "handed back - for a human"]);
  assert.deepEqual(r.outcome, { kind: "held", text: "needs a human: handed back" });
  assert.deepEqual(r.views, [["4", false, "needs a human"]]);
});

test("a no-change ticket not handed back is nothing to change", async () => {
  const r = await run(tracker(false));
  assert.equal(r.ending?.kind === "pipeline" && r.ending.outcome.handedBack, undefined);
  assert.deepEqual([r.record.state, r.record.note], ["nochange", "nothing to change"]);
  assert.deepEqual(r.outcome, { kind: "no change", text: "nochange" });
  assert.deepEqual(r.views, []);
});

test("an unreadable tracker leaves it no change, and costs the ticket nothing", async () => {
  const r = await run(tracker("unreadable"));
  assert.deepEqual([r.record.state, r.outcome.kind], ["nochange", "no change"]);
});

test("no hand-back is read where none can be: work left uncommitted, a dry run, a tracker agents cannot write", () => {
  const held = tracker(true);
  assert.equal(handBack(NO_CHANGE, held, { uncommitted: true, dryRun: false }).handedBack, undefined);
  assert.equal(handBack(NO_CHANGE, held, { uncommitted: false, dryRun: true }).handedBack, undefined);
  assert.equal(handBack(NO_CHANGE, tracker(true, false), { uncommitted: false, dryRun: false }).handedBack, undefined);
  // Only a pipeline that changed nothing: a red gate is red, whatever its labels say.
  assert.equal(handBack({ ...NO_CHANGE, status: "gate-failed" }, held, { uncommitted: false, dryRun: false }).handedBack, undefined);
});
