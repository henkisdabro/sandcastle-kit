// A ticket the operator landed with `sandcastle land` after a run stopped: its run record still says
// `stopped` and its outcome said `stopped`, so `report --changelog` left it out and the closing summary
// did not call it merged. A temp git repo, the ticket-file tracker and a host worktree for the sandbox -
// no Docker, no model, no network.
//
//   pnpm test:file test/report-changelog-land.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@localhost" });
delete process.env.LINEAR_API_KEY;
const { landTicket } = await import("../src/land.ts");
const { changelogSince, gather, render } = await import("../src/report.ts");
const { mergedByHand, readOutcomes } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-changelog-land-"));
const started = "2026-10-01T08:00:00.000Z";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return r.stdout.trim();
};
const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

// main is tagged v1.0.0; tickets 01 and 02 each have a finished branch, which a run that stopped before
// landing left as `stopped`. 01's suggested lines are in heads.json, 02's nowhere.
const fixture = () => {
  const root = mkdtempSync(join(tmp, "repo-"));
  git(root, "init", "-q", "-b", "main");
  write(root, ".gitignore", ".sandcastle/\n");
  for (const num of ["01", "02"]) write(root, `.scratch/demo/issues/${num}-thing.md`, `# Ticket ${num}\n\nStatus: ready-for-agent\n\nDo it.\n`);
  git(root, "add", "-A");
  spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", "commit", "-q", "-m", "release"], { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: "2026-06-01T12:00:00Z", GIT_AUTHOR_DATE: "2026-06-01T12:00:00Z" } });
  git(root, "tag", "v1.0.0");
  const heads: Record<string, unknown> = {};
  for (const num of ["01", "02"]) {
    git(root, "checkout", "-q", "-b", `agent/issue-demo-${num}`, "main");
    write(root, `feature-${num}.txt`, "the feature\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `work ${num}`);
    heads[`demo-${num}`] = { branch: `agent/issue-demo-${num}`, green: git(root, "rev-parse", "HEAD"), ...(num === "01" ? { changelog: ["Added: the first feature.", "Upgrading: run setup again."] } : {}) };
  }
  git(root, "checkout", "-q", "main");
  const logs = ".sandcastle/logs";
  write(root, `${logs}/heads.json`, JSON.stringify(heads));
  const stopped = { state: "stopped", note: "finished before the run stopped - lands on a later run" };
  write(root, `${logs}/run.json`, JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: started, exitCode: 0, tickets: { "demo-01": { ...stopped, title: "First" }, "demo-02": { ...stopped, title: "Second" } } }));
  write(root, `${logs}/outcomes.json`, JSON.stringify(Object.fromEntries(["demo-01", "demo-02"].map((id) => [id, { run: started, kind: "stopped", text: "stopped: the run stopped before landing" }]))));
  const project = {
    name: "demo",
    root,
    baseBranch: "main",
    tracker: fakeTracker({ kind: "files" }),
    label: "ready-for-agent",
    changelog: true,
    gates: [{ name: "check", command: "true" }],
    setup: [],
    generated: [],
  } as unknown as Project;
  let n = 0;
  const open: Opener = async (branch) => {
    const path = join(tmp, `wt-${n++}`);
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    return {
      worktreePath: path,
      // execGate wraps commands in `timeout -k n n`, which macOS lacks.
      exec: async (cmd) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => git(root, "worktree", "remove", "--force", path),
    };
  };
  const land = async (id: string) => {
    const log = mock.method(console, "log", () => {});
    try {
      return await landTicket(project, makeTracker(project), id, () => ({ open }));
    } finally {
      log.mock.restore();
    }
  };
  return { root, project, land };
};

test("report --changelog lists tickets landed by `sandcastle land` after a stop, with the heads lines or under No suggested line", async () => {
  const f = fixture();
  assert.match(changelogSince(f.project), /^0 ticket\(s\) landed/);
  await f.land("demo-01");
  await f.land("demo-02");
  const out = changelogSince(f.project);
  assert.match(out, /^2 ticket\(s\) landed in runs started after v1\.0\.0/);
  assert.match(out, /^ {2}Added: the first feature\. \(demo-01\)$/m);
  assert.match(out, /^ {2}Upgrading: run setup again\. \(demo-01\)$/m);
  const bare = out.slice(out.indexOf("No suggested line"));
  assert.match(bare, /^ {2}demo-02 Second$/m);
  assert.doesNotMatch(bare, /demo-01/);
});

test("sandcastle land records the ticket's outcome as merged, and the closing summary words it as merged by hand", async () => {
  const f = fixture();
  await f.land("demo-01");
  const o = readOutcomes(f.root)["demo-01"];
  assert.equal(o.kind, "merged");
  // The stopped run's own entry: that run's summary still finds it.
  assert.equal(o.run, started);
  assert.equal(readOutcomes(f.root)["demo-02"].kind, "stopped");
  assert.equal(mergedByHand(f.root, "main", "demo-01"), true);
  assert.equal(mergedByHand(f.root, "main", "demo-02"), false);
  const text = render(await gather(f.project), true);
  assert.match(text, /1 stopped, merged by hand.*: demo-01/);
  // Only the ticket that was landed is merged; the other's branch is still unmerged work.
  assert.doesNotMatch(text, /merged by hand.*demo-02/);
  assert.match(text, /Agent branches with unmerged work: agent\/issue-demo-02/);
});
