// A ticket whose outsider-edit read failed (#893) is not withdrawn: nothing is known of it, it was not
// started, and it stays queued. Before, the attempt ended it as `withdrawn`, so the closing summary said
// "Not landed, as the tracker said during the run", counted it in `withdrawn N` and a drain skipped it.
//
//   pnpm test:file test/report-outsider-unread.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { noRerunCause, rerunnable } from "../src/autonomy.ts";
import { outsiderEdit } from "../src/burndown.ts";
import { accountLanding, describe, type TicketEnding } from "../src/ledger.ts";
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

const CTX = { base: "main", gateNames: "test" };

// The attempt's own step: the tracker's read throws, `outsiderEdit` says unread, and the attempt turns that into the ending.
const unreadEnding = async (): Promise<TicketEnding> => {
  const tracker = { editedSinceQueued: async () => { throw new Error("HTTP 502: Bad Gateway"); } };
  const outsider = await outsiderEdit(tracker, "12", Date.parse("2026-11-10T09:00:00Z"));
  assert.ok(outsider?.kind === "unread");
  // The call site in `attempt()`: held in text, as `burndown()` needs Docker.
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const at = burndown.indexOf('if (outsider?.kind === "unread") {');
  assert.match(burndown.slice(at, at + 300), /return \{ kind: "not begun", why: \{ kind: "unchecked", reason: outsider\.why \} \};/);
  return { kind: "not begun", why: { kind: "unchecked", reason: outsider.why } };
};

test("a failed outsider-edit read ends the ticket as skipped, not withdrawn, and it is not a landing", async () => {
  const ending = await unreadEnding();
  const said = describe(ending, CTX);
  assert.equal(said.record?.state, "skipped");
  assert.equal(said.record?.note, "not started: could not read its edits from GitHub");
  const withdrawnCount = accountLanding([{ id: "12", ending, context: CTX, said }] as never).withdrawn;
  assert.equal(withdrawnCount, 0);
});

test("a real withdrawal still ends as withdrawn and counts", () => {
  const ending: TicketEnding = { kind: "not begun", why: { kind: "withdrawn", reason: "ticket closed during the run" } };
  const said = describe(ending, CTX);
  assert.equal(said.record?.state, "withdrawn");
  assert.equal(said.record?.note, "ticket closed - not started");
});

test("the closing summary lists the unread ticket under Runnable now, not as the tracker's withdrawal", () => {
  const tickets: Record<string, TicketRecord> = {
    "12": { state: "skipped", order: 0, title: "t12", note: "not started: could not read its edits from GitHub" },
    "13": { state: "withdrawn", order: 1, title: "t13", note: "ticket closed - not started" },
  };
  const out = render(facts(tickets), true);
  assert.match(out, /Runnable now: .*12 \(not started: could not read its edits from GitHub\)/);
  assert.doesNotMatch(out, /Not landed, as the tracker said during the run: [^\n]*12/);
  assert.doesNotMatch(out, /the run stopped early/);
  // The real withdrawal reads as it did.
  assert.match(out, /Not landed, as the tracker said during the run: [^\n]*13 - ticket closed - not started/);
});

test("a ticket skipped because the run stopped is still listed as the run stopping it", () => {
  const tickets: Record<string, TicketRecord> = { "5": { state: "skipped", order: 0, title: "t5", note: "not started: usage at 95%" } };
  const out = render(facts(tickets, { stopped: "usage at 95%" }), true);
  assert.match(out, /Not started \(the run stopped early\): [^\n]*5/);
});

test("a drain turn may run the unread ticket again, and a usage-limit skip still ends the drain", () => {
  const unread = facts({ "12": { state: "skipped", order: 0, title: "t12", note: "not started: could not read its edits from GitHub" } });
  assert.equal(noRerunCause(unread), undefined);
  assert.deepEqual(rerunnable(unread)?.unchecked, ["12"]);
  const limited = facts({ "5": { state: "skipped", order: 0, title: "t5", note: "not started: usage at 95%" } });
  assert.match(noRerunCause(limited) ?? "", /^the run stopped early/);
});

test("the unread ticket gets a Next step, and autonomy 0 names it among the tickets it could run again", () => {
  const tickets: Record<string, TicketRecord> = {
    "12": { state: "skipped", order: 0, title: "t12", note: "not started: could not read its edits from GitHub" },
    "14": { state: "merged", order: 1, title: "t14" },
  };
  const out = render(facts(tickets, { settings: { autonomy: 0, turn: 1, cap: 1 } }), true);
  assert.match(out, /## Next step\n1\. Run again for the 1 ticket\(s\) that never started\./);
  assert.match(out, /Autonomy 0 makes one turn, and #12 could run again/);
});
