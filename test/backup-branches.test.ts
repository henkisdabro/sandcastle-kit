// The agent branches in the shared .git (src/guard.ts, src/landing.ts): a deleted branch is
// restored from `.sandcastle/backup.git` even after its objects are gone, a moved tip for a ticket
// that is not running stops the run, a deleted base stops with the command that restores it, a
// squash landing, the kit's own delete and a ticket in flight raise no alarm, and a worktree
// record a sandbox rewrote is named. Temp repos, a fake tracker and a made-up sandbox: no Docker,
// no network; every write is under a temp directory.
//
//   pnpm exec tsx --test test/backup-branches.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { createStopState } = await import("../src/schedule.ts");
const { createHostGit, createLanding } = await import("../src/landing.ts");
const { assertGitUnchanged, backupRepo, gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Landed = import("../src/landing.ts").Landed;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-backup-branches-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
// Each branch forks from main with its own commit, as a finished pipeline leaves it.
const makeRepo = (ids: string[] = []) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  commitFile(root, "shared.txt", "start\n", "start");
  for (const id of ids) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    commitFile(root, `${id}.txt`, `${id}\n`, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  return root;
};
const project = (root: string, land = "merge") => ({ root, name: "fixture", baseBranch: "main", land, generated: [], gates: [], setup: [], mounts: [] }) as unknown as Project;

// What a container can do to a branch no live worktree holds: delete the ref, then remove the
// commits from the shared .git for good.
const destroy = (root: string, branch: string) => {
  git(root, "update-ref", "-d", `refs/heads/${branch}`);
  git(root, "reflog", "expire", "--expire=now", "--all");
  git(root, "gc", "-q", "--prune=now");
};
const resolves = (root: string, sha: string) => {
  try {
    git(root, "cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
};
const logged = async <T>(fn: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> => {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = real;
  }
};

// A run's start: the fingerprint, then every ticket's pipeline begins and ends as in burndown.ts.
const runWith = async (root: string, ids: string[], land = "merge") => {
  const p = project(root, land);
  const host = createHostGit(p, gitFingerprint(p));
  for (const id of ids) {
    host.begin(`agent/issue-${id}`);
    await host.settle(`agent/issue-${id}`, `after #${id}`);
  }
  return { p, host };
};

test("a deleted branch is restored from the backup after its objects were removed from the shared .git", async () => {
  const root = makeRepo(["1", "2"]);
  const tip = git(root, "rev-parse", "agent/issue-1");
  const other = git(root, "rev-parse", "agent/issue-2");
  const { host } = await runWith(root, ["1", "2"]);
  assert.ok(existsSync(join(backupRepo(project(root)), "HEAD")), "no backup repo made");

  destroy(root, "agent/issue-1");
  assert.equal(resolves(root, tip), false, "the commit survived the gc: the test proves nothing");

  const { lines } = await logged(() => host.check("before landing"));
  assert.equal(git(root, "rev-parse", "agent/issue-1"), tip);
  assert.equal(git(root, "rev-parse", "agent/issue-2"), other);
  assert.match(lines.join("\n"), /agent\/issue-1 was deleted from the shared \.git .* restored from the backup/);
  assert.equal(git(root, "show", "-s", "--format=%s", "agent/issue-1"), "work on 1");
  // Back where it was: the next check is quiet.
  await host.check("after #3");
});

test("the backup is a bare repo of its own with no alternates, ignored by the project's checkout", async () => {
  const root = makeRepo(["1"]);
  await runWith(root, ["1"]);
  const dir = backupRepo(project(root));
  assert.equal(git(dir, "rev-parse", "--is-bare-repository"), "true");
  assert.equal(existsSync(join(dir, "objects", "info", "alternates")), false);
  assert.equal(git(root, "status", "--porcelain"), "", "the backup repo shows in `git status`");
  assert.equal(git(dir, "rev-parse", "agent/issue-1"), git(root, "rev-parse", "agent/issue-1"));
});

test("a branch with no commits beyond the base is not copied", async () => {
  const root = makeRepo();
  git(root, "branch", "agent/issue-5");
  await runWith(root, ["5"]);
  assert.equal(existsSync(backupRepo(project(root))), false);
});

test("a tip that moved for a ticket that is not running stops the run, naming the branch", async () => {
  const root = makeRepo(["1", "2"]);
  const { host } = await runWith(root, ["1", "2"]);
  const old = git(root, "rev-parse", "agent/issue-2");
  git(root, "checkout", "-q", "agent/issue-2");
  commitFile(root, "evil.txt", "x\n", "rewritten by a sandbox");
  git(root, "checkout", "-q", "main");
  await assert.rejects(host.check("before landing"), (e: Error) => {
    assert.match(e.message, new RegExp(`^STOPPED before landing: agent/issue-2 ${old.slice(0, 12)} -> [0-9a-f]{12} moved while its ticket was not running`));
    assert.doesNotMatch(e.message, /issue-1/);
    assert.match(e.message, /update-ref refs\/heads\/<branch> <old tip>/);
    return true;
  });
});

test("a ticket in flight may move its branch and has only to exist", async () => {
  const root = makeRepo(["1"]);
  const p = project(root);
  const host = createHostGit(p, gitFingerprint(p));
  host.begin("agent/issue-1");
  git(root, "checkout", "-q", "agent/issue-1");
  commitFile(root, "more.txt", "more\n", "the agent keeps committing");
  git(root, "checkout", "-q", "main");
  await host.check("after #2");
  // A new branch the sandbox made is the pipeline's own, not yet expected.
  git(root, "branch", "agent/issue-9");
  host.begin("agent/issue-9");
  await host.check("after #3");
  // It ends: the tip it holds now is the expected one, and is backed up.
  await host.settle("agent/issue-1", "after #1");
  assert.equal(git(backupRepo(p), "rev-parse", "agent/issue-1"), git(root, "rev-parse", "agent/issue-1"));
  await host.check("before landing");
  git(root, "checkout", "-q", "agent/issue-1");
  commitFile(root, "late.txt", "late\n", "after the pipeline ended");
  git(root, "checkout", "-q", "main");
  await assert.rejects(host.check("before landing"), /agent\/issue-1 .* moved while its ticket was not running/);
});

test("a branch that vanishes while its ticket is in flight is restored from its recorded tip", async () => {
  const root = makeRepo(["1"]);
  const tip = git(root, "rev-parse", "agent/issue-1");
  const p = project(root);
  const host = createHostGit(p, gitFingerprint(p));
  host.begin("agent/issue-1");
  git(root, "update-ref", "-d", "refs/heads/agent/issue-1");
  const { lines } = await logged(() => host.check("after #2"));
  assert.equal(git(root, "rev-parse", "agent/issue-1"), tip);
  assert.match(lines.join("\n"), /restored from its recorded tip/);
});

test("a branch lost with its objects and no backup stops the run, saying so", async () => {
  const root = makeRepo(["1"]);
  const p = project(root);
  const host = createHostGit(p, gitFingerprint(p));
  destroy(root, "agent/issue-1");
  await assert.rejects(host.check("before landing"), /STOPPED before landing: agent\/issue-1 was deleted while sandboxes ran, and no copy of its commits survives/);
});

test("a deleted base stops with a clean message and the command that restores it", async () => {
  const root = makeRepo(["1"]);
  const p = project(root);
  const host = createHostGit(p, gitFingerprint(p));
  const tip = git(root, "rev-parse", "main");
  // `update-ref -d` does not mind that HEAD names it.
  git(root, "update-ref", "-d", "refs/heads/main");
  await assert.rejects(host.check("before landing"), (e: Error) => {
    assert.match(e.message, /^STOPPED before landing: main was deleted while sandboxes ran/);
    assert.ok(e.message.includes(`git -C ${root} update-ref refs/heads/main ${tip}`), e.message);
    assert.doesNotMatch(e.message, /fatal|Command failed/);
    return true;
  });
  // The command it names does what it says.
  git(root, "update-ref", "refs/heads/main", tip);
  await host.check("after the fix");
});

test("a moved base names the command that puts it back, with the old tip as a guard", async () => {
  const root = makeRepo();
  const p = project(root);
  const before = gitFingerprint(p);
  const old = before.base;
  commitFile(root, "ticket.md", "x\n", "a person's commit");
  const now = git(root, "rev-parse", "main");
  assert.throws(() => assertGitUnchanged(p, before, "before landing"), (e: Error) => {
    assert.ok(e.message.includes(`update-ref refs/heads/main ${old} ${now}`), e.message);
    return true;
  });
});

test("a moved base whose old tip is gone from the object store still stops cleanly", () => {
  const root = makeRepo();
  commitFile(root, "tip.txt", "x\n", "a tip that will be orphaned");
  const p = project(root);
  const before = gitFingerprint(p);
  git(root, "reset", "-q", "--hard", "HEAD~1");
  git(root, "reflog", "expire", "--expire=now", "--all");
  git(root, "gc", "-q", "--prune=now");
  assert.throws(() => assertGitUnchanged(p, before, "before landing"), /^Error: STOPPED before landing: main moved while sandboxes ran \([0-9a-f]{7} -> [0-9a-f]{7}, not a fast-forward\)/s);
});

test("a squash landing, which deletes its branch, raises no alarm and drops the backup", async () => {
  const root = makeRepo(["1", "2"]);
  const { p, host } = await runWith(root, ["1", "2"], "squash");
  const kept = git(root, "rev-parse", "agent/issue-2");
  const settled: Landed[] = [];
  const ctx: Ctx = {
    project: p,
    tracker: { ref: (id: string) => `#${id}`, close: () => {}, comment: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: async () => {
      throw new Error("a branch that holds the base lands without a sandbox");
    },
    withdrawal: () => undefined,
    host,
    gate: async () => ({ gates: [], failures: [] }),
    landed: new Map(),
  };
  const landing = createLanding(ctx, createStopState(host), { settled: (_o, landed) => void settled.push(landed), stopped: () => {} });
  landing.push({ issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", "agent/issue-1") });
  landing.close();
  await landing.run();
  assert.equal(settled[0]?.kind, "merged");
  assert.equal(settled[0] && "squashed" in settled[0] && settled[0].squashed, true);
  assert.throws(() => git(root, "rev-parse", "--verify", "-q", "refs/heads/agent/issue-1"), "the squashed branch is still there");

  const { lines } = await logged(() => host.check("after #1"));
  assert.deepEqual(lines, []);
  assert.throws(() => git(root, "rev-parse", "--verify", "-q", "refs/heads/agent/issue-1"), "the kit's own delete was restored");
  assert.throws(() => git(backupRepo(p), "rev-parse", "--verify", "-q", "refs/heads/agent/issue-1"), "its backup entry stayed");
  // The ticket still waiting keeps its copy.
  assert.equal(git(backupRepo(p), "rev-parse", "agent/issue-2"), kept);
});

test("a landed branch the kit forgets is not restored when it is deleted afterwards", async () => {
  const root = makeRepo(["1"]);
  const { host } = await runWith(root, ["1"]);
  host.forget("agent/issue-1");
  git(root, "branch", "-D", "agent/issue-1");
  const { lines } = await logged(() => host.check("after #2"));
  assert.deepEqual(lines, []);
  assert.throws(() => git(root, "rev-parse", "--verify", "-q", "refs/heads/agent/issue-1"));
});

test("a landing sandbox's check shares the run's branches: tickets that start or end during it are no alarm", async () => {
  const root = makeRepo(["1", "2"]);
  const p = project(root);
  const host = createHostGit(p, gitFingerprint(p));
  // The landing worker's own fingerprint, taken while ticket 2's pipeline is about to begin.
  const own = gitFingerprint(p, host.expected);
  host.begin("agent/issue-2");
  git(root, "checkout", "-q", "agent/issue-2");
  commitFile(root, "more.txt", "more\n", "the agent commits meanwhile");
  git(root, "checkout", "-q", "main");
  assert.doesNotThrow(() => assertGitUnchanged(p, own, "after landing agent/issue-1 in a sandbox"));
  await host.settle("agent/issue-2", "after #2");
  assert.doesNotThrow(() => assertGitUnchanged(p, own, "after landing agent/issue-1 in a sandbox"));
});

test("a worktree record a sandbox rewrote to its container path is named", async () => {
  const root = makeRepo();
  const p = project(root);
  const worktrees = join(root, ".sandcastle", "worktrees");
  mkdirSync(worktrees, { recursive: true });
  git(root, "worktree", "add", "-q", "-b", "agent/issue-3", join(worktrees, "agent-issue-3"), "main");
  git(root, "worktree", "add", "-q", "-b", "agent/issue-4", join(worktrees, "agent-issue-4"), "main");
  // A person's own worktree is theirs to put where they like.
  const mine = join(TMP, `mine${n++}`);
  git(root, "worktree", "add", "-q", "-b", "feature", mine, "main");
  const host = createHostGit(p, gitFingerprint(p));
  await host.check("after #1");

  // What `git worktree repair` leaves behind in a container: the record points at the container's path.
  const record = join(root, ".git", "worktrees", "agent-issue-3", "gitdir");
  assert.ok(readFileSync(record, "utf8").trim().endsWith(`${sep}agent-issue-3${sep}.git`) || readFileSync(record, "utf8").includes("agent-issue-3"));
  writeFileSync(record, "/home/agent/workspace/.git\n");
  await assert.rejects(host.check("after #1"), (e: Error) => {
    assert.match(e.message, /^STOPPED after #1: the worktree record of agent-issue-3 no longer holds its host path/);
    assert.doesNotMatch(e.message, /agent-issue-4|feature/);
    return true;
  });
});

test("a worktree record git wrote as a relative path (worktree.useRelativePaths) is no alarm", async () => {
  const root = makeRepo();
  const p = project(root);
  const worktrees = join(root, ".sandcastle", "worktrees");
  mkdirSync(worktrees, { recursive: true });
  git(root, "worktree", "add", "-q", "-b", "agent/issue-3", join(worktrees, "agent-issue-3"), "main");
  const host = createHostGit(p, gitFingerprint(p));
  // What git 2.48+ writes with the setting on: the path from the record's own directory.
  const records = realpathSync(join(root, ".git", "worktrees", "agent-issue-3"));
  const record = join(records, "gitdir");
  writeFileSync(record, `${relative(records, realpathSync(join(worktrees, "agent-issue-3", ".git")))}\n`);
  assert.ok(!isAbsolute(readFileSync(record, "utf8").trim()));
  await host.check("after #1");
});

test("no mount of a sandbox reaches the backup repo", async () => {
  const root = makeRepo();
  const p = project(root);
  const worktrees = join(root, ".sandcastle", "worktrees");
  mkdirSync(worktrees, { recursive: true });
  const worktree = join(worktrees, "agent-issue-1");
  git(root, "worktree", "add", "-q", "-b", "agent/issue-1", worktree, "main");
  await runWith(root, []);
  const backup = backupRepo(p);
  // Sandcastle mounts the worktree, and the `.git` its `.git` file names (resolveGitMounts); the
  // rest are the project's own `mounts`, none by default.
  const gitdir = /^gitdir:\s*(.+)$/.exec(readFileSync(join(worktree, ".git"), "utf8").trim())![1];
  const mounts = [worktree, join(worktree, ".git"), resolve(gitdir, "..", ".."), ...(p.mounts ?? []).map((m) => m.hostPath)];
  assert.ok(mounts.some((m) => m.endsWith(`${sep}.git`)), "the shared .git is not among the mounts: the test reads the wrong thing");
  for (const m of mounts) {
    const dir = m.endsWith(sep) ? m : m + sep;
    assert.ok(!(backup + sep).startsWith(dir), `${m} contains ${backup}`);
    assert.ok(!dir.startsWith(backup + sep), `${m} is inside ${backup}`);
  }
});
