// The tip backup repository (`.sandcastle/backup.git`, src/guard.ts) stays small: it keeps a copy
// of the base branch so a fetch is thin, and a drop that leaves no agent branch prunes it, so
// many backups and drops leave a bounded pack count - while a vanished branch is still restored
// from it. Temp repos only: no Docker, no network.
//
//   pnpm test:file test/backup-size.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { backupBranch, backupRepo, dropBackup, gitFingerprint } = await import("../src/guard.ts");
const { createHostGit } = await import("../src/landing.ts");
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-backup-size-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const project = (root: string) => ({ root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [], mounts: [] }) as unknown as Project;
const packs = (p: Project) => readdirSync(join(backupRepo(p), "objects", "pack")).filter((f) => f.endsWith(".pack")).length;

// Over fetch.unpackLimit (100 objects), so each fetch keeps a pack instead of loose objects.
const files = (root: string, dir: string, count: number) => {
  mkdirSync(join(root, dir), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, dir, `f${i}.txt`), `${dir} ${i}\n`);
  git(root, "add", dir);
};

const makeRepo = () => {
  const root = join(TMP, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  files(root, "base", 150);
  git(root, "commit", "-q", "-m", "start");
  return root;
};
const branchWork = (root: string, id: number) => {
  git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
  files(root, `work${id}`, 120);
  git(root, "commit", "-q", "-m", `work on ${id}`);
  git(root, "checkout", "-q", "main");
};

test("many backups and drops leave a bounded pack count, a base ref and no stray objects", () => {
  const root = makeRepo();
  const p = project(root);
  for (let id = 1; id <= 6; id++) {
    branchWork(root, id);
    backupBranch(p, `agent/issue-${id}`);
    assert.ok(packs(p) <= 2, `${packs(p)} packs after backup ${id}`);
    dropBackup(p, `agent/issue-${id}`);
    assert.equal(packs(p), 1, `${packs(p)} packs after drop ${id}: no gc`);
  }
  const dir = backupRepo(p);
  assert.equal(git(dir, "for-each-ref", "refs/heads/"), "", "an agent ref is left");
  assert.equal(git(dir, "rev-parse", "refs/base"), git(root, "rev-parse", "main"));
  assert.match(git(dir, "count-objects", "-v"), /^count: 0$/m, "loose objects are left");
  // Dropped work is pruned: only the base's objects remain (150 files, a tree, a commit, a subtree).
  assert.ok(Number(/^in-pack: (\d+)$/m.exec(git(dir, "count-objects", "-v"))![1]) < 200);
});

test("a branch still waiting keeps its objects when another is dropped", () => {
  const root = join(TMP, "repo");
  const p = project(root);
  branchWork(root, 7);
  branchWork(root, 8);
  backupBranch(p, "agent/issue-7");
  backupBranch(p, "agent/issue-8");
  const seven = git(root, "rev-parse", "agent/issue-7");
  dropBackup(p, "agent/issue-8");
  assert.equal(git(backupRepo(p), "rev-parse", "agent/issue-7"), seven);
  git(backupRepo(p), "fsck", "--no-dangling");
});

test("a fetch after the last drop is thin: the base's history is not sent again", () => {
  const root = join(TMP, "repo");
  const p = project(root);
  dropBackup(p, "agent/issue-7");
  const dir = backupRepo(p);
  const held = Number(/^in-pack: (\d+)$/m.exec(git(dir, "count-objects", "-v"))![1]);
  branchWork(root, 9);
  backupBranch(p, "agent/issue-9");
  const total = Number(/^in-pack: (\d+)$/m.exec(git(dir, "count-objects", "-v"))![1]);
  // 120 files, their tree, the root tree and the commit: the work's own objects, not the base's 150 files again.
  assert.ok(total - held < 130, `${total - held} objects came in for a 123-object branch`);
});

// A fetch starts `git maintenance run --auto --detach`, which repacked the backup in the
// background and raced the pack counts above (and the drop's own gc) on a loaded CI machine.
test("a backup and a drop start no background maintenance in the backup repo", () => {
  const root = join(TMP, "repo");
  const p = project(root);
  const trace = join(TMP, "git-trace.log");
  branchWork(root, 10);
  process.env.GIT_TRACE = trace;
  try {
    backupBranch(p, "agent/issue-10");
    dropBackup(p, "agent/issue-10");
  } finally {
    delete process.env.GIT_TRACE;
  }
  assert.doesNotMatch(readFileSync(trace, "utf8"), /run_command: git maintenance run/);
});

test("a vanished branch is restored from the pruned backup after the shared .git lost its objects", async () => {
  const root = join(TMP, "repo2");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  files(root, "base", 150);
  git(root, "commit", "-q", "-m", "start");
  branchWork(root, 1);
  branchWork(root, 2);
  const p = project(root);
  const host = createHostGit(p, gitFingerprint(p));
  const tip = git(root, "rev-parse", "agent/issue-2");
  for (const id of [1, 2]) {
    host.begin(`agent/issue-${id}`);
    await host.settle(`agent/issue-${id}`, `after #${id}`);
  }
  // Ticket 1 lands: its entry goes and the backup is pruned; ticket 2's copy must survive that.
  dropBackup(p, "agent/issue-1");
  git(root, "update-ref", "-d", "refs/heads/agent/issue-2");
  git(root, "reflog", "expire", "--expire=now", "--all");
  git(root, "gc", "-q", "--prune=now");
  assert.throws(() => git(root, "cat-file", "-e", `${tip}^{commit}`), "the commit survived the gc: the test proves nothing");
  const real = console.log;
  console.log = () => {};
  try {
    await host.check("before landing");
  } finally {
    console.log = real;
  }
  assert.equal(git(root, "rev-parse", "agent/issue-2"), tip);
  assert.equal(git(root, "show", "-s", "--format=%s", "agent/issue-2"), "work on 2");
});
