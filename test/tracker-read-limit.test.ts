// A tracker read made during a run (the check before a ticket starts and before it lands, the hand-back
// read, the overrun warning's read) must not stop the run's event loop while GitHub answers, and must give
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
const { handBack } = await import("../src/burndown.ts");
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

test("the run's reads before a ticket starts, before it lands and for the overrun warning go through the time-limited read", () => {
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const landing = readFileSync(new URL("../src/landing.ts", import.meta.url), "utf8");
  assert.match(burndown, /const withdrawal = async [^\n]*\n\s*const now = await readTicketState\(tracker, id\);/);
  assert.match(burndown, /\(await readTicketState\(tracker, o\.issue\)\)\.held/);
  assert.match(landing, /const called = await withdrawal\(o\.issue\);/);
  assert.match(landing, /\(await readTicketState\(tracker, o\.issue\)\)\.body/);
  assert.doesNotMatch(landing, /tracker\.get\(/);
});
