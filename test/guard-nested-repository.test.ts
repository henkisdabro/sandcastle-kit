// A repository nested in a sandbox's worktree (src/guard.ts: `assertWorktreeRecords`, `checkBeforeClose`) and the
// shared `.git/modules/` (`gitFingerprint`). A host `git status` in the worktree - Sandcastle's close, its reuse of a
// kept worktree, the cut of a stale branch - looks into a gitlink and reads that repository's own config and
// attributes, so a filter there runs on the host, past the pins. The kit refuses any `.git` entry below the worktree's
// root and a change to `.git/modules/`, naming the path, before that git runs. Temp repos and a stub `docker`.
//
//   pnpm test:file test/guard-nested-repository.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitUnchanged, assertWorktreeRecords, checkBeforeClose, gitFingerprint } from "../src/guard.ts";
import { dockerStub } from "./docker-stub.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

/** A repo with ticket 1's worktree under `.sandcastle/worktrees/`, as Sandcastle makes it. */
const sandbox = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-nested-")));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-q", "-m", "start");
  const wt = join(root, ".sandcastle", "worktrees", "agent-issue-1");
  git(root, "worktree", "add", "-q", "-b", "agent/issue-1", wt);
  return { project: { root, baseBranch: "main" } as Project, root, wt, git };
};

/** What a sandbox can do: a repository in its worktree whose config has a clean filter, a gitlink to it, and a stale stat. */
const nestWithFilter = (wt: string, git: ReturnType<typeof sandbox>["git"], marker: string, where = "sub") => {
  const sub = join(wt, where);
  mkdirSync(sub, { recursive: true });
  git(sub, "init", "-q", "-b", "main");
  writeFileSync(join(sub, "a.txt"), "a\n");
  git(sub, "add", "a.txt");
  git(sub, "commit", "-q", "-m", "nested");
  git(sub, "config", "filter.evil.clean", `touch ${marker}`);
  writeFileSync(join(sub, ".git", "info", "attributes"), "* filter=evil\n");
  git(wt, "add", "-f", where);
  utimesSync(join(sub, "a.txt"), new Date(2001, 0, 1), new Date(2001, 0, 1));
};

const withDocker = async <T>(fn: () => Promise<T>) => {
  const docker = dockerStub();
  const path = process.env.PATH;
  process.env.PATH = docker.first(path);
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
};

test("a repository with a filter nested in a sandbox's worktree stops its close: the host's git status never runs there", async () => {
  const { project, wt, git } = sandbox();
  const before = gitFingerprint(project);
  const marker = join(mkdtempSync(join(tmpdir(), "sandcastle-nested-filter-")), "ran");
  nestWithFilter(wt, git, marker);
  // The scenario is live: the status Sandcastle's close runs reads the nested repository's config.
  spawnSync("git", ["status", "--porcelain", "--ignore-submodules=none"], { cwd: wt, env });
  assert.ok(existsSync(marker), "the nested repository's filter does not run on a host git status, so this test shows nothing");
  rmSync(marker);
  let closed = false;
  const close = () => {
    closed = true;
    execFileSync("git", ["status", "--porcelain"], { cwd: wt, env });
  };
  await withDocker(() =>
    assert.rejects(
      checkBeforeClose(project, wt, "after #1", () => assertGitUnchanged(project, before, "after #1")).then(close),
      /^Error: STOPPED after #1: sub\/\.git in the worktree of agent-issue-1 marks a git repository nested in it\. .*submodules are not supported in sandboxes\. Inspect it and remove it/s,
    ),
  );
  assert.equal(closed, false);
  assert.equal(existsSync(marker), false, "the nested repository's filter ran on the host");
});

test("a nested repository is named wherever it sits, as a directory or as a .git file", () => {
  const { project, wt } = sandbox();
  mkdirSync(join(wt, "packages", "deep", "inner"), { recursive: true });
  writeFileSync(join(wt, "packages", "deep", "inner", ".git"), "gitdir: ../../../.git/modules/inner\n");
  mkdirSync(join(wt, "vendor", "lib", ".git"), { recursive: true });
  assert.throws(
    () => assertWorktreeRecords(project, wt, "before reusing .sandcastle/worktrees/agent-issue-1"),
    (e: Error) => {
      assert.match(e.message, /^STOPPED before reusing \.sandcastle\/worktrees\/agent-issue-1: packages\/deep\/inner\/\.git, vendor\/lib\/\.git in the worktree of agent-issue-1 mark git repositories nested in it\./);
      return true;
    },
  );
});

test("a worktree with no nested repository passes, whatever else it holds", () => {
  const { project, wt } = sandbox();
  mkdirSync(join(wt, "node_modules", "pkg", "git"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "pkg", ".gitignore"), "x\n");
  writeFileSync(join(wt, "node_modules", "pkg", "git", "index.js"), "\n");
  assert.doesNotThrow(() => assertWorktreeRecords(project, wt, "before reusing"));
});

test("a submodule's git directory created under the shared .git/modules/ is tampering, named", () => {
  const { project, root } = sandbox();
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
  mkdirSync(join(root, ".git", "modules", "sub", "objects"), { recursive: true });
  writeFileSync(join(root, ".git", "modules", "sub", "config"), `[filter "evil"]\n\tclean = touch /tmp/owned\n`);
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /^Error: STOPPED after #1: \.git\/modules, \.git\/modules\/sub, \.git\/modules\/sub\/config changed while sandboxes ran\./);
});

test("a changed config in a submodule directory present at the run's start is tampering, while its objects and refs are data", () => {
  const { project, root } = sandbox();
  const module = join(root, ".git", "modules", "sub");
  mkdirSync(join(module, "objects"), { recursive: true });
  mkdirSync(join(module, "refs"), { recursive: true });
  writeFileSync(join(module, "config"), "[core]\n\tbare = false\n");
  const before = gitFingerprint(project);
  writeFileSync(join(module, "objects", "pack.idx"), "data");
  writeFileSync(join(module, "refs", "main"), "0000\n");
  writeFileSync(join(module, "index"), "index");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
  writeFileSync(join(module, "config"), `[filter "evil"]\n\tclean = touch /tmp/owned\n`);
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /^Error: STOPPED after #1: \.git\/modules\/sub\/config changed while sandboxes ran\./);
});

test("a nested module named like a git directory's data is still watched", () => {
  const { project, root } = sandbox();
  mkdirSync(join(root, ".git", "modules", "a", "modules"), { recursive: true });
  const before = gitFingerprint(project);
  mkdirSync(join(root, ".git", "modules", "a", "modules", "objects"), { recursive: true });
  writeFileSync(join(root, ".git", "modules", "a", "modules", "objects", "config"), "[core]\n");
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /\.git\/modules\/a\/modules\/objects\/config changed/);
});
