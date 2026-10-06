// The tip backup (`.sandcastle/backup.git`, src/guard.ts) is pruned at a run's start and by
// `sandcastle clean`: a backup ref whose branch was merged into the base by hand is dropped, and with
// no ref left the backup's objects are pruned. A ref for an unmerged branch is kept, even once the
// branch is gone - the backup may be its only copy - unless `sandcastle clean --all` let it go. burndown() and `clean` need Docker, so no test drives
// them: the guard's own `pruneBackup` is run against temp repos, and the two callers are held by
// their source, as start-output-order.test.ts does.
//
//   node --test test/backup-prune.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { backupBranch, backupRepo, pruneBackup } = await import("../src/guard.ts");
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-backup-prune-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const project = (root: string) => ({ root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [], mounts: [] }) as unknown as Project;

// Over fetch.unpackLimit (100 objects), so each backup keeps a pack of its own, as a real branch's does.
const files = (root: string, dir: string, count: number) => {
  mkdirSync(join(root, dir), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, dir, `f${i}.txt`), `${dir} ${i}\n`);
  git(root, "add", dir);
};

const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  files(root, "base", 5);
  git(root, "commit", "-q", "-m", "start");
  return root;
};

// A finished pipeline's branch: its own commits off main, copied to the backup, checkout back on main.
const held = (root: string, id: string) => {
  const branch = `agent/issue-${id}`;
  git(root, "checkout", "-q", "-b", branch, "main");
  files(root, `work${id}`, 120);
  git(root, "commit", "-q", "-m", `work on ${id}`);
  git(root, "checkout", "-q", "main");
  backupBranch(project(root), branch);
  return branch;
};

const refs = (root: string) => {
  try {
    return git(backupRepo(project(root)), "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
// What `gc --prune=now` leaves is one pack of what the backup's refs reach: the copied base only.
const stored = (root: string) => git(backupRepo(project(root)), "count-objects", "-v");
const objects = (root: string) => {
  const total = (key: string) => Number(stored(root).match(new RegExp(`^${key}: (\\d+)`, "m"))![1]);
  return total("count") + total("in-pack");
};

test("a held branch merged into the base by hand loses its backup at the next run's start, and the backup is pruned", () => {
  const root = makeRepo();
  const branch = held(root, "1");
  const before = objects(root);
  assert.deepEqual(refs(root), [branch]);
  // By hand: not through the kit, so nothing calls dropBackup. The branch is merged, and stays.
  git(root, "merge", "-q", "--no-ff", "-m", "merge by hand", branch);

  const dropped = pruneBackup(project(root));

  assert.deepEqual(dropped, [branch]);
  assert.deepEqual(refs(root), []);
  // The 120 files of work are gone from the backup; the base copy and the commits it reaches stay.
  assert.ok(objects(root) < before - 100, `${objects(root)} objects left of ${before}: the backup was not pruned`);
  assert.equal(git(backupRepo(project(root)), "rev-parse", "refs/base"), git(root, "rev-parse", "HEAD~1"), "the base copy stays, so the next fetch is thin");
});

test("a deleted unmerged branch keeps its backup at a run's start, its only copy; clean --all drops it and prunes", () => {
  const root = makeRepo();
  const branch = held(root, "2");
  const tip = git(root, "rev-parse", branch);
  const before = objects(root);
  git(root, "branch", "-D", branch);

  assert.deepEqual(pruneBackup(project(root)), []);
  assert.deepEqual(refs(root), [branch]);
  assert.equal(git(backupRepo(project(root)), "rev-parse", `refs/heads/${branch}`), tip, "still restorable from the backup");

  assert.deepEqual(pruneBackup(project(root), { goneToo: true }), [branch]);
  assert.deepEqual(refs(root), []);
  assert.ok(objects(root) < before - 100, `${objects(root)} objects left of ${before}: the backup was not pruned`);
});

test("a deleted branch whose commits are on the base is dropped at a run's start", () => {
  const root = makeRepo();
  const branch = held(root, "8");
  git(root, "merge", "-q", "--no-ff", "-m", "merge by hand", branch);
  git(root, "branch", "-D", branch);
  assert.deepEqual(pruneBackup(project(root)), [branch]);
  assert.deepEqual(refs(root), []);
});

test("a backup of an unmerged branch that still exists is kept, beside the dropped one of a merged branch", () => {
  const root = makeRepo();
  const merged = held(root, "3");
  const unmerged = held(root, "4");
  const tip = git(root, "rev-parse", unmerged);
  git(root, "merge", "-q", "--no-ff", "-m", "merge by hand", merged);

  assert.deepEqual(pruneBackup(project(root)), [merged]);
  assert.deepEqual(refs(root), [unmerged]);
  assert.equal(git(backupRepo(project(root)), "rev-parse", `refs/heads/${unmerged}`), tip);
  // Still restorable: its commits are in the backup.
  assert.equal(git(backupRepo(project(root)), "show", "-s", "--format=%s", unmerged), "work on 4");
});

test("with every backup kept, nothing is dropped or pruned", () => {
  const root = makeRepo();
  const branch = held(root, "5");
  const before = stored(root);
  assert.deepEqual(pruneBackup(project(root)), []);
  assert.deepEqual(refs(root), [branch]);
  assert.equal(stored(root), before);
});

test("a project that never made a backup has nothing to prune and no backup repo is made", () => {
  const root = makeRepo();
  assert.deepEqual(pruneBackup(project(root)), []);
  assert.deepEqual(refs(root), []);
});

test("a base branch that does not exist drops nothing at a run's start, and only deleted branches' backups with clean --all", () => {
  const root = makeRepo();
  const gone = held(root, "6");
  const kept = held(root, "7");
  git(root, "branch", "-D", gone);
  // The ancestor test has nothing to compare with, so a merged branch could not be told from an unmerged one.
  const nowhere = { ...project(root), baseBranch: "nowhere" } as Project;
  assert.deepEqual(pruneBackup(nowhere), []);
  assert.deepEqual(pruneBackup(nowhere, { goneToo: true }), [gone]);
  assert.deepEqual(refs(root), [kept]);
});

test("a run's start and `sandcastle clean` both prune the backup", () => {
  const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const run = src("burndown.ts");
  const body = run.indexOf("export const burndown = ");
  const lock = run.indexOf("lockRun(project);", body);
  const prune = run.indexOf("pruneBackup(project)", body);
  assert.ok(lock > 0 && prune > lock, "burndown prunes the backup once it holds the run lock");
  assert.ok(prune < run.indexOf("tracker.queued()", body), "and before any ticket starts");

  const cli = src("cli.ts");
  const clean = cli.indexOf('case "clean": {');
  assert.ok(clean > 0);
  const cleaned = cli.indexOf("cleanProject(project", clean);
  const pruned = cli.indexOf("pruneBackup(project, { goneToo: args.includes(\"--all\") })", clean);
  assert.ok(cleaned > 0 && pruned > cleaned, "clean prunes the backup after it deleted the finished branches, unmerged ones' too with --all");
});
