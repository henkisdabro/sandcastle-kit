// The run's host guard stops git's background maintenance, not only `gc.auto`: since git 2.29 a
// merge or commit starts `git maintenance run --auto`, whose tasks (from git 2.54 on, repack,
// worktree prune, ref pack, reflog expiry) a sandbox writing beside the host's git must not meet.
// Temp repos only: no Docker, no network.
//
//   pnpm test:file test/host-git-maintenance-off.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// A pair the test preload set would be kept by `hostGitConfig` (it adds no key already set), so the
// checks below would pass whatever `disableHostGitGc` does. GIT_CONFIG_GLOBAL and _NOSYSTEM stay.
for (const k of Object.keys(process.env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete process.env[k];
const { disableHostGitGc } = await import("../src/guard.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-host-maintenance-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const makeRepo = () => {
  const root = join(TMP, "repo");
  git(TMP, "init", "-q", "-b", "main", root);
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "start");
  git(root, "checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, "add", "b.txt");
  git(root, "commit", "-q", "-m", "feature work");
  git(root, "checkout", "-q", "main");
  return root;
};

const keys = () => Object.entries(process.env).filter(([k]) => /^GIT_CONFIG_KEY_\d+$/.test(k)).map(([, v]) => v);
const maintenanceRuns = (trace: string) => (readFileSync(trace, "utf8").match(/run_command: git maintenance run/g) ?? []).length;

const root = makeRepo();
disableHostGitGc();
disableHostGitGc();

test("calling the host guard's gc switch twice pins maintenance.auto=false once, beside gc.auto=0", () => {
  assert.equal(keys().filter((k) => k?.toLowerCase() === "maintenance.auto").length, 1);
  assert.equal(keys().filter((k) => k?.toLowerCase() === "gc.auto").length, 1);
  assert.equal(git(root, "config", "--show-origin", "--get", "maintenance.auto"), "command line:\tfalse");
  assert.equal(git(root, "config", "--get", "gc.auto"), "0");
});

test("a host merge and commit under the guard start no background maintenance", () => {
  const trace = join(TMP, "guarded.log");
  process.env.GIT_TRACE = trace;
  try {
    git(root, "merge", "-q", "--no-ff", "-m", "land feature", "feature");
    writeFileSync(join(root, "c.txt"), "c\n");
    git(root, "add", "c.txt");
    git(root, "commit", "-q", "-m", "more");
  } finally {
    delete process.env.GIT_TRACE;
  }
  assert.equal(maintenanceRuns(trace), 0);
});

test("the same merge with maintenance turned back on does start it, so the check above can fail", () => {
  const trace = join(TMP, "unguarded.log");
  git(root, "checkout", "-q", "-b", "other", "main");
  writeFileSync(join(root, "d.txt"), "d\n");
  git(root, "add", "d.txt");
  git(root, "commit", "-q", "-m", "other work");
  git(root, "checkout", "-q", "main");
  process.env.GIT_TRACE = trace;
  try {
    git(root, "-c", "maintenance.auto=true", "-c", "maintenance.autoDetach=false", "merge", "-q", "--no-ff", "-m", "land other", "other");
  } finally {
    delete process.env.GIT_TRACE;
  }
  assert.ok(maintenanceRuns(trace) > 0);
});
