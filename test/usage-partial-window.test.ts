// A plan reading with one window (#937): Claude Code 2.1.322 writes a `rate_limit_event` that carries only the
// weekly window, so the reading, its merge into what is known, the run record's entry, the usage pause, the
// closing summary, the Herdr token and the status view all work from the windows that are there. Temp
// directories and built snapshots only; no Docker, no model, no network.
//
//   pnpm test:file test/usage-partial-window.test.ts

// The status view draws times in local time: one zone, so a frame is the same on every machine.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PlanUsage } from "../mod/hooks/run-record.ts";
import type { Project } from "../src/config.ts";
import type { Facts } from "../src/report.ts";
import type { Table } from "../src/status-rows.ts";
import type { Snapshot } from "../src/status-snapshot.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-usage-partial-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
after(() => rmSync(TMP, { recursive: true, force: true }));
const { agentLog, agentLogging, rawLog } = await import("../src/run.ts");
const { mergeReading, readPlanUsage, usageFromEvent, usagePauseFor, watchUsage } = await import("../src/usage.ts");
const { settingsLines } = await import("../src/report.ts");
const { usageText } = await import("../src/herdr.ts");
const { palette, renderFrame } = await import("../src/status-render.ts");
const { visibleWidth } = await import("../src/status-grid.ts");

const T = 1794952800;
// What Claude Code 2.1.322 writes in every pass: the weekly window alone.
const WEEK_ONLY_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794952800,"rateLimitType":"seven_day","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"seven_day":{"utilization":0.3,"resetsAt":1794952800,"status":"allowed"}}}}';
const FIVE_ONLY_LINE = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.14, resetsAt: T - 7200 } } } });
const FULL_LINE = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: T - 7200 }, seven_day: { utilization: 0.25, resetsAt: T } } },
});

const week = (percent: number): PlanUsage => ({ provider: "claude", windows: { week: { percent, resetsAt: T } }, at: 1 });

test("a rate_limit_event with only the weekly window gives a reading with only that window", () => {
  assert.deepEqual(usageFromEvent(WEEK_ONLY_LINE, 1794470000), { provider: "claude", windows: { week: { percent: 30, resetsAt: T } }, at: 1794470000 });
  assert.deepEqual(usageFromEvent(FIVE_ONLY_LINE, 5), { provider: "claude", windows: { fiveHour: { percent: 14, resetsAt: T - 7200 } }, at: 5 });
  assert.equal(usageFromEvent('{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{}}}', 1), undefined);
});

test("a one-window reading keeps the window it lacks from the last reading, until that window resets", () => {
  const next = usageFromEvent(WEEK_ONLY_LINE, 1794470000)!;
  const prev = usageFromEvent(FULL_LINE, 1794460000)!;
  const merged = mergeReading(prev, next, T - 9000);
  assert.equal(merged.windows.fiveHour?.percent, 12);
  assert.equal(merged.windows.week?.percent, 30, "the newer event's window wins");
  assert.equal(merged.at, 1794470000, "stamped as the newer event");
  // Past the 5-hour window's reset and its minute of grace, it says nothing any more.
  assert.equal(mergeReading(prev, next, T).windows.fiveHour, undefined);
  assert.equal(mergeReading(prev, next, T - 7200 + 59).windows.fiveHour?.percent, 12);
  assert.equal(mergeReading(prev, next, T - 7200 + 60).windows.fiveHour, undefined);
  // Nothing known before, or another provider's reading: the event as it is.
  assert.deepEqual(mergeReading(undefined, next, T - 9000), next);
});

test("the watch writes a week-only event merged into the full event before it, in one look or across looks", () => {
  const root = join(TMP, "watch");
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  const p = { root, name: "fixture" } as Project;
  const logging = agentLogging(p, "7", "impl-7", "run-1") as { onAgentStreamEvent: (e: unknown) => void };
  const file = rawLog(agentLog(p, "7", "impl-7"));
  const say = (line: string, mtime: number) => {
    logging.onAgentStreamEvent({ type: "raw", line, iteration: 1, timestamp: new Date() });
    utimesSync(file, mtime, mtime);
  };
  const clock = { ms: 1_000_000 };
  const written: PlanUsage[] = [];
  const watch = watchUsage({ logs: join(root, ".sandcastle/logs"), run: "run-1", write: (r) => void written.push(r), now: () => clock.ms });
  after(() => watch.stop());
  say(FULL_LINE, 5_000);
  say(WEEK_ONLY_LINE, 5_001);
  watch.poll();
  assert.deepEqual([written.at(-1)?.windows?.fiveHour?.percent, written.at(-1)?.windows?.week?.percent], [12, 30], "both events in one look");
  // Later looks: a week-only event again keeps the 5-hour window of the one before.
  clock.ms += 20_000;
  say(WEEK_ONLY_LINE.replace('"utilization":0.3', '"utilization":0.31'), 5_002);
  watch.poll();
  assert.deepEqual([written.at(-1)?.windows?.fiveHour?.percent, written.at(-1)?.windows?.week?.percent], [12, 31], "events in separate looks");
});

test("a run record's one-window usage entry is kept, and dropped only when neither window is valid", () => {
  assert.deepEqual(readPlanUsage({ provider: "claude", windows: { week: { percent: 30, resetsAt: T } }, at: 1 }), week(30));
  assert.deepEqual(readPlanUsage({ provider: "claude", windows: { fiveHour: { percent: "x", resetsAt: 1 }, week: { percent: 30, resetsAt: T } }, at: 1 }), week(30));
  assert.deepEqual(readPlanUsage({ provider: "claude", windows: { fiveHour: { percent: "x", resetsAt: 1 } }, at: 1 }), { provider: "claude" });
  assert.deepEqual(readPlanUsage({ provider: "claude", windows: {}, at: 1 }), { provider: "claude" });
});

test("the usage pause judges a reading with only the weekly window", () => {
  assert.equal(usagePauseFor([week(96)], 95, T - 3600)?.window, "week");
  assert.equal(usagePauseFor([week(94)], 95, T - 3600), undefined);
  assert.equal(usagePauseFor([week(96)], 95, T + 60), undefined, "a window that has reset says nothing");
});

test("the closing summary says the plan windows the reading has", () => {
  const facts = (usage: PlanUsage): Facts => ({
    base: "main", tracker: "github", started: "2026-10-04T06:41:00.000Z", finished: "2026-10-04T08:29:00.000Z", live: false, dryRun: false,
    verify: { green: true, line: "ok" }, gateCount: 1, tickets: {}, runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, usage,
  });
  assert.ok(settingsLines(facts({ provider: "claude", windows: { week: { percent: 30, resetsAt: T } }, at: 1 })).includes("Plan usage at the end: week 30%"));
  assert.ok(settingsLines(facts({ provider: "claude", windows: { fiveHour: { percent: 14, resetsAt: T } }, at: 1 })).includes("Plan usage at the end: 5h 14%"));
  const both: PlanUsage = { provider: "claude", windows: { fiveHour: { percent: 14, resetsAt: T }, week: { percent: 30, resetsAt: T } }, at: 1 };
  assert.ok(settingsLines(facts(both)).includes("Plan usage at the end: 5h 14%, week 30%"));
});

test("the Herdr token prints the windows a reading has", () => {
  const five = (percent: number): PlanUsage => ({ provider: "claude", windows: { fiveHour: { percent, resetsAt: T } }, at: 1 });
  assert.equal(usageText(week(30)), "wk 30%");
  assert.equal(usageText([five(14)]), "5h 14%");
  assert.equal(usageText([{ provider: "claude", windows: { fiveHour: { percent: 14, resetsAt: T }, week: { percent: 30, resetsAt: T } }, at: 1 }]), "5h 14% · wk 30%");
  const codex: PlanUsage = { provider: "codex", windows: { fiveHour: { percent: 1, resetsAt: T }, week: { percent: 3, resetsAt: T } }, at: 1 };
  assert.equal(usageText([five(14), codex]), "claude 5h 14% · codex wk 3%");
  assert.equal(usageText([week(30), codex]), "claude wk 30% · codex wk 3%");
  // The mark is the worst window present.
  assert.equal(usageText(five(92)), "5h 92% ■");
  assert.equal(usageText([week(30), { ...codex, windows: { fiveHour: { percent: 80, resetsAt: T }, week: { percent: 3, resetsAt: T } } }]), "claude wk 30% · codex wk 3% ▲");
});

// --- the status view -------------------------------------------------------------------------------------------

const NOW = Date.UTC(2026, 9, 12, 13, 0, 0) / 1000;
const TABLE: Table = {
  rows: [],
  counts: { working: 0, "needs you": 0, ready: 0, queued: 0, blocked: 0, merged: 0, later: 0, "left over": 0, idle: 0 },
  partly: 0,
  later: { ids: [], blocked: 0 },
};
const snapshotOf = (usage: unknown[]): Snapshot => ({
  now: NOW,
  root: "/home/user/project",
  dir: "/home/user/project/.sandcastle",
  name: "project",
  base: "main",
  hasRecord: true,
  record: { startedAt: "2026-10-12T11:00:00Z", stage: "running", usage: usage as PlanUsage[] },
  tickets: {},
  live: true,
  outcomes: {},
  logs: [],
  tails: {},
  worktrees: [],
  branches: {},
  containers: {},
  cpus: 8,
  pool: { sandboxes: { used: 0, outside: 0, limit: "3" }, gates: { used: 0, limit: "1" } },
  queue: { tickets: [] },
  unpushed: 0,
  settings: { from: "live", settings: { autonomy: "drain", crossReview: true } },
  models: "implement claude-sonnet-5-5/high",
  runOutput: [],
  links: false,
  clickMod: "",
});
const draw = (snapshot: Snapshot, cols: number) => renderFrame(snapshot, TABLE, { cols, rows: 400, showAll: false, colours: palette(false, false) }).split("\n");
/** The PLAN lane's cell on the frame's lines: the text between the last two `│` of a line, where the lane is the band's last. */
const planCells = (frame: string[], first: number) => frame.slice(first, first + 3).map((l) => l.split("│").at(-2)!.slice(1, -1));

const claudeWeek = { provider: "claude", at: NOW - 60, windows: { week: { percent: 30, resetsAt: T } } };
const claudeBoth = { provider: "claude", at: NOW - 60, windows: { fiveHour: { percent: 2, resetsAt: NOW + 7200 }, week: { percent: 30, resetsAt: T } } };

test("the status view's plan lane blanks the missing 5-hour cell as wide as the cell the renderer draws, so the week cell stays put", () => {
  // The full reading's 5-hour cell, as drawn: `5h   ` + 5 bar cells + `   2%` + ` · resets HH:MM`, 30 wide after `claude `.
  const full = planCells(draw(snapshotOf([claudeBoth]), 330), 1);
  const cell = /^claude (5h {3}[▓░]{5} {3}2% · resets \d\d:\d\d)\s*$/.exec(full[0]!)?.[1];
  assert.ok(cell, JSON.stringify(full));
  assert.equal(visibleWidth(cell), 30);

  const frame = draw(snapshotOf([claudeWeek]), 330);
  const [first, second] = planCells(frame, 1);
  assert.match(first!, /^claude {31,}$/, "`claude `, then only spaces");
  assert.equal(first!.slice("claude ".length, "claude ".length + 30), " ".repeat(30));
  assert.match(second!, /^ {7}week ▓▓░░░ {2}30% · resets Tue 22:00\s*$/);
  // The week cell starts where it does with both windows: the cells after a blank one do not shift.
  assert.equal(second!.indexOf("week"), full[1]!.indexOf("week"));
});

test("a week-only reading beside a full one lines their week cells up", () => {
  const codex = { provider: "codex", at: NOW - 60, windows: { fiveHour: { percent: 2, resetsAt: NOW + 7200 }, week: { percent: 13, resetsAt: T } } };
  const frame = draw(snapshotOf([claudeWeek, codex]), 330).filter((l) => /\bweek ▓/.test(l));
  assert.equal(frame.length, 2, frame.join("\n"));
  const at = (line: string) => line.indexOf("week ▓");
  assert.equal(at(frame[0]!), at(frame[1]!));
});

test("a week-only reading folds into the summary line when the lane does not fit, and says only its week", () => {
  const plan = draw(snapshotOf([claudeWeek]), 160).find((l) => /^│ plan {2}/.test(l));
  assert.ok(plan, "no plan lane");
  assert.match(plan, /week ▓▓░░░ 30% · resets Tue 22:00/); // the summary line squeezes a row's padding to one space
  assert.doesNotMatch(plan, /5h/);
});
