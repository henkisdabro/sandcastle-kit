// A plan session or weekly limit hit mid-run ("You've hit your session limit · resets 2:10pm (UTC)") used to match
// no limit wording, so every implementer that died of it was reported as a crash with no reason. Now the line is
// recognised and its reset time read, the tickets it cut short end as not started (runnable again, never "crashed"),
// the ledger says why, and the closing summary names the reset time and, with USAGE_PAUSE off, that setting.
// Temp dirs and fakes only; no Docker, no model calls.
//
//   pnpm test:file test/plan-session-limit.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { attempted, planLimit } = await import("../src/burndown.ts");
const { describe } = await import("../src/ledger.ts");
const { render } = await import("../src/report.ts");
const { limitResets, logSaysLimit } = await import("../src/run.ts");
const { createSchedule } = await import("../src/schedule.ts");
import type { Facts } from "../src/report.ts";
import type { TicketRecord } from "../mod/hooks/run-record.ts";

const SESSION = "You've hit your session limit · resets 2:10pm (UTC)";
const WEEKLY = "You've hit your weekly limit · resets Oct 12, 9am (UTC)";

test("the session and weekly limit lines are recognised, with the reset time", () => {
  assert.equal(logSaysLimit(`${SESSION}\n`), true);
  assert.equal(limitResets(`${SESSION}\n`), "2:10pm (UTC)");
  assert.equal(logSaysLimit(`${WEEKLY}\n`), true);
  assert.equal(limitResets(`${WEEKLY}\n`), "Oct 12, 9am (UTC)");
  // A limit line with no reset time still counts.
  assert.equal(logSaysLimit("You've hit your session limit\n"), true);
  assert.equal(limitResets("You've hit your session limit\n"), undefined);
});

test("a log that does not end on a limit line, or a failed tool's line, is no limit", () => {
  assert.equal(logSaysLimit("Bash(pnpm test)\nAgent error: sandbox exited 137\n"), false);
  assert.equal(logSaysLimit(`! exit 1: ${SESSION}\nRun complete\n`), false);
  assert.equal(limitResets(`! exit 1: ${SESSION}\n`), undefined);
});

const root = mkdtempSync(join(tmpdir(), "sandcastle-plan-limit-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });

test("a crashed ticket whose log ends on the session limit carries the reset time into its stop cause", () => {
  writeFileSync(join(root, ".sandcastle/logs/agent-issue-41-impl-41.log"), `${SESSION}\n`);
  writeFileSync(join(root, ".sandcastle/logs/agent-issue-42-impl-42.log"), "Agent error: sandbox exited 137\n");
  assert.deepEqual(planLimit(root, "41"), { resets: "2:10pm (UTC)" });
  assert.equal(planLimit(root, "42"), undefined);
  const crashed = attempted("41", { status: "rejected", reason: new Error("claude-code exited with code 1:") }, undefined, planLimit(root, "41"));
  assert.deepEqual(crashed, { kind: "crashed", error: crashed.kind === "crashed" ? crashed.error : undefined, causes: [{ kind: "plan limit", ticket: "41", resets: "2:10pm (UTC)" }] });
});

test("ten implementers that die of the limit end as not started, and the run stops with the reset time", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
  const { endings, stop } = await createSchedule<{ id: string }, { issue: string }, unknown, string>({ tickets: ids.map((id) => ({ id })) }).run({
    workers: 3,
    attempt: async (t: { id: string }) => ({ kind: "crashed" as const, error: new Error("claude-code exited with code 1:"), causes: [{ kind: "plan limit" as const, ticket: t.id, resets: "2:10pm (UTC)" }] }),
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  } as never);
  assert.deepEqual([...new Set([...endings.values()].map((e) => e.kind))], ["not begun"]);
  assert.equal(endings.size, 10);
  assert.equal(stop.startsNothing, true);
  assert.deepEqual(stop.headline, { kind: "plan limit", ticket: "1", resets: "2:10pm (UTC)" });
});

const BASE = { base: "main", gateNames: "lint, test" };

test("the ledger records a ticket the limit cut short as skipped, with the reset time", () => {
  const said = describe({ kind: "not begun", why: { kind: "plan limit", ticket: "5", resets: "2:10pm (UTC)" }, cutShort: true }, { ...BASE, stopLine: "#1 hit the plan's usage limit" });
  assert.deepEqual(said.record, { state: "skipped", note: "not started: the plan's usage limit stopped it (resets 2:10pm (UTC))" });
});

const facts = (over: Partial<Facts> = {}): Facts => {
  const limited = (order: number): TicketRecord => ({ state: "skipped", order, title: `t${order}`, note: "not started: the plan's usage limit stopped it (resets 2:10pm (UTC))" });
  return {
    base: "main",
    tracker: "github",
    started: "2026-10-05T06:00:00.000Z",
    finished: "2026-10-05T07:00:00.000Z",
    live: false,
    dryRun: false,
    gateCount: 2,
    tickets: { "1": limited(0), "2": limited(1) },
    runnable: [],
    blocked: [],
    standing: [],
    keptWorktrees: [],
    changed: {},
    ...over,
  };
};

test("the summary lists the cut-short tickets as not started with the reset time, not under Needs fixing", () => {
  const out = render(facts(), true);
  assert.match(out, /^Not started \(the run stopped early\): #1 #2$/m);
  assert.match(out, /^Paused for usage: the plan's limit stopped the run, resets 2:10pm \(UTC\)/m);
  assert.doesNotMatch(out, /crashed/);
  // The setting is off (no `usagePause` in the record): it is named.
  assert.match(out, /USAGE_PAUSE=95/);
});

test("the summary does not name USAGE_PAUSE when the run had it on", () => {
  const out = render(facts({ settings: { usagePause: 90 } as Facts["settings"] }), true);
  assert.match(out, /^Paused for usage: /m);
  assert.doesNotMatch(out, /USAGE_PAUSE/);
});
