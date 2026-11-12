// A tracked relative `core.hooksPath` rewritten to its own absolute form (Claude Code's worktree setup writes that
// into the shared `.git/config`): the guard's stop and the start's refusal show both values and the way back, and
// doctor's lines name the relative value. Any other change keeps its value hidden. No Docker, model calls or network.
//
//   pnpm test:file test/hooks-path-rewrite.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, assertGitUnchanged, gitFingerprint, recordGitConfigEnd, recordGitConfigStart } from "../src/guard.ts";
import { hooksPathLines, ownAbsoluteHooksPath } from "../src/lean.ts";
import { quietly } from "./quiet.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

/** A repo with a tracked `.githooks/` set as its relative hooks path. */
const repo = () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-hooks-rewrite-"))), "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  mkdirSync(join(root, ".githooks"));
  writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\n");
  git("add", "--", ".githooks/pre-commit");
  git("config", "core.hooksPath", ".githooks");
  return { project: { root, baseBranch: "main" } as Project, git, root };
};

const stopLine = (project: Project, before: ReturnType<typeof gitFingerprint>) => {
  let said = "";
  assert.throws(() => assertGitUnchanged(project, before, "before landing"), (e: Error) => ((said = e.message), true));
  return said;
};

test("mid-run: the absolute form of the tracked hooks path is named, with the way back", () => {
  const { project, git, root } = repo();
  const before = gitFingerprint(project);
  git("config", "core.hooksPath", join(root, ".githooks"));
  const said = stopLine(project, before);
  assert.ok(said.includes(`".githooks" -> "${join(root, ".githooks")}"`), said);
  assert.match(said, /known Claude Code rewrite/);
  assert.match(said, /git config core\.hooksPath \.githooks/);
});

test("mid-run: any other absolute value stays hidden, with no rewrite note", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("config", "core.hooksPath", "/tmp/elsewhere-hooks");
  const said = stopLine(project, before);
  assert.ok(!said.includes("/tmp/elsewhere-hooks"), said);
  assert.doesNotMatch(said, /Claude Code/);
});

test("at start after a clean end: the rewrite is refused, naming both values and the fix", async () => {
  const { project, git, root } = repo();
  await quietly(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run")));
  recordGitConfigEnd(project);
  git("config", "core.hooksPath", join(root, ".githooks"));
  let said = "";
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), (e: Error) => ((said = e.message), said.startsWith("NOT STARTED: ")));
  assert.match(said, /known Claude Code rewrite/);
  assert.match(said, /git config core\.hooksPath \.githooks/);
});

test("doctor's lines name the relative value for the project's own absolute path, and keep the general fix otherwise", () => {
  const { root } = repo();
  assert.equal(ownAbsoluteHooksPath(root, join(root, ".githooks")), ".githooks");
  assert.equal(ownAbsoluteHooksPath(root, "/tmp/elsewhere-hooks"), undefined);
  assert.equal(ownAbsoluteHooksPath(root, join(root, ".git", "hooks")), undefined);
  assert.match(hooksPathLines(join(root, ".githooks"), root).join("\n"), /`git config core\.hooksPath \.githooks`/);
  assert.match(hooksPathLines("/tmp/elsewhere-hooks", root).join("\n"), /<relative path>/);
});
