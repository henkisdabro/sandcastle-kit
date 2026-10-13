// A tracker read made during a run (the check before a ticket starts and before it lands, the hand-back
// read, the overrun warning's read, the blocker checks, the reopen check and the follow-up filing's open list) must not stop the run's event loop while GitHub answers, and must give
// up at a limit, read as "cannot be read". A fake `gh` on PATH that sleeps; no network.
//
//   pnpm test:file test/tracker-read-limit.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { makeTracker, readTicketState, TRACKER_READ_MS } = await import("../src/tracker.ts");
const { fileFollowUps, handBack, notReopened, openOnQueue } = await import("../src/burndown.ts");
const { blockedNote, openBlockersNow } = await import("../src/blockers.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
const fakeGh = (body: string) => {
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "gh"), 0o755);
};
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
const tracker = makeTracker(project);
const VIEW = '{"number":4,"title":"t","state":"OPEN","body":"b","comments":[],"labels":[{"name":"ready-for-human"}]}';

/** Resolves with how many times a 20 ms timer fired while `read` was pending, and how it ended. */
const during = async <T>(read: Promise<T>) => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const started = Date.now();
  const ended = await read.then((value) => ({ value }), (error: Error) => ({ error }));
  clearInterval(timer);
  return { ticks, ms: Date.now() - started, ...ended };
};

test("a slow gh read does not stop the run's other timers, and its answer is the ticket", async () => {
  fakeGh(`sleep 0.4\necho '${VIEW}'`);
  const r = await during(tracker.getAsync!("4", 5000));
  assert.ok(r.ticks >= 8, `the timer fired ${r.ticks} times in ${r.ms} ms`);
  assert.deepEqual("value" in r && [r.value.id, r.value.held, r.value.open], ["4", true, true]);
});

test("a gh that never answers is given up at the limit as a failed read, and the loop kept running", async () => {
  fakeGh("exec sleep 30");
  const r = await during(tracker.getAsync!("4", 300));
  assert.ok(r.ticks >= 8, `the timer fired ${r.ticks} times in ${r.ms} ms`);
  assert.ok(r.ms >= 250 && r.ms < 3000, `gave up after ${r.ms} ms`);
  assert.match(("error" in r ? r.error.message : ""), /^gh issue view failed: gh issue gave no answer in 0\.3 s - GitHub is slow or not answering\.$/);
});

test("the limit is 30 seconds unless a caller gives one", () => {
  assert.equal(TRACKER_READ_MS, 30_000);
});

test("a read that cannot be made leaves a pipeline that changed nothing as it was, not handed back", async () => {
  fakeGh("exec sleep 30");
  const nochange: Parameters<typeof handBack>[0] = { issue: "4", branch: "agent/issue-4", status: "nochange", commits: 0, reviewCommits: 0, repairs: 0, gates: [] };
  const limited = { ...tracker, getAsync: (id: string) => tracker.getAsync!(id, 200) };
  const r = await during(handBack(nochange, limited, { uncommitted: false, dryRun: false }));
  assert.equal("value" in r && r.value.handedBack, undefined);
  assert.ok(r.ticks >= 5, `the timer fired ${r.ticks} times in ${r.ms} ms`);
});

test("a tracker with no asynchronous read is read by get, and a throw is a rejection", async () => {
  const got = await readTicketState({ get: (id) => ({ id, title: "", body: "", comments: [], open: true, held: false }) }, "9");
  assert.equal(got.id, "9");
  await assert.rejects(readTicketState({ get: () => { throw new Error("gh: HTTP 502"); } }, "9"), /HTTP 502/);
});

const queued = [{ id: "5", title: "t", body: "no blockers named in the body", comments: [] as string[] }];

test("the open-ticket list is read without stopping the run's timers, and a gh that never answers ends it at the limit", async () => {
  fakeGh("exec sleep 30");
  const r = await during(tracker.openAsync!(false, 300));
  assert.ok(r.ticks >= 8, `the timer fired ${r.ticks} times in ${r.ms} ms`);
  assert.ok(r.ms >= 250 && r.ms < 3000, `gave up after ${r.ms} ms`);
  assert.match("error" in r ? r.error.message : "", /^gh issue list failed: gh issue gave no answer in 0\.3 s - GitHub is slow or not answering\.$/);
});

test("a slow open-ticket list that answers is the open tickets", async () => {
  fakeGh(`sleep 0.2\necho '[{"number":8,"title":"x","body":"","labels":[{"name":"needs-triage"}]}]'`);
  const r = await during(tracker.openAsync!(false, 5000));
  assert.ok(r.ticks >= 4, `the timer fired ${r.ticks} times in ${r.ms} ms`);
  assert.deepEqual("value" in r && r.value.map((t) => [t.id, t.labels]), [["8", ["needs-triage"]]]);
});

test("the reopen check keeps the run's timers going and, given up at the limit, says the ticket was reopened", async () => {
  fakeGh("exec sleep 30");
  const r = await during(tracker.reopenedSinceAsync!("4", 0, 300));
  assert.ok(r.ticks >= 8, `the timer fired ${r.ticks} times in ${r.ms} ms`);
  assert.ok(r.ms >= 250 && r.ms < 3000, `gave up after ${r.ms} ms`);
  assert.equal("value" in r && r.value, true);
});

test("the reopen check answers false when gh lists no reopen after the merge", async () => {
  fakeGh(`sleep 0.1\necho 2020-01-01T00:00:00Z`);
  assert.equal(await tracker.reopenedSinceAsync!("4", Date.parse("2021-01-01T00:00:00Z"), 5000), false);
  assert.equal(await tracker.reopenedSinceAsync!("4", Date.parse("2019-01-01T00:00:00Z"), 5000), true);
});

test("a ticket merged earlier whose reopen check cannot be read runs normally, and one nobody reopened is closed as merged", async () => {
  fakeGh("exec sleep 30");
  const found = "abc1234 2021-01-01T00:00:00+00:00";
  const slow = await during(notReopened(tracker, "4", found, 300));
  assert.ok(slow.ticks >= 8, `the timer fired ${slow.ticks} times in ${slow.ms} ms`);
  assert.equal("value" in slow && slow.value, undefined);
  assert.equal(await notReopened({ reopenedSince: () => { throw new Error("gh: HTTP 502"); } }, "4", found), undefined);
  assert.equal(await notReopened({ reopenedSince: () => false }, "4", found), "abc1234");
  assert.equal(await notReopened({ reopenedSince: () => true, reopenedSinceAsync: async () => false }, "4", found), "abc1234");
});

test("the blocker check of a GitHub ticket whose blocker links cannot be read keeps the timers going, ends at the limit and holds the ticket", async () => {
  fakeGh("exec sleep 30");
  const r = await during(openBlockersNow(project, makeTracker(project), ["5"], 300)(queued, new Set()));
  assert.ok(r.ticks >= 8, `the timer fired ${r.ticks} times in ${r.ms} ms`);
  assert.ok(r.ms >= 250 && r.ms < 3000, `gave up after ${r.ms} ms`);
  const open = ("value" in r ? r.value : [[]])[0];
  assert.deepEqual(open.map((b) => [b.kind, b.state]), [["links", "unreadable"]]);
  assert.equal(blockedNote(open, new Set(["5"])), "waits for #5's blocker links (could not be read)");
});

test("the blocker check reads a blocker's state through the time limit too, and an open one holds the ticket", async () => {
  fakeGh(`case "$*" in\n  "issue view"*) echo '{"number":5,"blockedBy":{"nodes":[{"number":3}]}}' ;;\n  *) sleep 30 ;;\nesac`);
  const r = await during(openBlockersNow(project, makeTracker(project), ["5"], 300)(queued, new Set()));
  assert.ok(r.ticks >= 8, `the timer fired ${r.ticks} times in ${r.ms} ms`);
  assert.deepEqual(("value" in r ? r.value : [[]])[0].map((b) => [b.kind, b.id, b.state]), [["github", "3", "unreadable"]]);
});

test("a ticket whose links are read and whose blocker is closed starts", async () => {
  fakeGh(`case "$*" in\n  "issue view"*) echo '{"number":5,"blockedBy":{"nodes":[{"number":3}]}}' ;;\n  *) echo "closed completed" ;;\nesac`);
  assert.deepEqual((await openBlockersNow(project, makeTracker(project), ["5"], 5000)(queued, new Set()))[0], []);
});

test("the run's start reads the queue's blockers without stopping the timers and ends at the limit", async () => {
  fakeGh("exec sleep 30");
  const r = await during(openOnQueue(project, makeTracker(project), queued, 300));
  assert.ok(r.ticks >= 8, `the timer fired ${r.ticks} times in ${r.ms} ms`);
  assert.ok(r.ms >= 250 && r.ms < 3000, `gave up after ${r.ms} ms`);
  assert.deepEqual("value" in r && [...r.value.keys()], ["5"]);
});

test("a follow-up is still filed when the open-ticket list cannot be read", async () => {
  const made: string[] = [];
  let asked = 0;
  const filing = {
    ref: (id: string) => `#${id}`,
    create: (title: string) => String(made.push(title) + 100),
    comment: () => {},
    open: () => { throw new Error("the sync list must not be used"); },
    openAsync: async () => { asked++; throw new Error("gh issue list failed: gh issue gave no answer in 30 s"); },
  };
  const f = { title: "Pool leaks a worker", evidence: "src/pool.ts:12 leaks", from: "7", phase: "review" };
  const filed = await fileFollowUps(filing, [f], { dryRun: false, write: async (fn) => fn(), exists: () => true, triage: "needs-triage" });
  assert.equal(asked, 1);
  assert.deepEqual(filed.map((x) => x.id), ["101"]);
  assert.deepEqual(made, [f.title]);
});

test("the run's reads before a ticket starts, before it lands, for the overrun warning and for a head record's comments go through the time-limited read", () => {
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const landing = readFileSync(new URL("../src/landing.ts", import.meta.url), "utf8");
  assert.match(burndown, /const withdrawal = async [^\n]*\n\s*const now = await readTicketState\(tracker, id\);/);
  assert.match(burndown, /\(await readTicketState\(tracker, o\.issue\)\)\.held/);
  assert.match(burndown, /const ticketComments = async [^\n]*\n\s*try \{\n\s*return \(await readTicketState\(tracker, id\)\)\.comments;/);
  assert.doesNotMatch(burndown, /tracker\.get\(id\)\.comments/);
  assert.match(landing, /const called = await withdrawal\(o\.issue\);/);
  assert.match(landing, /\(await readTicketState\(tracker, o\.issue\)\)\.body/);
  assert.doesNotMatch(landing, /tracker\.get\(/);
  // The blocker checks, the reopen check and the follow-up filing's open list, the other reads of a run.
  assert.match(burndown, /tracker\.reopenedSinceAsync \? await tracker\.reopenedSinceAsync\(issue,/);
  assert.match(burndown, /const merge = await mergedEarlier\(issue\.id, branch\);/);
  assert.match(burndown, /return found \? notReopened\(tracker, issue, found\) : undefined;/);
  assert.match(burndown, /tracker\.openAsync \? await tracker\.openAsync\(false\) : tracker\.open\(false\)/);
  assert.match(burndown, /openBlockers\(project, tracker, resolve, i, limitMs\)/);
  assert.match(burndown, /open: openBlockersNow\(project, tracker, queued\.map/);
  const blockers = readFileSync(new URL("../src/blockers.ts", import.meta.url), "utf8");
  assert.match(blockers, /await tracker\.declaredBlockersAsync\(t\.id, limitMs\)/);
  assert.match(blockers, /await githubStateAsync\(ref\.id, limitMs\)/);
  assert.match(blockers, /\(limitMs === undefined \? refsOf\(project, tracker, t\) : await refsOfAsync\(project, tracker, t, limitMs\)\)/);
});
