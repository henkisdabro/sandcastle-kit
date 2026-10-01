// `sandcastle init` writes the repo's base branch when it is not main, and the
// wrong-branch refusal says how to fix it. Throwaway repos, no network.
//
//   pnpm exec tsx --test test/base-branch.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { detectBaseBranch, init } from "../src/init.ts";
import { assertCleanBase } from "../src/run.ts";

// `git init` then symbolic-ref, not `init -b`, so a git older than 2.28 works too.
const repo = (branch: string, commit = false) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-base-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q");
  git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
  if (commit) git("commit", "-q", "--allow-empty", "-m", "start");
  return { root, git };
};

const written = (root: string) => readFileSync(join(root, ".sandcastle/config.ts"), "utf8");
const quiet = (fn: () => void) => {
  const log = console.log;
  console.log = () => {};
  try {
    fn();
  } finally {
    console.log = log;
  }
};

test("a master repo with no remote: detected, and init writes baseBranch", () => {
  const { root } = repo("master");
  assert.equal(detectBaseBranch(root), "master");
  quiet(() => init(root));
  assert.match(written(root), /^  baseBranch: "master",$/m);
  assert.doesNotMatch(written(root), /\/\/ baseBranch/);
});

test("origin/HEAD wins over the current branch", () => {
  const { root, git } = repo("master", true);
  git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.equal(detectBaseBranch(root), "trunk");
});

test("a main repo keeps the commented default", () => {
  const { root } = repo("main");
  quiet(() => init(root));
  assert.match(written(root), /^  \/\/ baseBranch: "main",$/m);
  assert.doesNotMatch(written(root), /^  baseBranch:/m);
});

test("outside a repo nothing is detected", () => {
  assert.equal(detectBaseBranch(mkdtempSync(join(tmpdir(), "sandcastle-norepo-"))), undefined);
});

test("the wrong-branch refusal says to set baseBranch", () => {
  const { root } = repo("master", true);
  assert.throws(
    () => assertCleanBase({ root, baseBranch: "main" } as Project),
    /expected to be on main, found master\. If master is your base branch, set baseBranch: "master" in \.sandcastle\/config\.ts/,
  );
});
