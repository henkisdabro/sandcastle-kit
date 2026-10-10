// The kit's own `git worktree add` at a sandbox open (`addWorktree`, `src/guard.ts`) runs as Sandcastle's did: without
// holding the run's other pipelines for the checkout, and within a limit, so an add that never ends cannot hold the
// host-git mutex, and every landing behind it, for good. A `git` on PATH that is slow or hangs on `worktree add`
// stands in for a checkout through a slow filter: no Docker, model or network.
//
//   pnpm test:file test/worktree-add-async.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { addWorktree, openOrAbandon } from "../src/guard.ts";

const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-add-async-")));
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

/** A `git` on PATH that runs `onAdd` (shell) for a `worktree add`, and the real git for everything else. */
const withGit = async <T>(onAdd: string, fn: () => Promise<T>): Promise<T> => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-add-git-"));
  const script = join(bin, "git");
  writeFileSync(script, `#!/bin/sh\nfor a in "$@"; do [ "$a" = add ] && { ${onAdd}; break; }; done\nexec "${realGit}" "$@"\n`);
  chmodSync(script, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
};

test("a slow worktree add leaves the run's other work running while it checks out", async () => {
  const { root, project } = repo();
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 50);
  try {
    const seen = await withGit("sleep 1", () => openOrAbandon(project, "agent/issue-3", async () => ticks));
    assert.ok(seen >= 5, `timers ran during the add (${seen} ticks of 50 ms in 1 s)`);
  } finally {
    clearInterval(ticker);
  }
  assert.ok(existsSync(join(root, ".sandcastle/worktrees/agent-issue-3/tracked.txt")));
});

test("a worktree add that does not finish in its limit fails the open instead of holding it", async () => {
  const { project } = repo();
  const started = Date.now();
  await withGit("exec sleep 30", () => assert.rejects(addWorktree(project, "agent/issue-4", 300), /did not finish in/));
  assert.ok(Date.now() - started < 10_000, "it gave up at its limit, not when git did");
});
