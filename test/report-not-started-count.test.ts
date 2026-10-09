// The closing summary's headline counts as "not started" only the tickets the run would have started
// and did not; tickets waiting on a blocker are counted apart, as "blocked" (the clause is left out
// at 0). Before, the headline folded blocked tickets into "not started", so it disagreed with the
// "Not started" line and the Next step, which name only the tickets the run never began.
//
//   pnpm test:file test/report-not-started-count.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";
import type { TicketRecord } from "../mod/hooks/run-record.ts";

const facts = (tickets: Record<string, TicketRecord>, over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const headline = (text: string) => text.split("\n").find((l) => / attempted - /.test(l))!;

const ticket = (state: TicketRecord["state"], order: number, extra: Partial<TicketRecord> = {}): TicketRecord => ({ state, order, title: `t${order}`, ...extra });

test("a run that stopped early counts two unstarted tickets and six blocked ones apart", () => {
  const tickets: Record<string, TicketRecord> = {
    "1": { ...ticket("merged", 0), started: 1 } as TicketRecord,
    "2": ticket("skipped", 1, { note: "not started: usage at 95%" }),
    "3": ticket("skipped", 2, { note: "not started: usage at 95%" }),
    ...Object.fromEntries(["4", "5", "6", "7", "8", "9"].map((id, i) => [id, ticket("blocked", i + 3, { note: "waits for #99" })])),
  };
  const blocked = ["4", "5", "6", "7", "8", "9"].map((id) => ({ id, on: ["#99"] }));
  const out = render(facts(tickets, { stopped: "usage at 95%", blocked }), true);
  assert.match(headline(out), / - 2 not started - 6 blocked$/);
  assert.match(out, /^Not started \(the run stopped early\): #2 #3$/m);
  assert.match(out, /^2\. Run again for the 2 ticket\(s\) that never started\.$/m);
});

test("a run in which every started ticket merged reads 0 not started with its five waiting tickets blocked", () => {
  const tickets: Record<string, TicketRecord> = {
    ...Object.fromEntries(["1", "2", "3"].map((id, i) => [id, { ...ticket("merged", i), started: 1 } as TicketRecord])),
    ...Object.fromEntries(["4", "5", "6", "7", "8"].map((id, i) => [id, ticket("blocked", i + 3, { note: "waits for #90 (held)" })])),
  };
  const blocked = ["4", "5", "6", "7", "8"].map((id) => ({ id, on: ["#90"] }));
  const out = render(facts(tickets, { blocked }), true);
  assert.match(headline(out), / - 0 need fixing - 0 not started - 5 blocked$/);
  assert.doesNotMatch(out, /8 not started|5 not started/);
});

test("a ticket whose blockers this run closed is named runnable, not counted as blocked", () => {
  const tickets: Record<string, TicketRecord> = {
    "1": { ...ticket("merged", 0), started: 1 } as TicketRecord,
    "2": ticket("blocked", 1, { note: "waits for #1" }),
    "3": ticket("blocked", 2, { note: "waits for #90" }),
  };
  const out = render(facts(tickets, { runnable: ["2"], blocked: [{ id: "3", on: ["#90"] }] }), true);
  assert.match(headline(out), / - 0 not started - 1 blocked$/);
  assert.match(out, /Runnable now: #2 \(blocker #1 closed\)/);
  assert.match(out, /^⏳ #3 waits for #90/m);
});

test("no blocked tickets leaves the blocked clause out", () => {
  const out = render(facts({ "1": { ...ticket("merged", 0), started: 1 } as TicketRecord }), true);
  assert.match(headline(out), / - 0 not started$/);
  assert.doesNotMatch(out, / - \d+ blocked/);
});
