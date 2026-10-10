// A sandbox open adds its worktree, and a failed one removes it, under the run's host-git mutex (`HostGit.exclusive`),
// so neither meets a landing's ref write; the container start in between stays outside it. Temp git repos and a
// stand-in for Sandcastle's `createSandbox`: no Docker, model or network.
//
//   pnpm test:file test/sandbox-open-serialised.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { openOrAbandon, type Exclusive } from "../src/guard.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-open-mutex-")));
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

/** The run's mutex as `createHostGit` makes it: one call at a time, in the order asked. */
const mutex = (): { exclusive: Exclusive; hold: () => { release: () => void; held: Promise<unknown> } } => {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive: Exclusive = (fn) => {
    const done = tail.then(fn);
    tail = done.catch(() => {});
    return done;
  };
  return {
    exclusive,
    hold: () => {
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      return { release, held: exclusive(() => gate) };
    },
  };
};

const tick = () => new Promise((r) => setTimeout(r, 150));

test("a sandbox open waits for a host git write in progress before its worktree is added", async () => {
  const { root, project } = repo();
  const { exclusive, hold } = mutex();
  const landing = hold();
  let opened = false;
  const open = openOrAbandon(project, "agent/issue-5", async () => ((opened = true), "handle"), exclusive);
  await tick();
  assert.ok(!existsSync(join(root, ".sandcastle/worktrees/agent-issue-5")), "no worktree is added while a write holds the mutex");
  assert.equal(opened, false);
  landing.release();
  assert.equal(await open, "handle");
  assert.ok(existsSync(join(root, ".sandcastle/worktrees/agent-issue-5/tracked.txt")), "the worktree is there when Sandcastle's open starts");
});

test("the worktree is on the ticket's branch, made from the base when the branch is new", async () => {
  const { root, git, project } = repo();
  git("branch", "agent/issue-6");
  git("branch", "side");
  const { exclusive } = mutex();
  await openOrAbandon(project, "agent/issue-6", async () => "x", exclusive);
  await openOrAbandon(project, "sandcastle/base-gates-9", async () => "x", exclusive);
  const head = (name: string) => readFileSync(join(root, ".git/worktrees", name, "HEAD"), "utf8").trim();
  assert.equal(head("agent-issue-6"), "ref: refs/heads/agent/issue-6");
  assert.equal(head("sandcastle-base-gates-9"), "ref: refs/heads/sandcastle/base-gates-9");
  assert.equal(git("rev-parse", "sandcastle/base-gates-9"), git("rev-parse", "main"));
});

test("a worktree that already exists for the branch is reused, not added again", async () => {
  const { root, git, project } = repo();
  const path = join(root, ".sandcastle/worktrees/agent-issue-8");
  git("worktree", "add", "-q", "-b", "agent/issue-8", path);
  writeFileSync(join(path, "work.txt"), "in progress\n");
  assert.equal(await openOrAbandon(project, "agent/issue-8", async () => "reused", mutex().exclusive), "reused");
  assert.equal(readFileSync(join(path, "work.txt"), "utf8"), "in progress\n");
});

test("a failed open's clean-up waits for a host git write in progress, then removes the worktree and its scratch branch", async () => {
  const { root, git, project } = repo();
  const { exclusive, hold } = mutex();
  const path = join(root, ".sandcastle/worktrees/sandcastle-base-gates-3");
  let landing: ReturnType<typeof hold> | undefined;
  const open = openOrAbandon(
    project,
    "sandcastle/base-gates-3",
    async () => {
      // A landing takes the mutex while the container starts, and the start then fails.
      landing = hold();
      throw new Error("container start timed out after 120 s");
    },
    exclusive,
  );
  const outcome = assert.rejects(open, /timed out/);
  await tick();
  assert.ok(existsSync(path), "the clean-up has not run while the landing's write holds the mutex");
  landing!.release();
  await outcome;
  assert.ok(!existsSync(path));
  assert.equal(git("branch", "--list", "sandcastle/base-gates-3"), "");
});

test("a sandbox that is slow to start does not hold the mutex", async () => {
  const { project } = repo();
  const { exclusive } = mutex();
  let finishStart = () => {};
  const open = openOrAbandon(project, "agent/issue-4", () => new Promise<string>((r) => (finishStart = () => r("started"))), exclusive);
  await tick();
  let wrote = false;
  await exclusive(() => {
    wrote = true;
  });
  assert.ok(wrote, "a landing's write runs during the start");
  finishStart();
  await open;
});

test("an add that git refuses throws git's own words and leaves what was in the way", async () => {
  const { root, project } = repo();
  // A directory of someone's at the worktree's path: git refuses to add there.
  const path = join(root, ".sandcastle/worktrees/agent-issue-2");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "mine.txt"), "mine\n");
  await assert.rejects(openOrAbandon(project, "agent/issue-2", async () => "never", mutex().exclusive), /already exists/);
  assert.ok(existsSync(join(path, "mine.txt")));
});

test("every sandbox open of the kit passes the host-git mutex it has, and the base gates at a run's start none", () => {
  const source = (file: string) => readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");
  assert.match(source("burndown.ts"), /openOrAbandon\(project, branch, \(\) => createSandbox\([^\n]*\), host\.exclusive\)/);
  assert.match(source("burndown.ts"), /sandboxOpener\(gateProject, image, planFile, host\.exclusive\)/);
  assert.match(source("burndown.ts"), /baseGate: \(\) => gateBase\([^\n]*host\.exclusive\)/);
  assert.match(source("burndown.ts"), /verifyBase\([^\n]*host\.exclusive\)/);
  assert.match(source("gates.ts"), /openOrAbandon\(project, branch, \(\) => createSandbox\([^\n]*\), exclusive\)/);
  assert.match(source("land.ts"), /openOrAbandon\(project, branch, \(\) => createSandbox\([^\n]*\), exclusive\)/);
});
