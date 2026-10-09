// `sandcastle clean` runs host git over whatever a killed run's sandbox left, so it holds the same checks a run
// does: the start baseline before the pins (a key planted in a killed run is refused, `--accept-git-config` is the
// way through), and each kept worktree's records and nested repositories (`assertWorktreeRecords`) before any git
// runs there. A worktree that fails is left as it is, with its branch and the reason, while a good one is removed,
// and the command exits non-zero. A stub `docker` that is down, temp repos: no Docker, model or network.
//
//   pnpm test:file test/clean-checks.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, recordGitConfigEnd, recordGitConfigStart, worktreeRefusal } from "../src/guard.ts";
import { cleanProject } from "../src/sandbox.ts";
import { runKit } from "./cli-spawn.ts";
import { dockerStub } from "./docker-stub.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

/** A project with a config, and tickets 1 and 2 each in a worktree under `.sandcastle/worktrees/`, as Sandcastle makes them. */
const sandboxes = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-clean-checks-")));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", gates: [{ name: "g", command: "true" }], tracker: "files" };\n`);
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  const wt = (n: number) => join(root, ".sandcastle", "worktrees", `agent-issue-${n}`);
  for (const n of [1, 2]) git(root, "worktree", "add", "-q", "-b", `agent/issue-${n}`, wt(n));
  return { project: { root, name: "fixture", baseBranch: "main" } as Project, root, wt, git };
};

test("a worktree whose record a sandbox changed is left with its branch and the reason, and a good one is removed", () => {
  const { project, root, wt, git } = sandboxes();
  // What a sandbox can write: a `config.worktree` beside the record, which git reads as that worktree's config.
  writeFileSync(join(root, ".git", "worktrees", "agent-issue-1", "config.worktree"), "[filter \"evil\"]\n\tclean = touch owned\n");
  const result = cleanProject(project, false, worktreeRefusal(project));
  assert.deepEqual(result.worktrees, [wt(2)]);
  assert.equal(result.left.length, 1);
  assert.equal(result.left[0]!.path, wt(1));
  assert.equal(result.left[0]!.branch, "agent/issue-1");
  assert.match(result.left[0]!.reason, /config\.worktree exists/);
  assert.ok(existsSync(wt(1)), "the tampered worktree is as it was");
  assert.ok(!existsSync(wt(2)), "the good one is gone");
  // Its branch is not offered to a delete git would refuse; the other (merged) one goes.
  assert.deepEqual(result.deleted.map((d) => d.branch), ["agent/issue-2"]);
  assert.match(git(root, "branch", "--list", "agent/issue-1"), /agent\/issue-1/);
});

test("a worktree with a repository nested in it is left as it is, and clean goes on with the others", () => {
  const { project, root, wt, git } = sandboxes();
  mkdirSync(join(wt(2), "sub", ".git"), { recursive: true });
  const result = cleanProject(project, true, worktreeRefusal(project));
  assert.deepEqual(result.worktrees, [wt(1)]);
  assert.deepEqual(result.left.map((l) => l.path), [wt(2)]);
  assert.match(result.left[0]!.reason, /sub\/\.git in the worktree of agent-issue-2 marks a git repository nested in it/);
  assert.ok(existsSync(wt(2)));
  // `--all` takes the branch of the removed worktree only.
  assert.deepEqual(result.deleted.map((d) => d.branch), ["agent/issue-1"]);
  assert.match(git(root, "branch", "--list", "agent/issue-2"), /agent\/issue-2/);
});

test("a clean worktree set has nothing left", () => {
  const { project } = sandboxes();
  assert.deepEqual(cleanProject(project, false, worktreeRefusal(project)).left, []);
});

/** `sandcastle clean` in the project, with a docker that is down and a config home of its own. */
const clean = (root: string, ...args: string[]) => {
  const docker = dockerStub();
  const config = mkdtempSync(join(tmpdir(), "sandcastle-clean-checks-cfg-"));
  return runKit(["clean", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: docker.first(process.env.PATH), HOME: config, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(config, "cache"), GIT_CEILING_DIRECTORIES: tmpdir() },
  });
};

test("a key planted since the last run's record is refused by clean, not pinned, and --accept-git-config goes through", () => {
  const { project, root, wt, git } = sandboxes();
  recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run"));
  recordGitConfigEnd(project);
  git(root, "config", "filter.evil.clean", "touch owned");

  const refused = clean(root);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /NOT STARTED: .*filter\.evil\.clean added/s);
  assert.doesNotMatch(refused.stderr, /touch owned/);
  assert.match(refused.stderr, /sandcastle clean --accept-git-config/);
  assert.ok(existsSync(wt(1)) && existsSync(wt(2)), "nothing was cleaned");
  // The pins would have overwritten the config; a refusal leaves it as found.
  assert.equal(git(root, "config", "--local", "--get", "filter.evil.clean"), "touch owned");

  const accepted = clean(root, "--accept-git-config");
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.ok(!existsSync(wt(1)) && !existsSync(wt(2)));
  // The way through records the state as the baseline, so the next run does not refuse it again.
  assert.doesNotThrow(() => assertGitConfigBaseline(project, "sandcastle run"));
});

test("clean exits 1 and names a worktree it left, while removing the others", () => {
  const { root, wt } = sandboxes();
  writeFileSync(join(root, ".git", "worktrees", "agent-issue-1", "config.worktree"), "[core]\n");
  const r = clean(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Left as they are/);
  assert.match(r.stdout, /agent-issue-1: .*config\.worktree exists/);
  assert.match(r.stdout, /removed worktree .*agent-issue-2/);
  assert.ok(existsSync(wt(1)) && !existsSync(wt(2)));
});

test("the clean case checks the baseline before the pins and hands cleanProject the worktree check", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const body = cli.slice(cli.indexOf('case "clean"'), cli.indexOf('case "clean"') + 2200);
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at("assertGitConfigBaseline(") < at("pinHostGitConfig("));
  assert.ok(at("lockRun(project)") < at("recordGitConfigStart("));
  assert.ok(at("recordGitConfigStart(") < at("cleanProject("));
  assert.match(body, /cleanProject\(project, args\.includes\("--all"\), worktreeRefusal\(project\)\)/);
  assert.match(body, /process\.exitCode = 1/);
});
