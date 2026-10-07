// The shared-.git check reads `.git/config` by key, not as bytes: the upstream another worktree
// gives its own branch (`git worktree add ... origin/main -b x`, `git branch -u`) is no tampering,
// and any other key still stops the run, with the key named in the stop.
//
//   pnpm test:file test/guard-config-keys.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitUnchanged, gitFingerprint } from "../src/guard.ts";
import { quietly } from "./quiet.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

// A project with a remote `origin` that holds `main`, as the first fetch of a real clone leaves it.
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-guard-config-"));
  const root = join(dir, "project");
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  run(root, "commit", "-q", "--allow-empty", "-m", "start");
  run(dir, "clone", "-q", "--bare", root, join(dir, "origin.git"));
  run(root, "remote", "add", "origin", join(dir, "origin.git"));
  run(root, "fetch", "-q", "origin");
  const git = (...args: string[]) => run(root, ...args);
  return { dir, project: { root, baseBranch: "main" } as Project, git };
};

const stops = (project: Project, before: ReturnType<typeof gitFingerprint>) => {
  let said = "";
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), (e: Error) => ((said = e.message), /STOPPED after #1: \.git\/config changed while sandboxes ran/.test(said)));
  return said;
};

test("a branch another worktree gives an upstream does not stop the run, and the line names the keys once", async () => {
  const { dir, project, git } = repo();
  const before = gitFingerprint(project);
  git("worktree", "add", "-q", join(dir, "sweep"), "origin/main", "-b", "content/sweep");
  const { lines } = await quietly(() => assertGitUnchanged(project, before, "after #1"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /branch\.content\/sweep\.merge, branch\.content\/sweep\.remote changed in the shared \.git\/config/);
  assert.match(lines[0], /the run goes on/);
  // Accepted: the next check says nothing, and a later planted key is still judged against it.
  assert.equal((await quietly(() => assertGitUnchanged(project, before, "after #2"))).lines.length, 0);
  git("config", "core.fsmonitor", "touch owned");
  assert.match(stops(project, before), /core\.fsmonitor added/);
});

test("giving a branch an upstream and removing it again pass", async () => {
  const { project, git } = repo();
  git("branch", "topic");
  const before = gitFingerprint(project);
  git("branch", "-q", "-u", "origin/main", "topic");
  await quietly(() => assertGitUnchanged(project, before, "after #1"));
  git("branch", "-q", "--unset-upstream", "topic");
  await quietly(() => assertGitUnchanged(project, before, "after #2"));
  git("branch", "-q", "-D", "topic");
  await quietly(() => assertGitUnchanged(project, before, "after #3"));
});

test("an upstream on an agent/issue-* branch stops the run", () => {
  const { project, git } = repo();
  git("branch", "agent/issue-7");
  const before = gitFingerprint(project);
  git("branch", "-q", "-u", "origin/main", "agent/issue-7");
  assert.match(stops(project, before), /branch\.agent\/issue-7\.remote added: "origin"/);
});

test("an upstream on the base branch stops the run, whatever the base is called", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("branch", "-q", "-u", "origin/main", "main");
  assert.match(stops(project, before), /branch\.main\.merge added: "refs\/heads\/main"/);
  const other = repo();
  other.git("branch", "trunk");
  const beforeOther = gitFingerprint({ ...other.project, baseBranch: "trunk" });
  other.git("branch", "-q", "-u", "origin/main", "trunk");
  assert.match(stops({ ...other.project, baseBranch: "trunk" }, beforeOther), /branch\.trunk\.remote added/);
});

test("a rebase or pushRemote key on a sibling's branch still stops the run", () => {
  for (const key of ["rebase", "pushRemote"]) {
    const { project, git } = repo();
    const before = gitFingerprint(project);
    git("config", `branch.topic.${key}`, "origin");
    assert.match(stops(project, before), new RegExp(`branch\\.topic\\.${key.toLowerCase()} added`));
  }
});

test("a remote that is a URL or a path, not a name, stops the run: ext:: runs a program", () => {
  for (const remote of ["ext::sh -c touch% owned", "/tmp/elsewhere", "https://example.com/x.git"]) {
    const { project, git } = repo();
    const before = gitFingerprint(project);
    git("config", "branch.topic.remote", remote);
    git("config", "branch.topic.merge", "refs/heads/main");
    assert.match(stops(project, before), /branch\.topic\.remote added/);
  }
});

test("a command-running or config-loading key stops the run, named without its value", () => {
  const keys: [string, string][] = [
    ["core.fsmonitor", "touch owned"],
    ["core.hooksPath", "/tmp/hooks"],
    ["filter.x.clean", "touch owned"],
    ["filter.x.smudge", "touch owned"],
    ["merge.x.driver", "touch owned"],
    ["diff.external", "touch owned"],
    ["diff.x.textconv", "touch owned"],
    ["core.pager", "touch owned"],
    ["core.editor", "touch owned"],
    ["core.sshCommand", "touch owned"],
    ["gpg.program", "touch owned"],
    ["sequence.editor", "touch owned"],
    ["include.path", "/tmp/more"],
    ["includeIf.gitdir:/x/.path", "/tmp/more"],
  ];
  for (const [key, value] of keys) {
    const { project, git } = repo();
    const before = gitFingerprint(project);
    git("config", key, value);
    const said = stops(project, before);
    assert.match(said, new RegExp(`In \\.git/config: ${key.replace(/^([^.]+)/, (m) => m.toLowerCase()).replace(/\.([^.]+)$/, (m) => m.toLowerCase()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} added\\.`), key);
    assert.doesNotMatch(said, /touch owned|\/tmp\/(hooks|more)/, key);
  }
});

test("a command-running key mixed with a benign upstream stops the run", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("branch", "-q", "--track", "topic", "origin/main");
  git("config", "core.fsmonitor", "touch owned");
  const said = stops(project, before);
  assert.match(said, /core\.fsmonitor added/);
  assert.match(said, /branch\.topic\.remote added: "origin"/);
});

test("a changed remote URL stops the run, showing old and new with credentials hidden", () => {
  const { project, git } = repo();
  git("config", "remote.origin.url", "https://user:secret@example.com/a.git");
  const before = gitFingerprint(project);
  git("config", "remote.origin.url", "https://user:secret@example.net/b.git");
  const said = stops(project, before);
  assert.match(said, /remote\.origin\.url: "https:\/\/\*\*\*@example\.com\/a\.git" -> "https:\/\/\*\*\*@example\.net\/b\.git"/);
  assert.doesNotMatch(said, /secret/);
});

test("a credential in a key's name or a header's value is never shown", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("config", "http.https://tok3n@example.com/.extraheader", "AUTHORIZATION: bearer s3cr3t");
  git("config", "url.https://x-access-token:tok3n@example.com/.insteadof", "https://example.com/");
  git("config", "credential.helper", "store --file /tmp/s3cr3t");
  const said = stops(project, before);
  assert.doesNotMatch(said, /tok3n|s3cr3t/);
  assert.match(said, /http\.https:\/\/\*\*\*@example\.com\/\.extraheader added/);
  assert.match(said, /url\.https:\/\/\*\*\*@example\.com\/\.insteadof added/);
  assert.match(said, /credential\.helper added/);
});

test("a comment added to .git/config changes nothing git reads, so it passes", async () => {
  const { project } = repo();
  const before = gitFingerprint(project);
  appendFileSync(join(project.root, ".git", "config"), "# a note\n");
  const { lines } = await quietly(() => assertGitUnchanged(project, before, "after #1"));
  assert.deepEqual(lines, []);
});

test("a change to another file of .git still stops the run beside a benign config change", async () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("branch", "-q", "--track", "topic", "origin/main");
  appendFileSync(join(project.root, ".git", "info", "attributes"), "* filter=x\n");
  await quietly(() => assert.throws(() => assertGitUnchanged(project, before, "after #1"), /\.git\/info\/attributes changed/));
});

test("a key that loses its value stops the run: `bare` is true, `bare =` is false", () => {
  const { project } = repo();
  const config = join(project.root, ".git", "config");
  appendFileSync(config, "[x]\n\tflag =\n");
  const before = gitFingerprint(project);
  writeFileSync(config, readFileSync(config, "utf8").replace("\tflag =\n", "\tflag\n"));
  assert.match(stops(project, before), /x\.flag: "" -> \(no value\)/);
});
