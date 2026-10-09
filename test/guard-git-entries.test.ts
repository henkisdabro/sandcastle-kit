// The `.git` fingerprint reads what a sandbox can leave in the shared `.git` without crashing or hanging, and tells a
// person's own worktree from a kit worktree whose record a sandbox rewrote. A directory under `.git/hooks/` is an entry
// whose files are watched (reading it as a file threw); a FIFO there is recorded by its kind and never opened (the
// read blocked, and with it the whole run); a worktree a person made beside the run in a folder named `sandcastle-*`
// does not stop it, while a kit worktree's record pointing at a container path still does. Temp repos only: no
// Docker, no network.
//
//   pnpm test:file test/guard-git-entries.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitUnchanged, gitFingerprint } from "../src/guard.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-git-entries-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const repo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  return { project: { root, baseBranch: "main" } as Project, git };
};

test("a directory under .git/hooks is fingerprinted, not read as a file, and a file added in it is seen", () => {
  const { project } = repo();
  mkdirSync(join(project.root, ".git", "hooks", "pre-commit.d"));
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "in a test"));
  writeFileSync(join(project.root, ".git", "hooks", "pre-commit.d", "10-check"), "#!/bin/sh\n");
  assert.throws(() => assertGitUnchanged(project, before, "in a test"), /STOPPED in a test/);
});

test("a FIFO planted under .git/hooks is recorded by its kind, never opened, and stops the run", () => {
  const { project } = repo();
  const before = gitFingerprint(project);
  execFileSync("mkfifo", [join(project.root, ".git", "hooks", "post-checkout")]);
  // Reading the FIFO would block this synchronous call, and the test, forever.
  assert.throws(() => assertGitUnchanged(project, before, "in a test"), /STOPPED in a test/);
  const after = gitFingerprint(project);
  assert.ok(Object.values(after.files).includes("special fifo"));
});

test("a person's own worktree in a folder named sandcastle-* does not stop the run; a kit record pointing at a container path does", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("worktree", "add", "-q", "-b", "fix/side", join(TMP, `sandcastle-kit-side${n++}`), "main");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "in a test"));
  // A sandbox's `git worktree repair` writes its container path into its record.
  const kit = join(project.root, ".sandcastle", "worktrees", "agent-issue-9");
  git("worktree", "add", "-q", "-b", "agent/issue-9", kit, "main");
  const withKit = gitFingerprint(project);
  writeFileSync(join(project.root, ".git", "worktrees", "agent-issue-9", "gitdir"), "/home/agent/workspace/.git\n");
  assert.throws(() => assertGitUnchanged(project, withKit, "in a test"), /agent-issue-9/);
});
