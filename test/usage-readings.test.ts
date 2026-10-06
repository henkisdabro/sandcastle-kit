// The plan's usage from the agents' own rate-limit events (src/usage.ts): a `rate_limit_event` line
// parses to a reading, the run takes the newest reading across its agents' logs while it is live,
// and the run record holds it as `usage`. Temp directories only; no Docker, no model, no network.
//
//   node --test test/usage-readings.test.ts

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";
import type { PlanUsage } from "../mod/hooks/run-record.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-usage-readings-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
after(() => rmSync(TMP, { recursive: true, force: true }));
const { agentLog, agentLogging, rawLog, recordRun } = await import("../src/run.ts");
const { isClaudeModel, readPlanUsage, showsPlanUsage, usageFromEvent, watchUsage } = await import("../src/usage.ts");

// The shape Claude Code writes, with the reset times of the ticket's own example.
const TICKET_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.92,' +
  '"unifiedWindows":{"five_hour":{"utilization":0.13,"resetsAt":1791195000},"seven_day":{"utilization":0.92,"resetsAt":1791324000}}}}';
const event = (five: number, week: number) =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: five, resetsAt: 1791195000 }, seven_day: { utilization: week, resetsAt: 1791324000 } } },
  });

test("a rate_limit_event line parses to the plan's reading, percent as a whole number and the times as given", () => {
  assert.deepEqual(usageFromEvent(TICKET_LINE, 1791190000), {
    provider: "claude",
    windows: { fiveHour: { percent: 13, resetsAt: 1791195000 }, week: { percent: 92, resetsAt: 1791324000 } },
    at: 1791190000,
  });
  // A fraction rounds to the nearest percent and a spent window stops at 100.
  const w = usageFromEvent(event(0.005, 1.4), 1)?.windows;
  assert.deepEqual([w?.fiveHour.percent, w?.week.percent], [1, 100]);
});

test("a malformed line, another type of line, or an event without both windows gives no reading", () => {
  const five = { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1791195000 } } } };
  const text = { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: "0.1", resetsAt: 1 }, seven_day: { utilization: 0.2, resetsAt: 2 } } } };
  for (const line of [
    "",
    "{",
    "not json, but it says rate_limit_event",
    '{"type":"assistant","message":{"content":[{"type":"text","text":"rate_limit_event"}]}}',
    '{"type":"rate_limit_event"}',
    '{"type":"rate_limit_event","rate_limit_info":null}',
    JSON.stringify(five),
    JSON.stringify(text),
    TICKET_LINE.replace('"type":"rate_limit_event"', '"type":"result"'),
  ]) assert.equal(usageFromEvent(line, 1), undefined, line);
});

const project = (name: string, root = join(TMP, name)) => {
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  return { root, name: "fixture" } as Project;
};

/** One agent pass writing its raw stream through the kit's own `agentLogging`, each line stamped as written at `mtime` (seconds). */
const pass = (p: Project, id: string, run: string) => {
  const logging = agentLogging(p, id, `impl-${id}`, run) as { onAgentStreamEvent: (e: unknown) => void };
  const file = rawLog(agentLog(p, id, `impl-${id}`));
  return {
    file,
    say(line: string, mtime: number) {
      logging.onAgentStreamEvent({ type: "raw", line, iteration: 1, timestamp: new Date() });
      utimesSync(file, mtime, mtime);
    },
  };
};

/** A watch over a project's logs on a clock the test moves, and the readings it wrote. */
const watching = (p: Project, run: string) => {
  const clock = { ms: 1_000_000 };
  const written: PlanUsage[] = [];
  const watch = watchUsage({ logs: join(p.root, ".sandcastle/logs"), run, write: (r) => void written.push(r), now: () => clock.ms });
  after(() => watch.stop());
  return { clock, written, watch };
};
const percents = (u?: PlanUsage) => [u?.windows?.fiveHour.percent, u?.windows?.week.percent];

test("the newest reading across several agents' logs wins, not the highest", () => {
  const p = project("newest");
  const a = pass(p, "7", "run-1");
  const b = pass(p, "8", "run-1");
  const { written, watch } = watching(p, "run-1");
  a.say(event(0.1, 0.5), 5_000);
  b.say(event(0.2, 0.55), 6_000);
  watch.poll();
  assert.deepEqual(percents(written.at(-1)), [20, 55], "the file written last holds the newest");
  // The other pass writes later, and its reading is lower: lower, but newer.
  a.say(event(0.12, 0.51), 7_000);
  watch.poll(true);
  assert.deepEqual(percents(written.at(-1)), [12, 51]);
  assert.equal(written.at(-1)?.at, 1000, "stamped when the kit read it, in seconds");
});

test("only what a file gained is read: an old event is not a new reading, and half a line waits for the rest", () => {
  const p = project("appended");
  const a = pass(p, "7", "run-1");
  const { clock, written, watch } = watching(p, "run-1");
  a.say(event(0.1, 0.5), 5_000);
  watch.poll();
  assert.equal(written.length, 1);
  // Time passes and the file grows with something else: the earlier event is not read again.
  clock.ms += 20_000;
  a.say('{"type":"assistant","message":{"content":[]}}', 5_001);
  watch.poll();
  assert.equal(written.length, 1, "no new reading, no new write");
  // A line the agent is still writing is not read until it ends.
  const line = event(0.3, 0.6);
  appendFileSync(a.file, line.slice(0, 40));
  clock.ms += 20_000;
  watch.poll();
  assert.equal(written.length, 1);
  appendFileSync(a.file, line.slice(40) + "\n");
  clock.ms += 20_000;
  watch.poll();
  assert.deepEqual(percents(written.at(-1)), [30, 60]);
});

test("only this run's lines count: an earlier run's reading in the same file is not this run's", () => {
  const p = project("earlier-run");
  const old = pass(p, "7", "run-0");
  old.say(event(0.99, 0.99), 1_000);
  const now = pass(p, "7", "run-1");
  const other = pass(p, "8", "run-0");
  other.say(event(0.97, 0.98), 9_000);
  const { written, watch } = watching(p, "run-1");
  watch.poll();
  assert.deepEqual(written, [], "no reading of this run's yet");
  now.say(event(0.1, 0.2), 2_000);
  watch.poll();
  assert.deepEqual(percents(written.at(-1)), [10, 20]);
});

test("a reading is not written more often than the interval, and one that came while waiting is written when it passes", () => {
  const p = project("interval");
  const a = pass(p, "7", "run-1");
  const { clock, written, watch } = watching(p, "run-1");
  a.say(event(0.1, 0.5), 1_000);
  watch.poll();
  assert.equal(written.length, 1, "the first reading is written at once");
  clock.ms += 5_000;
  a.say(event(0.11, 0.5), 1_001);
  watch.poll();
  watch.poll();
  assert.equal(written.length, 1, "5 s later: too soon, however often it is asked");
  clock.ms += 11_000;
  watch.poll();
  assert.equal(written.length, 2);
  assert.deepEqual(percents(written.at(-1)), [11, 50], "the reading that waited, as it was");
  // Nothing new since: the unchanged reading is not written again, however long it has been.
  clock.ms += 120_000;
  watch.poll();
  assert.equal(written.length, 2);
  // The run's end writes what came last, whatever the interval says.
  clock.ms += 1_000;
  a.say(event(0.2, 0.6), 1_002);
  watch.stop();
  assert.deepEqual(percents(written.at(-1)), [20, 60]);
  assert.equal(written.length, 3);
});

test("the reading lands in run.json's usage, rewritten no more often than the interval, and not at all when unchanged", () => {
  // Not under TMP: the record is finished by an exit handler, which writes it once more after the cleanup below.
  const p = project("record", mkdtempSync(join(tmpdir(), "sandcastle-usage-record-")));
  const file = join(p.root, ".sandcastle/logs/run.json");
  const usage = () => JSON.parse(readFileSync(file, "utf8")).usage as PlanUsage | undefined;
  const run = recordRun(p, {});
  assert.equal(usage(), undefined, "a record starts with none");
  run.update({ usage: { provider: "claude" } });
  assert.deepEqual(usage(), { provider: "claude" }, "waiting for the first agent");
  const a = pass(p, "7", "run-1");
  const clock = { ms: 2_000_000 };
  const writes: number[] = [];
  const watch = watchUsage({
    logs: join(p.root, ".sandcastle/logs"),
    run: "run-1",
    now: () => clock.ms,
    write: (reading) => {
      writes.push(clock.ms);
      run.update({ usage: reading });
    },
  });
  after(() => watch.stop());
  a.say(TICKET_LINE, 3_000);
  watch.poll();
  assert.deepEqual(usage(), { provider: "claude", windows: { fiveHour: { percent: 13, resetsAt: 1791195000 }, week: { percent: 92, resetsAt: 1791324000 } }, at: 2000 });
  // The same numbers again, 5 s on: too soon to write. A minute on, with nothing new, the reading that waited is written.
  clock.ms += 5_000;
  a.say(TICKET_LINE, 3_001);
  watch.poll();
  assert.equal(usage()?.at, 2000, "5 s later the record is as it was");
  clock.ms += 55_000;
  watch.poll();
  assert.equal(usage()?.at, 2005, "the reading that waited, stamped when it was read");
  // Nothing new since: not rewritten, however long it has been, and the rest of the record is untouched by it.
  clock.ms += 60_000;
  watch.poll();
  assert.deepEqual(writes, [2_000_000, 2_060_000], "two writes in all");
  run.update({ stopped: "x" });
  assert.equal(usage()?.at, 2005);
});

test("a reading is for a run that spends a subscription on a Claude model, and for no other", () => {
  const claude = ["claude-sonnet-5-5", "claude-opus-5-5"];
  assert.equal(showsPlanUsage({ apiKey: false, oauthToken: true, models: claude }), true);
  // An API key is spent first, beside the token or not: those are credits, and no plan's usage describes them.
  assert.equal(showsPlanUsage({ apiKey: true, oauthToken: true, models: claude }), false);
  assert.equal(showsPlanUsage({ apiKey: false, oauthToken: false, models: claude }), false);
  // One Claude model among the passes' is enough; none is not.
  assert.equal(showsPlanUsage({ apiKey: false, oauthToken: true, models: ["gpt-6-astra", "claude-opus-5-5"] }), true);
  assert.equal(showsPlanUsage({ apiKey: false, oauthToken: true, models: ["gpt-6-astra"] }), false);
  for (const id of ["claude-haiku-4-5-20251001", "sonnet", "opus[1m]", "Fable"]) assert.equal(isClaudeModel(id), true, id);
  for (const id of ["gpt-6-astra", "my-claude-proxy", "sonnet-lookalike"]) assert.equal(isClaudeModel(id), false, id);
});

test("a record's usage is read back only as far as it is well-formed", () => {
  const good = { provider: "claude", windows: { fiveHour: { percent: 14, resetsAt: 5 }, week: { percent: 250, resetsAt: 6 } }, at: 7 };
  assert.deepEqual(readPlanUsage(good), { provider: "claude", windows: { fiveHour: { percent: 14, resetsAt: 5 }, week: { percent: 100, resetsAt: 6 } }, at: 7 });
  assert.deepEqual(readPlanUsage({ provider: "claude" }), { provider: "claude" });
  assert.deepEqual(readPlanUsage({ ...good, windows: { fiveHour: { percent: "lots", resetsAt: 5 }, week: good.windows.week } }), { provider: "claude" });
  assert.deepEqual(readPlanUsage({ ...good, at: "now" }), { provider: "claude" });
  for (const junk of [undefined, null, "claude", 3, [1], { provider: "other", windows: good.windows }]) assert.equal(readPlanUsage(junk), undefined, JSON.stringify(junk));
});

test("a logs directory that does not exist yet is no reading and no failure", () => {
  const watch = watchUsage({ logs: join(TMP, "nowhere"), run: "run-1", write: () => assert.fail("nothing to write") });
  watch.poll();
  watch.stop();
});
