// Object substitution in the shared `.git`: a replace ref (loose or packed), a `shallow` file and an
// `objects/info/alternates` file each change which objects the host's git reads, so a sandbox that writes
// one mid-run stops the run, naming it. Replace refs already there at the start are the operator's own: a
// warning, not a refusal. And `pinHostGitConfig` reads only git's exit 1 as "no key set" - a config it
// cannot read stops it. No Docker, model calls or network.
//
//   pnpm test:file test/guard-replace-refs.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitUnchanged, gitFingerprint, pinHostGitConfig, replaceRefsWarning } from "../src/guard.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER|CONFIG)/.test(k)));

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-guard-replace-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  const start = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "other");
  const other = git("rev-parse", "HEAD");
  return { root, git, start, other, project: { root, baseBranch: "main" } as Project };
};

test("a loose replace ref made mid-run stops the run, naming it", () => {
  const { git, start, other, project } = repo();
  const before = gitFingerprint(project);
  git("replace", start, other);
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), new RegExp(`\\.git/refs/replace/${start} changed .* refs/replace/`));
});

test("a packed replace ref made mid-run stops the run, naming it", () => {
  const { git, start, other, project } = repo();
  const before = gitFingerprint(project);
  git("replace", start, other);
  git("pack-refs", "--all");
  assert.equal(git("for-each-ref", "--format=%(refname)", "refs/replace/"), `refs/replace/${start}`);
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), new RegExp(`\\.git/refs/replace/${start} changed`));
});

test("a replace ref repointed mid-run stops the run, even once packed", () => {
  const { root, git, start, other, project } = repo();
  git("replace", start, other);
  git("pack-refs", "--all");
  const before = gitFingerprint(project);
  writeFileSync(join(root, ".git", "refs", "replace", start), `${start}\n`);
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), new RegExp(`\\.git/refs/replace/${start} changed`));
});

test("a new shallow file stops the run, naming it", () => {
  const { root, start, project } = repo();
  const before = gitFingerprint(project);
  writeFileSync(join(root, ".git", "shallow"), `${start}\n`);
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /\.git\/shallow changed .* tampered/);
});

test("a new objects/info/alternates stops the run, naming it", () => {
  const { root, project } = repo();
  const before = gitFingerprint(project);
  mkdirSync(join(root, ".git", "objects", "info"), { recursive: true });
  writeFileSync(join(root, ".git", "objects", "info", "alternates"), "/elsewhere/objects\n");
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /\.git\/objects\/info\/alternates changed .* tampered/);
});

test("replace refs present at the start are warned about and do not refuse", () => {
  const { git, start, other, project } = repo();
  git("replace", start, other);
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
  const warning = replaceRefsWarning(before);
  assert.match(warning ?? "", /1 replace ref/);
  assert.match(warning ?? "", /git log/);
});

test("no replace ref, no warning", () => {
  const { project } = repo();
  assert.equal(replaceRefsWarning(gitFingerprint(project)), undefined);
});

test("pinHostGitConfig throws on a config git cannot read, and passes one with none of the keys", () => {
  const { root } = repo();
  const saved = { ...process.env };
  try {
    assert.doesNotThrow(() => pinHostGitConfig(root));
    writeFileSync(join(root, ".git", "config"), "[core\n\tbroken = \n");
    assert.throws(() => pinHostGitConfig(root), /NOT STARTED: git cannot read the config/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
