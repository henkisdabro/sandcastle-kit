// A sandbox open that fails (the container-start timeout on a loaded machine) throws with no handle to close: the
// container keeps running, the worktree stays locked by the worktree hook and its branch stays. `openOrAbandon`
// removes what the open created, and `sandcastle clean` (`reapOrphans`) stops a running container of any kit
// worktree of the project - the base gates' too - not only `agent-issue-*`. A fake `docker` on PATH and temp repos:
// no Docker, model or network. The fake is a shell script run by `sh`, which macOS's bash 3.2 and BSD tools run alike.
//
//   pnpm test:file test/failed-open-cleanup.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { openOrAbandon, worktreeRefusal } from "../src/guard.ts";
import { cleanProject, reapOrphans } from "../src/sandbox.ts";
import { lockWorktree } from "../src/worktree-lock.ts";
import { quietly } from "./quiet.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-failed-open-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  return { root, git, project: { root, name: "fixture", baseBranch: "main" } as Project };
};

// A docker that answers from state files: `containers` (id per line, the running ones) and `mounts/<id>`. `rm -f` drops
// the id from `containers` and logs it in `removed`, so a test sees what is still running.
const fakeDocker = () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-failed-open-docker-")));
  const bin = join(state, "bin");
  mkdirSync(join(state, "mounts"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(state, "containers"), "");
  writeFileSync(join(state, "removed"), "");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
state="${state}"
case "$1" in
  ps) cat "$state/containers" ;;
  inspect) cat "$state/mounts/$2" ;;
  rm) echo "$3" >> "$state/removed"; grep -vx "$3" "$state/containers" > "$state/containers.new"; mv "$state/containers.new" "$state/containers" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const lines = (file: string) => readFileSync(join(state, file), "utf8").split("\n").filter(Boolean);
  return {
    bin,
    /** A running container `id` that mounts `source`, as Sandcastle starts one. */
    start: (id: string, source: string) => {
      writeFileSync(join(state, "containers"), `${lines("containers").concat(id).join("\n")}\n`);
      writeFileSync(join(state, "mounts", id), `${source}\n/etc/claude-code\n`);
    },
    running: () => lines("containers"),
    removed: () => lines("removed"),
  };
};

const withPath = async <T>(bin: string, fn: () => T | Promise<T>): Promise<T> => {
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
};

/** What Sandcastle's `createSandbox` leaves when the container start runs out of time: worktree (locked), branch, container. */
const failingOpen = (root: string, git: (...a: string[]) => string, docker: ReturnType<typeof fakeDocker>, branch: string, dir: string) => async () => {
  const path = join(root, ".sandcastle/worktrees", dir);
  git("worktree", "add", "-q", "-b", branch, path);
  lockWorktree(path, root);
  docker.start("c-stuck", path);
  throw new Error("container start timed out after 120 s");
};

test("a failed open of a gate sandbox leaves no container, lock, worktree or branch, and the open's own error is thrown", async () => {
  const { root, git, project } = repo();
  const docker = fakeDocker();
  const branch = "sandcastle/base-gates-1";
  await withPath(docker.bin, async () => {
    await assert.rejects(openOrAbandon(project, branch, failingOpen(root, git, docker, branch, "sandcastle-base-gates-1")), /container start timed out/);
  });
  assert.deepEqual(docker.running(), [], "the stuck container is removed");
  assert.deepEqual(docker.removed(), ["c-stuck"]);
  assert.ok(!existsSync(join(root, ".sandcastle/worktrees/sandcastle-base-gates-1")));
  assert.equal(git("worktree", "list", "--porcelain").includes(".sandcastle/worktrees"), false);
  assert.equal(git("branch", "--list", branch), "");
});

test("a failed open of a ticket's sandbox removes the container and worktree and keeps the agent branch", async () => {
  const { root, git, project } = repo();
  const docker = fakeDocker();
  await withPath(docker.bin, async () => {
    await assert.rejects(openOrAbandon(project, "agent/issue-7", failingOpen(root, git, docker, "agent/issue-7", "agent-issue-7")), /timed out/);
  });
  assert.deepEqual(docker.running(), []);
  assert.ok(!existsSync(join(root, ".sandcastle/worktrees/agent-issue-7")));
  assert.match(git("branch", "--list", "agent/issue-7"), /agent\/issue-7/, "a ticket's branch is the run's to keep");
});

test("a failed open leaves a worktree whose records the guard refuses, after removing its container", async () => {
  const { root, git, project } = repo();
  const docker = fakeDocker();
  const branch = "sandcastle/base-gates-2";
  const path = join(root, ".sandcastle/worktrees/sandcastle-base-gates-2");
  await withPath(docker.bin, async () => {
    await assert.rejects(
      openOrAbandon(project, branch, async () => {
        await failingOpen(root, git, docker, branch, "sandcastle-base-gates-2")().catch(() => {});
        writeFileSync(join(root, ".git/worktrees/sandcastle-base-gates-2/config.worktree"), "[filter \"evil\"]\n\tclean = touch owned\n");
        throw new Error("timed out");
      }),
      /timed out/,
    );
  });
  assert.deepEqual(docker.running(), []);
  assert.ok(existsSync(path), "no git ran there: it stays for `sandcastle clean` to report");
  assert.match(git("branch", "--list", branch), /base-gates-2/);
});

test("a failed open of a reused worktree leaves it as it stands, with no host git status run in it", async () => {
  const { root, git, project } = repo();
  const docker = fakeDocker();
  const path = join(root, ".sandcastle/worktrees/agent-issue-8");
  const marker = join(root, ".sandcastle/filter-ran");
  git("worktree", "add", "-q", "-b", "agent/issue-8", path);
  writeFileSync(join(path, "work.txt"), "uncommitted\n");
  await withPath(docker.bin, async () => {
    await assert.rejects(
      openOrAbandon(project, "agent/issue-8", async () => {
        lockWorktree(path, root);
        docker.start("c-reused", path);
        // Another sandbox plants a filter while this one starts: a `git status` in the worktree (as `git worktree
        // remove` without --force runs) would run it on the host on the changed tracked file.
        git("config", "filter.planted.clean", `touch '${marker}'; cat`);
        writeFileSync(join(root, ".git/info/attributes"), "* filter=planted\n");
        writeFileSync(join(path, "tracked.txt"), "changed in the sandbox\n");
        throw new Error("timed out");
      }),
      /timed out/,
    );
  });
  assert.deepEqual(docker.running(), []);
  assert.ok(!existsSync(marker), "no host git status ran in the reused worktree");
  assert.equal(readFileSync(join(path, "work.txt"), "utf8"), "uncommitted\n");
  assert.match(git("worktree", "list", "--porcelain"), /locked/);
  assert.match(git("branch", "--list", "agent/issue-8"), /agent\/issue-8/);
});

test("an open that succeeds is returned as it is, with nothing removed", async () => {
  const { project } = repo();
  const docker = fakeDocker();
  const got = await withPath(docker.bin, () => openOrAbandon(project, "sandcastle/x", async () => "handle"));
  assert.equal(got, "handle");
  assert.deepEqual(docker.removed(), []);
});

test("sandcastle clean's reap stops a running container of the base gates' worktree, and leaves another project's", async () => {
  const { root, git, project } = repo();
  const other = repo();
  const docker = fakeDocker();
  const gates = join(root, ".sandcastle/worktrees/sandcastle-base-gates-3");
  git("worktree", "add", "-q", "-b", "sandcastle/base-gates-3", gates);
  lockWorktree(gates, root);
  docker.start("mine-gates", gates);
  docker.start("mine-ticket", join(root, ".sandcastle/worktrees/agent-issue-4"));
  docker.start("theirs", join(other.root, ".sandcastle/worktrees/sandcastle-base-gates-9"));
  docker.start("unrelated", "/etc/claude-code");
  const { result: cleaned, lines } = await quietly(() =>
    withPath(docker.bin, () => {
      reapOrphans(project);
      return cleanProject(project, false, worktreeRefusal(project));
    }),
  );
  assert.match(lines.join("\n"), /Stopped a sandbox a killed run left working: \.sandcastle\/worktrees\/sandcastle-base-gates-3/);
  assert.deepEqual(docker.removed().sort(), ["mine-gates", "mine-ticket"]);
  assert.deepEqual(docker.running().sort(), ["theirs", "unrelated"]);
  // The locked worktree no live run owns is unlocked and removed, with its scratch branch.
  assert.deepEqual(cleaned.worktrees, [gates]);
  assert.ok(!existsSync(gates));
  assert.equal(git("branch", "--list", "sandcastle/base-gates-3"), "");
});

test("every place the kit opens a sandbox goes through openOrAbandon", () => {
  const source = (file: string) => readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");
  for (const file of ["gates.ts", "land.ts", "burndown.ts"]) {
    const text = source(file);
    assert.equal((text.match(/createSandbox\(/g) ?? []).length, (text.match(/openOrAbandon\(project, branch, \(\) => createSandbox\(/g) ?? []).length, `${file} opens a sandbox outside openOrAbandon`);
    assert.match(text, /openOrAbandon\(project, branch/);
  }
});
