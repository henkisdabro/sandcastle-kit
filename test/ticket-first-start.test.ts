// run.json's `started` for a ticket is its first start: a requeued second attempt (or a resume after a
// pause) begins with `setup` again, and rewriting `started` there made a finished ticket's TIME in the
// status view (`since - started`) its last attempt's length, not the ticket's. No Docker, model or network.
//
//   node --test test/ticket-first-start.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { firstStart } = await import("../src/burndown.ts");
type TicketRecord = import("../mod/hooks/run-record.ts").TicketRecord;

const T0 = 1_790_000_000_000;

/** A ticket's run.json entry after each step, written and merged as burndown() and the run record do. */
const through = (steps: [Parameters<typeof firstStart>[1], number][]) =>
  steps.reduce<TicketRecord | undefined>((prior, [phase, at]) => ({ ...prior, state: phase, ...firstStart(prior, phase, at) }), undefined);

test("the first setup records the ticket's start, in seconds", () => {
  assert.equal(through([["setup", T0 + 1500]])?.started, Math.floor((T0 + 1500) / 1000));
});

test("a requeued ticket's second setup keeps the first start", () => {
  const t = through([
    ["setup", T0],
    ["implement", T0 + 60_000],
    ["gates", T0 + 600_000],
    ["queued", T0 + 900_000],
    ["setup", T0 + 1_200_000],
    ["resolve", T0 + 1_260_000],
  ]);
  assert.equal(t?.started, T0 / 1000);
  assert.equal(t?.state, "resolve");
  // The ETA's start is the second attempt's: from the first, a long first attempt read the second as overdue.
  assert.equal(t?.attemptStarted, (T0 + 1_200_000) / 1000);
});

test("a step other than setup never writes a start", () => {
  assert.deepEqual(firstStart(undefined, "implement", T0), {});
  assert.deepEqual(firstStart(undefined, "gates", T0), {});
});

test("every step of a ticket goes through it on its way to run.json", () => {
  // burndown() needs Docker, so no test drives it: its wiring of the helper tested here is held by its source.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /run\.ticket\(issue, \{ state: phase, \.\.\.firstStart\(run\.tickets\(\)\[issue\], phase, since\), /);
});
