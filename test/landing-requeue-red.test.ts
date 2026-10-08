// A requeue after a red landing gate repairs from that gate's own output when the base has not moved
// (`repairFromRed`, src/landing.ts), and runs the gates first when it has: the merge the requeue makes is
// then the same tree the landing gate ran, so a gate run would only return the same red. Temp repos, a
// fake tracker and a host worktree for the sandbox: no Docker, no gh, no network. The requeue's own merge
// is made with git the way the pipeline's sandbox makes it, and read the way burndown.ts reads it
// (`git rev-list --parents`). The fake sandbox strips the `timeout -k` wrapper macOS lacks.
//
//   pnpm test:file test/landing-requeue-red.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne, repairFromRed } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;
type RedLanding = import("../src/landing.ts").RedLanding;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-requeue-red-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
// main holds shared.txt; each branch is cut from that start and changes the files it is given.
const makeRepo = (branches: Record<string, Record<string, string>>) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "shared.txt", "start\n", "start");
  for (const [id, files] of Object.entries(branches)) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    for (const [file, text] of Object.entries(files)) commitFile(root, file, text, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  return root;
};

const opener = (root: string): Ctx["opener"] => async (branch) => {
  const path = join(TMP, `wt${n++}`);
  git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  return {
    worktreePath: path,
    exec: async (cmd) => {
      const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    close: async () => git(root, "worktree", "remove", "--force", path),
  };
};

const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const failure = { name: "test", command: "test", exitCode: 1, output: "FAIL: a.txt and b.txt cannot both exist" };
const RED: GateRun = { gates: [{ name: "lint", pass: true }, { name: "test", pass: false }], failure, failures: [failure] };
const together: Ctx["gate"] = async (box) => ((await box.exec("test -e a.txt && test -e b.txt")).exitCode === 0 ? RED : GREEN);

const harness = (root: string) => {
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const reds = new Map<string, RedLanding>();
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, get: () => ({ body: "" }), close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: together,
    landed: new Map(),
    reds,
  };
  const land = (id: string) => landOne(ctx, { issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${id}`) });
  return { land, reds };
};

// What burndown.ts does for the requeue: merge the base into the branch, then read what the merge joined.
const requeueMerge = (root: string, id: string) => {
  const path = join(TMP, `requeue${n++}`);
  git(root, "worktree", "add", "-q", path, `agent/issue-${id}`);
  git(path, "merge", "--no-edit", "-q", "main");
  const [merge, head, base] = git(path, "rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/);
  git(root, "worktree", "remove", "--force", path);
  return { merge, head, base };
};

// 1 lands; 2 is green alone and red with 1.
const redWith1 = async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const h = harness(root);
  assert.equal((await h.land("1")).kind, "merged");
  assert.equal((await h.land("2")).kind, "red");
  return { root, ...h };
};

test("a red landing gate is kept for the requeue: the branch head, the base tip it ran on, the gates and the failing output", async () => {
  const head = (root: string) => git(root, "rev-parse", "agent/issue-2");
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const h = harness(root);
  await h.land("1");
  const head2 = head(root);
  const tip = git(root, "rev-parse", "main");
  await h.land("2");
  assert.deepEqual(h.reds.get("2"), { head: head2, base: tip, failure, gates: RED.gates });
  assert.equal(git(root, "rev-parse", "main"), tip, "a red merge moves nothing");
});

test("a requeue whose merge joins the tip the landing gate ran on repairs from that red, with no gate run", async () => {
  const { root, reds } = await redWith1();
  const joined = requeueMerge(root, "2");
  const red = repairFromRed(reds.get("2"), joined);
  assert.ok(red, "the gates are skipped");
  assert.equal(red.failure.output, "FAIL: a.txt and b.txt cannot both exist");
  assert.deepEqual(red.gates, RED.gates);
});

test("a requeue on a moved base runs the gates first", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" }, 3: { "c.txt": "c\n" } });
  const h = harness(root);
  await h.land("1");
  assert.equal((await h.land("2")).kind, "red");
  // Another ticket lands before the requeue's merge: it brings something new.
  assert.equal((await h.land("3")).kind, "merged");
  const joined = requeueMerge(root, "2");
  assert.equal(repairFromRed(h.reds.get("2"), joined), undefined);
});

test("a branch that is not the head the landing gate ran, a setup failure, a timeout or no record all leave it to the gates", async () => {
  const { root, reds } = await redWith1();
  const joined = requeueMerge(root, "2");
  const red = reds.get("2")!;
  assert.ok(repairFromRed(red, joined));
  assert.equal(repairFromRed(red, { ...joined, head: joined.base }), undefined);
  assert.equal(repairFromRed(red, undefined), undefined);
  assert.equal(repairFromRed(undefined, joined), undefined);
  assert.equal(repairFromRed({ ...red, failure: { ...failure, name: "setup" } }, joined), undefined);
  assert.equal(repairFromRed({ ...red, failure: { ...failure, exitCode: 124 } }, joined), undefined);
});
