// A tracked relative `core.hooksPath` rewritten to its own absolute form (Claude Code's worktree setup writes that
// into the shared `.git/config`): the guard takes the exact rewrite with one line, the start takes it after a clean end,
// the end is recorded clean, and the hooks directory stays protected. Any other change stops, with its value hidden. An
// unclean end still refuses it, naming both values and the fix. No Docker, model calls or network.
//
//   pnpm test:file test/hooks-path-rewrite.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, assertGitUnchanged, gitFingerprint, protectedAmong, recordGitConfigEnd, recordGitConfigStart } from "../src/guard.ts";
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

test("mid-run: the exact absolute form of the tracked hooks path is taken with one line naming both values", async () => {
  const { project, git, root } = repo();
  const before = gitFingerprint(project);
  git("config", "core.hooksPath", join(root, ".githooks"));
  const { lines } = await quietly(() => assertGitUnchanged(project, before, "before landing"));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.ok(lines[0].includes(`".githooks" -> "${join(root, ".githooks")}"`), lines[0]);
  assert.match(lines[0], /known Claude Code rewrite/);
  assert.match(lines[0], /git config core\.hooksPath \.githooks/);
  const again = await quietly(() => assertGitUnchanged(project, before, "before landing"));
  assert.deepEqual(again.lines, [], "the new state is the expectation: a second check says nothing");
});

test("mid-run: the change back stops a live run, so the line says to restore once the run has ended", async () => {
  const { project, git, root } = repo();
  const before = gitFingerprint(project);
  git("config", "core.hooksPath", join(root, ".githooks"));
  const { lines } = await quietly(() => assertGitUnchanged(project, before, "before landing"));
  assert.match(lines[0], /git config core\.hooksPath \.githooks` once the run has ended/);
  git("config", "core.hooksPath", ".githooks");
  assert.match(stopLine(project, before), /core\.hookspath changed/);
});

test("mid-run: the rewrite with a second key changed beside it still stops, naming both keys", () => {
  const { project, git, root } = repo();
  const before = gitFingerprint(project);
  git("config", "core.hooksPath", join(root, ".githooks"));
  git("config", "alias.st", "!echo planted");
  const said = stopLine(project, before);
  assert.match(said, /core\.hookspath/i);
  assert.match(said, /alias\.st added/);
  assert.ok(!said.includes("planted"), said);
});

test("mid-run: any other absolute value stays hidden, with no rewrite note, and stops", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("config", "core.hooksPath", "/tmp/elsewhere-hooks");
  const said = stopLine(project, before);
  assert.ok(!said.includes("/tmp/elsewhere-hooks"), said);
  assert.doesNotMatch(said, /Claude Code/);
});

test("mid-run: an absolute path to another directory of the project than the recorded value still stops", () => {
  const { project, git, root } = repo();
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "other", "pre-commit"), "#!/bin/sh\n");
  git("add", "--", "other/pre-commit");
  const before = gitFingerprint(project);
  git("config", "core.hooksPath", join(root, "other"));
  const said = stopLine(project, before);
  assert.ok(!said.includes(join(root, "other")), said);
});

test("at start after a clean end: the exact rewrite of the recorded value is taken, with a line", async () => {
  const { project, git, root } = repo();
  await quietly(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run")));
  recordGitConfigEnd(project);
  git("config", "core.hooksPath", join(root, ".githooks"));
  const start = assertGitConfigBaseline(project, "sandcastle run");
  assert.equal(start.took.length, 1);
  assert.match(start.took[0], /\.githooks/);
  assert.match(start.took[0], /Claude Code/);
});

test("at start after an unclean end: the rewrite is refused, naming both values and the fix", async () => {
  const { project, git, root } = repo();
  await quietly(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run")));
  git("config", "core.hooksPath", join(root, ".githooks"));
  let said = "";
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), (e: Error) => ((said = e.message), said.startsWith("NOT STARTED: ")));
  assert.match(said, /known Claude Code rewrite/);
  assert.match(said, /git config core\.hooksPath \.githooks/);
});

test("after the guard accepted the rewrite, the end is recorded clean and the next start goes on", async () => {
  const { project, git, root } = repo();
  await quietly(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run")));
  const before = gitFingerprint(project);
  git("config", "core.hooksPath", join(root, ".githooks"));
  await quietly(() => assertGitUnchanged(project, before, "while sandboxes ran"));
  recordGitConfigEnd(project);
  assert.doesNotThrow(() => assertGitConfigBaseline(project, "sandcastle run"));
  const start = assertGitConfigBaseline(project, "sandcastle run");
  assert.deepEqual(start.took, [], "the record already holds the accepted state, so nothing is left to take");
});

test("a rewrite the guard did not check is not recorded clean at the end", async () => {
  const { project, git, root } = repo();
  await quietly(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run")));
  git("config", "core.hooksPath", join(root, ".githooks"));
  recordGitConfigEnd(project);
  // The record stays unclean, so the next start compares as for an unclean end.
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), (e: Error) => e.message.startsWith("NOT STARTED: "));
});

test("a tracked hooks directory outside the defaults stays protected after the rewrite", () => {
  const { project, git, root } = repo();
  mkdirSync(join(root, "tools", "hooks"), { recursive: true });
  writeFileSync(join(root, "tools", "hooks", "pre-commit"), "#!/bin/sh\n");
  git("add", "--", "tools/hooks/pre-commit");
  git("config", "core.hooksPath", "tools/hooks");
  assert.deepEqual(protectedAmong(project, ["tools/hooks/pre-commit", "src/a.ts"]), ["tools/hooks/pre-commit"]);
  git("config", "core.hooksPath", join(root, "tools", "hooks"));
  assert.deepEqual(protectedAmong(project, ["tools/hooks/pre-commit", "src/a.ts"]), ["tools/hooks/pre-commit"]);
});

test("doctor's lines name the relative value for the project's own absolute path, and keep the general fix otherwise", () => {
  const { root } = repo();
  assert.equal(ownAbsoluteHooksPath(root, join(root, ".githooks")), ".githooks");
  assert.equal(ownAbsoluteHooksPath(root, "/tmp/elsewhere-hooks"), undefined);
  assert.equal(ownAbsoluteHooksPath(root, join(root, ".git", "hooks")), undefined);
  assert.match(hooksPathLines(join(root, ".githooks"), root).join("\n"), /`git config core\.hooksPath \.githooks`/);
  assert.match(hooksPathLines("/tmp/elsewhere-hooks", root).join("\n"), /<relative path>/);
});
