// `sandcastle gates` is one of the commands that records the git-config start baseline (with run, land and
// clean), a red gates or land ends cleanly once its `.git` check passed, and a gates-only check does not speak
// of a run. No Docker, model calls or network.
//
//   pnpm test:file test/gates-baseline.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, assertGitUnchanged, gitFingerprint, recordGitConfigEnd, recordGitConfigStart } from "../src/guard.ts";
import { quietly } from "./quiet.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-gates-baseline-"));
  const root = join(dir, "project");
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  run(root, "commit", "-q", "--allow-empty", "-m", "start");
  run(dir, "clone", "-q", "--bare", root, join(dir, "origin.git"));
  run(root, "remote", "add", "origin", join(dir, "origin.git"));
  run(root, "fetch", "-q", "origin");
  return { dir, project: { root, baseBranch: "main" } as Project, git: (...args: string[]) => run(root, ...args) };
};

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("a gates-only check that sees another worktree's upstream does not speak of a run or of sandboxes", async () => {
  const { dir, project, git } = repo();
  const before = gitFingerprint(project);
  git("worktree", "add", "-q", join(dir, "sweep"), "origin/main", "-b", "content/sweep");
  const { lines } = await quietly(() => assertGitUnchanged(project, before, "after the gates", true));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /branch\.content\/sweep\.merge, branch\.content\/sweep\.remote changed in the shared \.git\/config while the gates ran/);
  assert.doesNotMatch(lines[0], /the run goes on|sandboxes/);
});

test("a run's check still says the run goes on", async () => {
  const { dir, project, git } = repo();
  const before = gitFingerprint(project);
  git("worktree", "add", "-q", join(dir, "sweep"), "origin/main", "-b", "content/sweep");
  const { lines } = await quietly(() => assertGitUnchanged(project, before, "after #1"));
  assert.match(lines[0], /while sandboxes ran: .*the run goes on/);
});

test("gates that ended red after the .git check passed leave a clean end: a later fix of the operator's own is not blamed on a sandbox", () => {
  const { project, git } = repo();
  // `sandcastle gates`: start, the check passes, the gates are red, the end is recorded all the same.
  recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle gates"));
  assertGitUnchanged(project, gitFingerprint(project), "after the gates", true);
  recordGitConfigEnd(project);
  const record = JSON.parse(readFileSync(join(project.root, ".sandcastle", ".run", "git-config-baseline.json"), "utf8"));
  assert.equal(record.clean, true);
  git("config", "core.hooksPath", "/somewhere/hooks");
  let said = "";
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle gates"), (e: Error) => ((said = e.message), said.startsWith("NOT STARTED: ")));
  assert.match(said, /Something wrote them between the runs\./);
  assert.doesNotMatch(said, /did not end cleanly/);
});

test("gates and a red land record the clean end after their .git check, whatever the gates' result", () => {
  const cli = read("src/cli.ts");
  const body = cli.slice(cli.indexOf('case "gates"'), cli.indexOf('case "land"'));
  const finalLeg = body.slice(body.indexOf("} finally {"));
  assert.ok(finalLeg.indexOf('assertGitUnchanged(project, fingerprint, "after the gates"') < finalLeg.indexOf("recordGitConfigEnd(project)"));
  assert.ok(finalLeg.indexOf("recordGitConfigEnd(project)") < finalLeg.indexOf("}\n      console.log"));
  const land = read("src/land.ts");
  const red = land.slice(land.indexOf('case "red"'));
  assert.ok(red.indexOf("recordGitConfigEnd(project)") > 0 && red.indexOf("recordGitConfigEnd(project)") < red.indexOf("throw new OperatorError"));
});

test("the README says run, land, gates and clean record the baseline", () => {
  const readme = read("README.md").replace(/\s+/g, " ");
  assert.match(readme, /So `sandcastle run`, `land`, `gates` and `clean` record what makes git run a program/);
  assert.match(readme, /the first of those four commands to start records and goes on, `sandcastle gates` included/);
});

test("a build of the base image that waited says when the wait ended", () => {
  const sandbox = read("src/sandbox.ts");
  assert.match(sandbox, /if \(waited\) console\.log\("The other sandcastle build of the base image is done\."\)/);
  assert.ok(sandbox.indexOf("waited = true;") > sandbox.indexOf("let waited = false;"));
});
