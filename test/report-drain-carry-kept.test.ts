// A kept worktree of a ticket that merged in an earlier turn of a drain run is named in the last turn's
// closing summary like the last turn's own: a Local state line and the look-then-clean step, marked with its
// turn, and it is not counted a second time among "worktrees kept by earlier runs". Made-up run.json and
// history.jsonl records of one run's two turns in a temp git repo with a real worktree; no Docker, model or network.
//
//   pnpm test:file test/report-drain-carry-kept.test.ts

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
const turn1 = (over: Record<string, unknown> = {}) => ({
  orchestrator: "demo",
  pid: PID,
  startedAt: "2026-10-01T08:00:00.000Z",
  finishedAt: "2026-10-01T08:30:00.000Z",
  exitCode: 0,
  settings: { autonomy: "drain", turn: 1, cap: 20 },
  tickets: { "shop-01": { state: "merged", title: "Kept one" } },
  keptWorktrees: [{ issue: "shop-01", path: WT }],
  verify: null,
  ...over,
});
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

const project = (t: { after: (fn: () => void) => void }, first: object): Project => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-drain-kept-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const dir = join(root, ".scratch/shop/issues");
  mkdirSync(dir, { recursive: true });
  for (const [file, title] of [["01-kept.md", "Kept one"], ["02-clean.md", "Clean one"]]) writeFileSync(join(dir, file), `# ${title}\n\nStatus: done\n\nDo it.\n\n## Comments\n`);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  // The merged ticket's worktree is still on disk, on a branch with nothing the base lacks.
  git(root, "worktree", "add", "-q", "-b", "agent/issue-shop-01", join(root, WT));
  const logs = join(root, ".sandcastle/logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "run.json"), JSON.stringify(turn2));
  writeFileSync(join(logs, "history.jsonl"), JSON.stringify(first) + "\n");
  return { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
};

const summary = async (p: Project) => render(await gather(p, () => "sandcastle run"), true);

test("an earlier turn's merged ticket with a kept worktree gets its Local state line and the look-then-clean step", async (t) => {
  const out = await summary(project(t, turn1()));
  assert.match(body(out, "## Local state"), new RegExp(`^Worktree kept with uncommitted files: shop-01 - ${WT.replace(/\./g, "\\.")} \\(turn 1\\)$`, "m"));
  assert.match(body(out, "## Next step"), /Look at the files left in the kept worktree of shop-01 \(`\.sandcastle\/worktrees\/agent-issue-shop-01`, turn 1\): its work is merged\. Then `sandcastle clean` removes it/);
});

test("the same worktree is not also counted among those kept by earlier runs", async (t) => {
  const out = await summary(project(t, turn1()));
  assert.doesNotMatch(out, /Worktrees kept by earlier runs/);
  assert.doesNotMatch(body(out, "## Next step"), /kept by earlier runs/);
});

test("a turn whose ticket a later turn ran again names no worktree of the earlier ending", async (t) => {
  const p = project(t, turn1());
  writeFileSync(join(p.root, ".sandcastle/logs/run.json"), JSON.stringify({ ...turn2, tickets: { "shop-01": { state: "merged", title: "Kept one" } } }));
  const out = await summary(p);
  assert.doesNotMatch(body(out, "## Local state"), /Worktree kept with uncommitted files/);
});
