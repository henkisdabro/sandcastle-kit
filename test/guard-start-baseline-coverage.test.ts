// What the start baseline covers: every key of the shared `.git/config` and the main worktree's
// `.git/config.worktree` that makes git run a program or reach the network, and every file under
// `.git/hooks/` and `.git/modules/`. A value a sandbox of a killed run planted in any of them is refused at
// the next start, not pinned as that run's own or taken as its fingerprint's baseline. No Docker, model
// calls or network.
//
//   pnpm test:file test/guard-start-baseline-coverage.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, recordGitConfigEnd, recordGitConfigStart } from "../src/guard.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const root = join(mkdtempSync(join(tmpdir(), "sandcastle-guard-coverage-")), "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  return { project: { root, baseBranch: "main" } as Project, git };
};

const baselinePath = (root: string) => join(root, ".sandcastle", ".run", "git-config-baseline.json");

/** A run's start and its clean end, as burndown(), `land` and `gates` make them. */
const start = (project: Project, accept = false) => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run", accept));
const run = (project: Project) => {
  start(project);
  recordGitConfigEnd(project);
};

const refusal = (project: Project) => {
  let said = "";
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), (e: Error) => ((said = e.message), /^NOT STARTED: /.test(said)));
  return said;
};

const escaped = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "i");

/** Each key, set between two runs that both ended cleanly, refuses the next start, naming it. */
const heldBetweenRuns = (keys: [string, string][]) => {
  for (const [key, value] of keys) {
    const { project, git } = repo();
    run(project);
    git("config", key, value);
    const said = refusal(project);
    assert.match(said, escaped(`In .git/config: ${key} added`), key);
    assert.match(said, /Something wrote them between the runs/, key);
  }
};

test("a pager, editor, external diff or signing program set between two runs is refused, not pinned as the run's own", () => {
  heldBetweenRuns([
    ["core.pager", "touch owned"],
    ["core.editor", "touch owned"],
    ["core.askPass", "touch owned"],
    ["diff.external", "touch owned"],
    ["sequence.editor", "touch owned"],
    ["gpg.program", "touch owned"],
    ["gpg.ssh.program", "touch owned"],
    ["gpg.x509.program", "touch owned"],
  ]);
});

test("a remote's URL, programs or proxy changed between two runs is refused, naming the URL with its credentials hidden", () => {
  heldBetweenRuns([
    ["remote.origin.pushurl", "https://example.invalid/pushed.git"],
    ["remote.origin.uploadpack", "touch owned"],
    ["remote.origin.receivepack", "touch owned"],
    ["remote.origin.proxy", "http://proxy.invalid:3128"],
  ]);
  const { project, git } = repo();
  git("remote", "add", "origin", "https://example.invalid/project.git");
  run(project);
  git("remote", "set-url", "origin", "https://someone:s3cr3t@example.invalid/elsewhere.git");
  const said = refusal(project);
  assert.match(said, /remote\.origin\.url: "https:\/\/example\.invalid\/project\.git" -> "https:\/\/\*\*\*@example\.invalid\/elsewhere\.git"/);
  assert.doesNotMatch(said, /s3cr3t/);
});

test("a URL rewrite set between two runs is refused", () => {
  heldBetweenRuns([
    ["url.https://example.invalid/.insteadOf", "https://github.com/"],
    ["url.https://example.invalid/.pushInsteadOf", "https://github.com/"],
  ]);
});

test("a credential helper, an allowed protocol, a proxy or a trusted CA set between two runs is refused", () => {
  heldBetweenRuns([
    ["credential.helper", "!touch owned"],
    ["credential.https://example.invalid.helper", "!touch owned"],
    ["protocol.ext.allow", "always"],
    ["protocol.allow", "always"],
    ["http.proxy", "http://proxy.invalid:3128"],
    ["http.https://example.invalid/.proxy", "http://proxy.invalid:3128"],
    ["http.sslCAInfo", "/somewhere/ca.pem"],
    ["http.https://example.invalid/.sslCAInfo", "/somewhere/ca.pem"],
    ["http.https://example.invalid/.sslCAPath", "/somewhere/certs"],
    ["core.gitProxy", "touch owned"],
  ]);
});

test("a signature check, which runs the signing program, set between two runs is refused", () => {
  heldBetweenRuns([
    ["merge.verifySignatures", "true"],
    ["log.showSignature", "true"],
  ]);
});

test("an extension set between two runs is refused", () => {
  heldBetweenRuns([["extensions.worktreeConfig", "true"]]);
});

test("upstreams and fetch refspecs a person's own work changes stay free", () => {
  const { project, git } = repo();
  git("remote", "add", "origin", "https://example.invalid/project.git");
  run(project);
  git("config", "branch.topic.remote", "origin");
  git("config", "branch.topic.merge", "refs/heads/topic");
  git("config", "branch.topic.rebase", "true");
  git("config", "branch.topic.pushRemote", "origin");
  git("config", "--add", "remote.origin.fetch", "+refs/pull/*/head:refs/remotes/origin/pr/*");
  assert.doesNotThrow(() => assertGitConfigBaseline(project, "sandcastle run"));
});

test("a key in the main worktree's config.worktree is held, present or absent, and named under that file", () => {
  const { project, git } = repo();
  run(project);
  const worktreeConfig = join(project.root, ".git", "config.worktree");
  git("config", "--file", worktreeConfig, "filter.evil.smudge", "touch owned");
  const said = refusal(project);
  assert.match(said, /In \.git\/config\.worktree: filter\.evil\.smudge added/);
  assert.doesNotMatch(said, /In \.git\/config:/);
  assert.doesNotMatch(said, /touch owned/);
  assert.match(said, /--file \.git\/config\.worktree --unset-all/);
  assert.doesNotThrow(() => start(project, true));
  recordGitConfigEnd(project);
  // A key that runs nothing there is free, as in .git/config; the file removed takes its key with it.
  git("config", "--file", worktreeConfig, "user.name", "Someone");
  assert.doesNotThrow(() => assertGitConfigBaseline(project, "sandcastle run"));
  rmSync(worktreeConfig);
  assert.match(refusal(project), /In \.git\/config\.worktree: filter\.evil\.smudge removed/);
});

test("a hook added between two runs is refused, naming the file, and --accept-git-config takes it", () => {
  const { project } = repo();
  run(project);
  const hook = join(project.root, ".git", "hooks", "post-checkout");
  mkdirSync(join(project.root, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\ntouch owned\n");
  chmodSync(hook, 0o755);
  const said = refusal(project);
  assert.match(said, /Under \.git\/: hooks\/post-checkout added/);
  assert.match(said, /sandcastle run --accept-git-config/);
  assert.doesNotMatch(said, /touch owned/);
  assert.doesNotThrow(() => start(project, true));
  recordGitConfigEnd(project);
  assert.doesNotThrow(() => assertGitConfigBaseline(project, "sandcastle run"));
  writeFileSync(hook, "#!/bin/sh\ntouch owned again\n");
  assert.match(refusal(project), /hooks\/post-checkout changed/);
});

test("a hook planted after the last check is not made the baseline by the run's end", () => {
  const { project } = repo();
  start(project);
  mkdirSync(join(project.root, ".git", "hooks", "lib"), { recursive: true });
  writeFileSync(join(project.root, ".git", "hooks", "lib", "helper.sh"), "touch owned\n");
  recordGitConfigEnd(project);
  assert.equal(JSON.parse(readFileSync(baselinePath(project.root), "utf8")).clean, false);
  const said = refusal(project);
  assert.match(said, /hooks\/lib\/helper\.sh added/);
  assert.match(said, /did not end cleanly/);
});

test("a submodule's git directory created between two runs is refused, naming its config", () => {
  const { project } = repo();
  run(project);
  mkdirSync(join(project.root, ".git", "modules", "lib"), { recursive: true });
  writeFileSync(join(project.root, ".git", "modules", "lib", "config"), "[filter \"evil\"]\n\tsmudge = touch owned\n");
  assert.match(refusal(project), /modules\/lib\/config added/);
});

test("a record an earlier kit wrote, holding fewer keys and no files, is read as a first run", () => {
  const { project, git } = repo();
  git("remote", "add", "origin", "https://example.invalid/project.git");
  mkdirSync(join(project.root, ".sandcastle", ".run"), { recursive: true });
  writeFileSync(baselinePath(project.root), `${JSON.stringify({ entries: [], attributes: "", clean: true })}\n`);
  assert.doesNotThrow(() => start(project));
  recordGitConfigEnd(project);
  const record = JSON.parse(readFileSync(baselinePath(project.root), "utf8"));
  assert.deepEqual(record.entries, ["remote.origin.url\nhttps://example.invalid/project.git"]);
  assert.equal(record.clean, true);
});
