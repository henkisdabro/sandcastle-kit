// Three host git calls a sandbox's writes to the shared `.git` or its own worktree could turn: the worktree record
// check reads `commondir` as git does (only the line end stripped), so `../.. ` with a trailing space, which git
// reads as a directory `.. ` the sandbox made, is refused; the landing's fast-forward in the operator's checkout
// refuses to replace an untracked file a sandbox listed in `.git/info/exclude`, which the fingerprint no longer
// watches; and the kept-worktree clean check never looks into a repository nested in the worktree. Temp repos only:
// no Docker, no network.
//
//   pnpm test:file test/host-git-sandbox-writes.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { assertWorktreeRecords } = await import("../src/guard.ts");
type Project = Parameters<typeof assertWorktreeRecords>[0];

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-host-writes-")));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const makeRepo = (name: string) => {
  const root = join(TMP, name);
  git(TMP, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "start");
  return root;
};

test("a commondir git reads as another directory (a trailing space) is refused; git's own line end is not", () => {
  const root = makeRepo("records");
  const path = join(root, ".sandcastle", "worktrees", "agent-issue-1");
  git(root, "worktree", "add", "-q", "-b", "agent/issue-1", path, "main");
  const project = { root } as Project;
  const commondir = join(root, ".git", "worktrees", "agent-issue-1", "commondir");
  assert.equal(readFileSync(commondir, "utf8"), "../..\n");
  assert.doesNotThrow(() => assertWorktreeRecords(project, path, "in a test"));
  writeFileSync(commondir, "../..\r\n");
  assert.doesNotThrow(() => assertWorktreeRecords(project, path, "in a test"));
  // What a sandbox can write: git takes `.. ` as the common directory, a directory of the sandbox's making.
  writeFileSync(commondir, "../.. \n");
  mkdirSync(join(root, ".git", "worktrees", ".. "));
  assert.throws(() => assertWorktreeRecords(project, path, "in a test"), /commondir no longer names the shared \.git/);
});

test("the landing's fast-forward refuses to replace an untracked file listed in .git/info/exclude", () => {
  const root = makeRepo("landing");
  git(root, "checkout", "-q", "-b", "agent/issue-2");
  writeFileSync(join(root, "TODO.md"), "the branch's\n");
  git(root, "add", "TODO.md");
  git(root, "commit", "-q", "-m", "add TODO.md");
  const landed = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "TODO.md"), "the operator's own\n");
  appendFileSync(join(root, ".git", "info", "exclude"), "TODO.md\n");
  // Without the flag git would replace the file: an excluded file reads as ignored, and ignored files are overwritten.
  const ff = spawnSync("git", ["merge", "--ff-only", "--no-overwrite-ignore", landed], { cwd: root, encoding: "utf8" });
  assert.notEqual(ff.status, 0);
  assert.equal(readFileSync(join(root, "TODO.md"), "utf8"), "the operator's own\n");
  // The flag is in every host fast-forward of the kit, the landing's included.
  const land = readFileSync(new URL("../src/land.ts", import.meta.url), "utf8");
  assert.match(land, /"merge", "--ff-only", "--no-overwrite-ignore", landed/);
});

test("the kept-worktree clean check never recurses into a nested repository", () => {
  // `worktreeIsClean` is not exported; its git call is held here, with the reason: a `.gitmodules` the sandbox wrote
  // can set `ignore = none`, so only the command-line flag keeps the host's status out of the nested repository.
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const fn = burndown.slice(burndown.indexOf("const worktreeIsClean"), burndown.indexOf("const worktreeIsClean") + 400);
  assert.match(fn, /"--ignore-submodules=all"/);
  assert.doesNotMatch(fn, /--ignore-submodules=none/);
});
