// A ticket an earlier turn of a drain run left uncommitted (its commit was refused, the work sits in a kept
// worktree) is carried into the last turn's closing summary: a Needs you bullet marked with its turn, a place
// in the headline's need-you count and a Next step. `rerunnable` never re-runs such a ticket, so no later turn
// would say it. Made-up run.json and history.jsonl records of one run's two turns in a temp git repo; no
// Docker, model or network.
//
//   pnpm test:file test/report-drain-carry-uncommitted.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

const PID = 4242;
const WT = ".sandcastle/worktrees/agent-issue-shop-01";
const turn1 = {
  orchestrator: "demo",
  pid: PID,
  startedAt: "2026-10-01T08:00:00.000Z",
  finishedAt: "2026-10-01T08:30:00.000Z",
  exitCode: 0,
  settings: { autonomy: "drain", turn: 1, cap: 20 },
  tickets: { "shop-01": { state: "uncommitted", title: "Refused commit", note: `work left uncommitted in ${WT}` } },
  keptWorktrees: [{ issue: "shop-01", path: WT }],
  verify: null,
};
const turn2 = {
  orchestrator: "demo",
  pid: PID,
  startedAt: "2026-10-01T08:31:00.000Z",
  finishedAt: "2026-10-01T09:00:00.000Z",
  exitCode: 0,
  settings: { autonomy: "drain", turn: 2, cap: 20 },
  tickets: { "shop-02": { state: "merged", title: "Clean one" } },
  keptWorktrees: [],
  verify: null,
};

const project = (t: { after: (fn: () => void) => void }, current: object = turn2): Project => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-drain-uncommitted-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const dir = join(root, ".scratch/shop/issues");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-refused.md"), "# Refused commit\n\nStatus: ready-for-agent\n\nDo it.\n\n## Comments\n");
  writeFileSync(join(dir, "02-clean.md"), "# Clean one\n\nStatus: done\n\nDo it.\n\n## Comments\n");
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "worktree", "add", "-q", "-b", "agent/issue-shop-01", join(root, WT));
  const logs = join(root, ".sandcastle/logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "run.json"), JSON.stringify(current));
  writeFileSync(join(logs, "history.jsonl"), JSON.stringify(turn1) + "\n");
  return { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
};

const summary = async (p: Project) => render(await gather(p, () => "sandcastle run"), true);

test("an earlier turn's refused commit is under Needs you, marked with its turn", async (t) => {
  const out = await summary(project(t));
  const needs = body(out, "## Needs you");
  assert.match(needs, new RegExp(`^- shop-01 Refused commit - finished but not committed - the work is in ${WT.replace(/\./g, "\\.")}\\. .*requeue.* \\(turn 1\\)$`, "m"));
});

test("an earlier turn's refused commit is counted in the headline's need-you count", async (t) => {
  const out = await summary(project(t));
  assert.match(out, / - 1 need you - 0 need fixing - /);
});

test("an earlier turn's refused commit gets the commit step, marked with its turn", async (t) => {
  const out = await summary(project(t));
  assert.match(body(out, "## Next step"), /Commit the finished work of shop-01: fix what refused the commit .*\(paths under Needs you\) \(turn 1\)\./);
});

test("a refused commit of the last turn is said once, without a turn mark", async (t) => {
  const own = { ...turn2, tickets: { "shop-01": turn1.tickets["shop-01"] }, keptWorktrees: turn1.keptWorktrees };
  const out = await summary(project(t, own));
  assert.doesNotMatch(out, /\(turn \d+\)/);
  assert.equal(body(out, "## Needs you").match(/finished but not committed/g)?.length, 1);
  assert.equal(body(out, "## Next step").match(/Commit the finished work/g)?.length, 1);
  assert.match(out, / - 1 need you - /);
});
