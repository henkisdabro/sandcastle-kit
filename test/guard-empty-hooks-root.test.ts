// Sandcastle (from 0.13) creates `<common>/hooks` and `<common>/info` on the host each time a sandbox
// starts, to mount them read-only. In a repository with no hooks directory, the fingerprint and the
// start record would read that new empty directory as a change and stop the run at its first sandbox.
// An empty hooks root counts as absent; a hook in it, or a directory under it, is still a change.
// No Docker, model calls or network.
//
//   pnpm test:file test/guard-empty-hooks-root.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, assertGitUnchanged, gitFingerprint, recordGitConfigEnd, recordGitConfigStart } from "../src/guard.ts";
import { quietly } from "./quiet.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

/** A repository with no `.git/hooks` and no `.git/info`, as a person who removed them has. */
const repo = () => {
  const root = join(mkdtempSync(join(tmpdir(), "sandcastle-guard-hooks-root-")), "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  rmSync(join(root, ".git", "hooks"), { recursive: true, force: true });
  rmSync(join(root, ".git", "info"), { recursive: true, force: true });
  return { root, baseBranch: "main" } as Project;
};

/** What Sandcastle's bind-mount start does on the host. */
const sandcastleMountStart = (root: string) => {
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  mkdirSync(join(root, ".git", "info"), { recursive: true });
};

test("the empty hooks and info directories Sandcastle creates at a sandbox start pass the fingerprint check", () => {
  const project = repo();
  const before = gitFingerprint(project);
  sandcastleMountStart(project.root);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
});

test("a hook planted in the hooks directory Sandcastle created still stops the run", () => {
  const project = repo();
  const before = gitFingerprint(project);
  sandcastleMountStart(project.root);
  writeFileSync(join(project.root, ".git", "hooks", "post-checkout"), "#!/bin/sh\ntouch owned\n", { mode: 0o755 });
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /hooks\/post-checkout/);
});

test("an empty directory under the hooks root is still a change", () => {
  const project = repo();
  const before = gitFingerprint(project);
  mkdirSync(join(project.root, ".git", "hooks", "pre-commit.d"), { recursive: true });
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /pre-commit\.d/);
});

test("the next start after a run that left an empty hooks directory is not refused", async () => {
  const project = repo();
  await quietly(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run")));
  // A run killed before its clean end: the start record is the only one, and must not name the empty directory.
  sandcastleMountStart(project.root);
  await quietly(() => assert.doesNotThrow(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run"))));
  await quietly(() => recordGitConfigEnd(project));
});

test("a run that starts with an empty hooks directory and ends with none is not refused either", async () => {
  const project = repo();
  sandcastleMountStart(project.root);
  await quietly(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run")));
  rmSync(join(project.root, ".git", "hooks"), { recursive: true, force: true });
  await quietly(() => assert.doesNotThrow(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run"))));
});
