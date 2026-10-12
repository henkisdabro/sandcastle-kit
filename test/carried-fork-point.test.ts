// A carried branch that never merged the base, forked from a base tip a later rewrite removed (a reset that
// dropped a landing, a rebase that flattened landings into copies), has no merge commit to read the old base
// from. The kit records the base tip when it cuts an agent branch (`addWorktree`, src/guard.ts) and
// `staleBaseParents` (src/sandbox.ts) counts one the base no longer holds as the old base, so `ownCommits`
// leaves the lost commits out and `rebuildOnBase` (src/resolution.ts) re-creates the branch on the base's tip.
// Real git in a temp repo, a host worktree as the sandbox; no Docker, model or network.
//
//   pnpm test:file test/carried-fork-point.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { addWorktree } = await import("../src/guard.ts");
const { forgetHead, recordHead } = await import("../src/run.ts");
const { forgetFork, ownCommits, staleBaseParents } = await import("../src/sandbox.ts");
const { rebuildOnBase } = await import("../src/resolution.ts");
const { hostIdentity } = await import("../src/generated.ts");
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-fork-point-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const BRANCH = "agent/issue-2";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string, message = `change ${file}`) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

/** A project on main with `shared.txt`, and the branch's worktree: where the kit would cut it. */
const harness = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n", "start");
  const project = { root, name: "fixture", baseBranch: "main" } as unknown as Project;
  const tip = (ref: string) => git(root, "rev-parse", ref);
  const has = (ref: string, file: string) => spawnSync("git", ["cat-file", "-e", `${ref}:${file}`], { cwd: root }).status === 0;
  /** The kit cuts the agent branch from main's tip; the ticket's own commit goes on it. */
  const cut = async () => {
    await addWorktree(project, BRANCH);
    const path = join(root, ".sandcastle/worktrees", BRANCH.replace("/", "-"));
    commit(path, "a.txt", "a\n", "the ticket's work");
    const exec = async (cmd: string) => {
      const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    };
    return { path, exec };
  };
  return { root, project, tip, has, cut };
};

test("a branch forked from a commit a reset removed counts only its own work, though it never merged the base", async () => {
  const h = harness();
  commit(h.root, "good.txt", "good\n", "a landing");
  const good = h.tip("main");
  commit(h.root, "bad.txt", "bad\n", "a squash-landed commit");
  const bad = h.tip("main");
  await h.cut();
  git(h.root, "reset", "-q", "--hard", good);

  assert.deepEqual(staleBaseParents("main", BRANCH, h.root), [bad]);
  // The branch is the squash-landed commit plus its own: only its own is its work.
  assert.equal(git(h.root, "rev-list", "--no-merges", "--count", `main..${BRANCH}`), "2");
  assert.equal(ownCommits("main", BRANCH, h.root), 1);
});

test("a branch forked from a commit a reset removed is rebuilt on the new base tip, and the lost commit does not come back", async () => {
  const h = harness();
  commit(h.root, "good.txt", "good\n", "a landing");
  const good = h.tip("main");
  commit(h.root, "bad.txt", "bad\n", "a squash-landed commit");
  const bad = h.tip("main");
  const box = await h.cut();
  git(h.root, "reset", "-q", "--hard", good);

  const rebuilt = await rebuildOnBase(box, { root: h.root, base: "main", branch: BRANCH, identity: hostIdentity(h.root) });
  assert.deepEqual(rebuilt && { kind: rebuilt.kind, ...(rebuilt.kind === "rebuilt" && { picked: rebuilt.picked, dropped: rebuilt.dropped }) }, { kind: "rebuilt", picked: 1, dropped: 0 });
  assert.equal(git(h.root, "rev-list", "--count", `main..${BRANCH}`), "1");
  assert.equal(git(h.root, "rev-list", "--count", `${BRANCH}..main`), "0");
  assert.equal(git(h.root, "log", "--format=%s", `main..${BRANCH}`), "the ticket's work");
  assert.ok(h.has(BRANCH, "a.txt") && h.has(BRANCH, "good.txt"));
  assert.equal(h.has(BRANCH, "bad.txt"), false, "the removed commit came back");
  assert.notEqual(spawnSync("git", ["merge-base", "--is-ancestor", bad, BRANCH], { cwd: h.root }).status, 0);
  assert.equal(git(box.path, "symbolic-ref", "HEAD"), `refs/heads/${BRANCH}`);
  // Forked from the tip it sits on now: the next attempt finds nothing to rebuild.
  assert.deepEqual(staleBaseParents("main", BRANCH, h.root), []);
  assert.equal(await rebuildOnBase(box, { root: h.root, base: "main", branch: BRANCH, identity: hostIdentity(h.root) }), undefined);
});

test("a branch forked from commits a flattening rebase replaced with copies is rebuilt without them", async () => {
  const h = harness();
  const start = h.tip("main");
  commit(h.root, "x.txt", "x\n", "landed x");
  commit(h.root, "y.txt", "y\n", "landed y");
  const picks = git(h.root, "rev-list", "--reverse", "--no-merges", `${start}..main`).split("\n");
  const box = await h.cut();
  // What `git pull --rebase` makes of them: the same changes under new hashes.
  git(h.root, "reset", "-q", "--hard", start);
  for (const sha of picks) execFileSync("git", ["cherry-pick", sha], { cwd: h.root, stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: "2031-01-01T00:00:00Z" } });

  assert.equal(ownCommits("main", BRANCH, h.root), 1);
  const rebuilt = await rebuildOnBase(box, { root: h.root, base: "main", branch: BRANCH, identity: hostIdentity(h.root) });
  assert.equal(rebuilt?.kind, "rebuilt");
  assert.equal(git(h.root, "rev-list", "--count", `main..${BRANCH}`), "1");
  assert.equal(git(h.root, "rev-list", "--count", `${BRANCH}..main`), "0");
  for (const sha of picks) assert.notEqual(spawnSync("git", ["merge-base", "--is-ancestor", sha, BRANCH], { cwd: h.root }).status, 0, `${sha.slice(0, 7)} is back on the branch`);
  assert.deepEqual(git(h.root, "cherry", "main", BRANCH).split("\n"), [`+ ${h.tip(BRANCH)}`]);
});

test("a base that only moved forward is no rewrite of a recorded fork point", async () => {
  const h = harness();
  const box = await h.cut();
  commit(h.root, "other.txt", "other\n", "another ticket landed");
  assert.deepEqual(staleBaseParents("main", BRANCH, h.root), []);
  assert.equal(ownCommits("main", BRANCH, h.root), 1);
  assert.equal(await rebuildOnBase(box, { root: h.root, base: "main", branch: BRANCH, identity: hostIdentity(h.root) }), undefined);
});

test("the fork point outlives the ticket's head record and goes with the branch", async () => {
  const h = harness();
  commit(h.root, "bad.txt", "bad\n", "a squash-landed commit");
  await h.cut();
  recordHead(h.root, "2", { branch: BRANCH, green: h.tip(BRANCH) }, "2026-10-12T00:00:00.000Z");
  assert.ok(forgetHead(h.root, "2"));
  git(h.root, "reset", "-q", "--hard", "HEAD~1");
  assert.equal(ownCommits("main", BRANCH, h.root), 1, "dropping the head record dropped the fork point");

  forgetFork(h.root, BRANCH);
  assert.equal(ownCommits("main", BRANCH, h.root), 2, "a forgotten fork point is read as none");
  assert.ok(existsSync(join(h.root, ".sandcastle/logs/forks.json")));
  assert.ok(!(BRANCH in JSON.parse(readFileSync(join(h.root, ".sandcastle/logs/forks.json"), "utf8"))));
});

test("a branch rebuilt by hand onto the new base is not read as forked from the lost commit", async () => {
  const h = harness();
  commit(h.root, "bad.txt", "bad\n", "a squash-landed commit");
  const bad = h.tip("main");
  const box = await h.cut();
  git(h.root, "reset", "-q", "--hard", "HEAD~1");
  git(box.path, "rebase", "-q", "--onto", "main", bad);
  assert.deepEqual(staleBaseParents("main", BRANCH, h.root), []);
  assert.equal(ownCommits("main", BRANCH, h.root), 1);
});

test("a branch made before the fork point was recorded keeps the merge-commit detector alone", () => {
  const h = harness();
  commit(h.root, "bad.txt", "bad\n", "a squash-landed commit");
  git(h.root, "branch", BRANCH, "main");
  git(h.root, "checkout", "-q", BRANCH);
  commit(h.root, "a.txt", "a\n", "the ticket's work");
  git(h.root, "checkout", "-q", "main");
  git(h.root, "reset", "-q", "--hard", "HEAD~1");
  assert.deepEqual(staleBaseParents("main", BRANCH, h.root), []);
  assert.equal(ownCommits("main", BRANCH, h.root), 2);
});
