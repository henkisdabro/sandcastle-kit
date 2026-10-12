// The limit on the kit's `git worktree add` (30 s in production) can be replaced by a test that opens sandboxes on a
// loaded machine (`injectWorktreeLimit`, `src/guard.ts`), and restored. A `git` on PATH that is slow on `worktree add`
// stands in for a checkout under load: no Docker, model or network.
//
//   pnpm test:file test/worktree-limit-inject.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, test } from "node:test";
import type { Project } from "../src/config.ts";
import { addWorktree, injectWorktreeLimit } from "../src/guard.ts";

const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-limit-inject-")));
  const git = (...args: string[]) =>
    execFileSync(realGit, ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  return { root, project: { root, name: "fixture", baseBranch: "main" } as Project };
};

/** A `git` on PATH that sleeps `seconds` for a `worktree add`, and the real git for everything else. */
const withSlowAdd = async <T>(seconds: number, fn: () => Promise<T>): Promise<T> => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-limit-git-"));
  const script = join(bin, "git");
  writeFileSync(script, `#!/bin/sh\nfor a in "$@"; do [ "$a" = add ] && { exec sleep ${seconds}; }; done\nexec "${realGit}" "$@"\n`);
  chmodSync(script, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
};

afterEach(() => injectWorktreeLimit());

test("an injected limit is the one a worktree add with no limit of its own runs under, until it is restored", async () => {
  const { project } = repo();
  injectWorktreeLimit(1000);
  await withSlowAdd(30, () => assert.rejects(addWorktree(project, "agent/issue-5"), /did not finish in 1 s/));
  injectWorktreeLimit();
  // Restored, the 30 s limit lets an add that takes longer than the injected one finish (a sleeping git makes no worktree: the add succeeds with none).
  await withSlowAdd(2, () => addWorktree(project, "agent/issue-6"));
  assert.ok(!existsSync(join(project.root, ".sandcastle/worktrees/agent-issue-6/tracked.txt")));
});

test("a limit passed to the add wins over the injected one", async () => {
  const { project } = repo();
  injectWorktreeLimit(60_000);
  await withSlowAdd(30, () => assert.rejects(addWorktree(project, "agent/issue-7", 1000), /did not finish in 1 s/));
});
