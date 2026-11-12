// A ticket the scheduler sent back twice lands on a third attempt, and the closing summary says so with
// every reason in order: the ledger keeps each send-back's line in the ticket's `requeues` (`requeued` is
// the last). The sent-back ticket's resolve wait (the `waitMs` of its `setup` line) is counted as time
// waiting, in the ticket's line and in the run's largest causes. Made-up records and timings; no Docker,
// model or network.
//
//   pnpm test:file test/report-requeue-count.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render, timeLostFromTimings } = await import("../src/report.ts");
const { addResolveWait, ticketTime } = await import("../src/burndown.ts");
const { createLedger } = await import("../src/ledger.ts");
type Facts = Parameters<typeof render>[0];
type TicketRecord = import("../mod/hooks/run-record.ts").TicketRecord;

const MIN = 60_000;

const facts = (tickets: Facts["tickets"], over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 1,
  tickets,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  verify: { green: true, line: "test=pass" },
  ...over,
});

const landedLines = (out: string) => out.split("\n").filter((l) => l.startsWith("Landed "));

const conflictBeforeReview = "requeued after conflict before review with #1";
const redAtLanding = "requeued after red with #3 (gate test)";

test("a ticket sent back twice is listed under a third attempt, with both reasons in order", () => {
  const out = render(facts({ "12": { state: "merged", requeued: redAtLanding, requeues: [conflictBeforeReview, redAtLanding] } }), true);
  assert.deepEqual(landedLines(out), ["Landed on a third attempt: #12 (sent back after a conflict found before its review, then after a red gate at landing)"]);
});

test("an older record with only requeued still reads as a second attempt", () => {
  const out = render(facts({ "2": { state: "merged", requeued: "requeued after conflict with #1" } }), true);
  assert.deepEqual(landedLines(out), ["Landed on a second attempt: #2 (sent back after a conflict)"]);
});

test("four attempts read 'Landed after 4 attempts'", () => {
  const line = "requeued after conflict with #1";
  const out = render(facts({ "5": { state: "merged", requeued: line, requeues: [line, line, line] } }), true);
  assert.deepEqual(landedLines(out), ["Landed after 4 attempts: #5 (sent back after a conflict, then after a conflict, then after a conflict)"]);
});

test("one line per attempt count, and tickets with the same reasons share a parenthesis", () => {
  const two = { requeued: redAtLanding, requeues: [conflictBeforeReview, redAtLanding] };
  const out = render(
    facts({
      "1": { state: "merged", ...two },
      "2": { state: "merged", ...two },
      "3": { state: "merged", requeued: redAtLanding, requeues: [redAtLanding] },
    }),
    true,
  );
  assert.deepEqual(landedLines(out), [
    "Landed on a second attempt: #3 (sent back after a red gate at landing)",
    "Landed on a third attempt: #1, #2 (sent back after a conflict found before its review, then after a red gate at landing)",
  ]);
});

test("a requeued ticket whose later attempt never ran (requeued null) is not listed, whatever requeues holds", () => {
  const out = render(facts({ "4": { state: "merged", requeued: null, requeues: [conflictBeforeReview] } }), true);
  assert.deepEqual(landedLines(out), []);
});

test("the ledger keeps both lines of a ticket sent back twice, in order", () => {
  const records: Record<string, TicketRecord> = {};
  const ledger = createLedger({
    run: { ticket: (id, fields) => void (records[id] = { ...records[id], ...fields }) },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  ledger.tell({ kind: "requeued", id: "9", again: { kind: "conflict", with: ["1"], found: "review" } } as Parameters<typeof ledger.tell>[0]);
  ledger.tell({ kind: "requeued", id: "9", again: { kind: "red", with: ["3"], gates: ["test"] } } as Parameters<typeof ledger.tell>[0]);
  assert.deepEqual(records["9"].requeues, ["requeued after conflict before review with #1", "requeued after red with #3 (gate test)"]);
  assert.equal(records["9"].requeued, "requeued after red with #3 (gate test)");
});

const setupLine = (over: Record<string, unknown>) => JSON.stringify({ run: "r1", issue: "7", phase: "setup", ms: 1000, ok: true, ...over });

test("the resolve waits of setup lines are a cause in the largest causes measured", () => {
  const text = [setupLine({ waitMs: 30 * MIN }), setupLine({ issue: "8", waitMs: 20 * MIN }), setupLine({ issue: "9" })].join("\n");
  const timeLost = timeLostFromTimings(text, "r1")!;
  assert.equal(timeLost.resolveWaitMs, 50 * MIN);
  const out = render(facts({}, { timeLost, estimate: { ms: { mid: 30 * MIN, high: 40 * MIN }, tokensIn: { mid: 1, high: 2 }, tokensOut: { mid: 1, high: 2 }, slots: 1, tickets: 1 } }), true);
  const causes = out.split("\n").filter((l) => l.startsWith("Largest causes"));
  assert.equal(causes.length, 1, out);
  assert.match(causes[0], /50m with sent-back tickets waiting to resolve, summed over tickets/);
});

test("a resolve wait is added to the ticket's time and its waiting, so the work figure is unchanged", () => {
  const took = new Map([["7", 35 * MIN]]);
  const waited = new Map<string, number>();
  const before = ticketTime(took.get("7"), waited.get("7"));
  addResolveWait(took, waited, "7", 170 * MIN);
  assert.equal(before, " work 35m");
  assert.equal(ticketTime(took.get("7"), waited.get("7")), " work 35m + 170m waiting");
  addResolveWait(took, waited, "7", undefined);
  addResolveWait(took, waited, "7", 0);
  assert.equal(took.get("7"), 205 * MIN);
});

test("the pipeline adds the resolve wait before its attempt starts", () => {
  // burndown() needs Docker, so no test drives it: its call of the helper tested here is held by its source.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /addResolveWait\(took, waited, issue\.id, at\?\.resolveWaitMs\);/);
});
