// The closing summary counts every worktree left under `.sandcastle/worktrees/`, not only the ones this
// run kept: earlier runs' pile up (about a GB each) and, with their branches merged, no other line
// ever sent the person to `sandcastle clean`. A live run's partial summary leaves out worktrees in flight.
//
//   pnpm test:file test/report-kept-earlier.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Facts = import("../src/report.ts").Facts;
type Project = import("../src/config.ts").Project;

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "97.5M in / 725k out",
  verify: { green: true, line: "ruff=pass pytest=pass" },
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};
const state = (f: Facts) => body(render(f), "## 📤 Local state");
const nextStep = (f: Facts) => body(render(f), "## 👉 Next step");

const GB = 1024 * 1024;
const wt = (n: number, over: Partial<NonNullable<Facts["earlierKept"]>[number]> = {}) => ({ path: `.sandcastle/worktrees/agent-issue-${n}`, issue: String(n), merged: true, ...over });
const many = (count: number, kb: number) => Array.from({ length: count }, (_, i) => wt(i + 1, { kb }));

test("45 merged worktrees from earlier runs: counted with their disk use, and the next step is sandcastle clean", () => {
  const f = facts({ earlierKept: many(45, 1.1 * GB) });
  assert.match(state(f), /^Worktrees kept by earlier runs: 45 worktrees \(50 GB on disk\) - 45 merged, 0 with work not on main$/m);
  const next = nextStep(f);
  assert.match(next, /`sandcastle clean` removes the 45 merged worktrees kept by earlier runs \(50 GB on disk\), with the branches they hold/);
});

test("under 1 GB the disk use is not said", () => {
  const f = facts({ earlierKept: many(3, 100 * 1024) });
  assert.match(state(f), /^Worktrees kept by earlier runs: 3 worktrees - 3 merged, 0 with work not on main$/m);
  assert.doesNotMatch(render(f), /GB/);
});

test("exactly 1 GB is said, with one decimal below 10 GB", () => {
  assert.match(state(facts({ earlierKept: [wt(1, { kb: GB })] })), /1 worktree \(1\.0 GB on disk\)/);
});

test("an earlier worktree whose branch has work off the base is counted but not sent to clean, which would delete its files", () => {
  const f = facts({ earlierKept: [wt(1, { merged: false })] });
  assert.match(state(f), /Worktrees kept by earlier runs: 1 worktree - 0 merged, 1 with work not on main/);
  assert.doesNotMatch(nextStep(f), /sandcastle clean/);
});

test("merged and unmerged together: the clean step says the unmerged ones go too, after a look", () => {
  const f = facts({ earlierKept: [wt(1), wt(2, { merged: false })] });
  assert.match(nextStep(f), /removes the 1 merged worktree kept by earlier runs, and the 1 that hold work not on main \(their uncommitted files too: look at those first\)/);
});

test("with a branch standing, the one clean line also names the earlier worktrees", () => {
  const next = nextStep(facts({ standing: ["agent/issue-9"], earlierKept: many(2, 10) }));
  assert.equal(next.split("`sandcastle clean`").length - 1, 1);
  assert.match(next, /`sandcastle clean` once the branches above are resolved: it also removes the 2 merged worktrees kept by earlier runs\./);
});

test("this run's own merged kept worktree and earlier ones: still one clean step", () => {
  const next = nextStep(facts({ tickets: { "7": { state: "merged", title: "a" } }, keptWorktrees: [{ issue: "7", path: ".sandcastle/worktrees/agent-issue-7" }], earlierKept: many(2, 10) }));
  assert.equal(next.split("`sandcastle clean`").length - 1, 1);
  assert.match(next, /Among them: the 2 merged worktrees kept by earlier runs\./);
});

test("on a red base there is no clean step, and no earlier worktrees leaves the summary as before", () => {
  assert.doesNotMatch(nextStep(facts({ stage: "base gates", exitCode: 1, baseRed: ["t"], earlierKept: many(2, 10) })), /sandcastle clean/);
  assert.doesNotMatch(render(facts()), /earlier runs/);
});

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repo with kept worktrees: 3 merged (and dirty), 4 holding a commit the base lacks, 5 this run's own, 6 a ticket of this run still in flight. */
const repo = (record: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-kept-earlier-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  mkdirSync(join(root, ".sandcastle/worktrees"), { recursive: true });
  for (const id of ["3", "4", "5", "6"]) {
    git(root, "worktree", "add", "-q", "-b", `agent/issue-${id}`, join(root, `.sandcastle/worktrees/agent-issue-${id}`), "main");
  }
  git(join(root, ".sandcastle/worktrees/agent-issue-4"), "commit", "-q", "--allow-empty", "-m", "unmerged work");
  // The dirt a gate leaves behind in a merged ticket's worktree.
  writeFileSync(join(root, ".sandcastle/worktrees/agent-issue-3/generated.lock"), "x\n");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", startedAt: "2026-10-02T08:00:00.000Z", stage: "report", ...record }));
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  return { root, project };
};

test("gather: an earlier run's merged and unmerged worktrees are found, with their disk use read from the tree", async () => {
  const { project } = repo({ pid: 1, finishedAt: "2026-10-02T09:00:00.000Z", exitCode: 0, tickets: {} });
  const f = await gather(project, () => undefined);
  const byIssue = Object.fromEntries((f.earlierKept ?? []).map((k) => [k.issue, k.merged]));
  assert.deepEqual(byIssue, { "3": true, "4": false, "5": true, "6": true });
  assert.ok((f.earlierKept ?? []).every((k) => typeof k.kb === "number" && k.kb > 0));
});

test("gather: this run's kept worktree (recorded by its path) is the run's own line, not an earlier one", async () => {
  const { root, project } = repo({ pid: 1, finishedAt: "2026-10-02T09:00:00.000Z", exitCode: 0, tickets: {} });
  const own = join(root, ".sandcastle/worktrees/agent-issue-5");
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: "2026-10-02T08:00:00.000Z", finishedAt: "2026-10-02T09:00:00.000Z", exitCode: 0, stage: "report", tickets: { "5": { state: "merged", title: "five" } }, keptWorktrees: [{ issue: "5", path: own }] }));
  const f = await gather(project, () => undefined);
  assert.deepEqual((f.earlierKept ?? []).map((k) => k.issue).sort(), ["3", "4", "6"]);
  const out = render(f);
  assert.match(body(out, "## 📤 Local state"), /Worktree kept with uncommitted files: #5/);
  assert.match(body(out, "## 📤 Local state"), /Worktrees kept by earlier runs: 3 worktrees - 2 merged, 1 with work not on main/);
});

test("gather: a live run leaves out the worktrees of its own tickets, still in flight", async () => {
  const { project } = repo({ pid: 4242, tickets: { "6": { state: "implement", title: "six" } } });
  const f = await gather(project, (pid) => (pid === 4242 ? "node src/cli.ts run" : undefined));
  assert.equal(f.live, true);
  assert.deepEqual((f.earlierKept ?? []).map((k) => k.issue).sort(), ["3", "4", "5"]);
});
