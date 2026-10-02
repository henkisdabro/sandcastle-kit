// A later autonomy turn names its tickets in ISSUES; `waiting` must still cover the whole queue,
// or the dependants of a ticket that turn lands never show as runnable and the cap is never said.
// Ticket files in a temp repo (files tracker) and a made-up run record; no Docker, gh, model
// calls or network. Paths come from node:path and os.tmpdir(), so macOS and Linux behave alike.
//
//   pnpm exec tsx --test test/autonomy-waiting.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { namedTickets, waitingTickets, wholeQueue } = await import("../src/burndown.ts");
const { capLine, nextTurn, rerunList, rerunnable } = await import("../src/autonomy.ts");
const { gather } = await import("../src/report.ts");
const { recordRun } = await import("../src/run.ts");
const { makeTracker, refOf } = await import("../src/tracker.ts");
type Project = import("../src/config.ts").Project;

const root = mkdtempSync(join(tmpdir(), "sandcastle-autonomy-waiting-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
const dir = join(root, ".scratch/shop/issues");
mkdirSync(dir, { recursive: true });
const ticket = (title: string, status: string, head = "") => `# ${title}\n\nStatus: ${status}\n${head}\nDo it.\n\n## Comments\n`;
writeFileSync(join(dir, "01-base.md"), ticket("Base", "ready-for-agent"));
writeFileSync(join(dir, "02-first.md"), ticket("First", "ready-for-agent", "Blocked by: 01"));
writeFileSync(join(dir, "03-second.md"), ticket("Second", "ready-for-agent", "Blocked by: 01"));
writeFileSync(join(dir, "04-free.md"), ticket("Free", "ready-for-agent"));
writeFileSync(join(dir, "05-picked.md"), ticket("Picked", "needs-triage"));
execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "add", "-A"], { cwd: root });
execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "t"], { cwd: root });
const project = {
  name: "demo",
  root,
  baseBranch: "main",
  label: "ready-for-agent",
  gates: [],
  tracker: { kind: "files", held: "ready-for-human", triage: "needs-triage", dir: ".scratch", done: ["done"], source: "config" },
} as unknown as Project;
const tracker = makeTracker(project);

const turnWaiting = () => waitingTickets(project, tracker, wholeQueue(tracker, namedTickets(tracker, "shop-01")));

test("a later turn with ISSUES=<blocker> still records the queued dependants in waiting", async () => {
  const waiting = await turnWaiting();
  assert.deepEqual(waiting.map((w) => w.issue).sort(), ["shop-02", "shop-03"]);
  assert.ok(waiting.every((w) => w.on.length === 1));
  // The turn's own ticket and an unblocked, unnamed one are not waiting.
  assert.ok(!waiting.some((w) => w.issue === "shop-01" || w.issue === "shop-04"));
});

test("a named ticket that is not queued (hand-picked) is kept, and is not waiting", async () => {
  const whole = wholeQueue(tracker, namedTickets(tracker, "shop-05"));
  assert.ok(whole.some((t) => t.id === "shop-05"));
  assert.ok(!(await waitingTickets(project, tracker, whole)).some((w) => w.issue === "shop-05"));
});

test("once the blocker closes, gather reports the dependants runnable and the last turn is the cap", async () => {
  const waiting = await turnWaiting();
  recordRun(project, {
    issues: ["shop-01"],
    waiting,
    tickets: {
      "shop-01": { state: "merged", title: "Base" },
      ...Object.fromEntries(waiting.map((w) => [w.issue, { state: "blocked", title: w.issue }])),
    },
  });
  const run = JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8"));
  assert.deepEqual(run.waiting.map((w: { issue: string }) => w.issue).sort(), ["shop-02", "shop-03"]);

  // The turn lands the blocker: its file leaves the queue.
  writeFileSync(join(dir, "01-base.md"), ticket("Base", "done"));
  const facts = await gather(project);
  assert.deepEqual([...facts.runnable].sort(), ["shop-02", "shop-03"]);
  assert.deepEqual(facts.blocked, []);

  const again = rerunnable(facts);
  assert.ok(again);
  assert.equal(nextTurn(3, 3, again), "cap");
  assert.equal(nextTurn(3, 2, again), "run");
  const ids = again.unblocked;
  const line = capLine(3, ids, rerunList(again, refOf));
  assert.match(line, /3 turn\(s\) done, the cap; 2 ticket\(s\) can still run again/);
  assert.match(line, /`sandcastle run shop-02 shop-03` runs them/);
  assert.match(line, /`sandcastle run` takes the whole queue/);
});
