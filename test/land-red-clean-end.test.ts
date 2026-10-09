// A `sandcastle land` whose gates are red on the merge ends cleanly once its `.git` check passed: the
// git-config start baseline is marked clean, so the next start does not blame a sandbox for a change the
// operator made since. One whose sandbox changed the shared `.git` stops and leaves the record unclean.
// A temp git repo, the ticket-file tracker and a host worktree for the sandbox - no Docker, no model, no network.
//
//   pnpm test:file test/land-red-clean-end.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@localhost" });
const { landTicket } = await import("../src/land.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { assertGitConfigBaseline, recordGitConfigStart } = await import("../src/guard.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-land-red-clean-end-"));
let n = 0;

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

// `sandcastle land demo-01` as cli.ts runs it, up to the red gate: the start baseline recorded, then the landing.
const landRed = async (gate: string) => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, ".gitignore", ".sandcastle/\n");
  write(root, ".scratch/demo/issues/01-thing.md", "# A thing\n\nStatus: ready-for-agent\n\nDo it.\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "agent/issue-demo-01");
  write(root, "feature.txt", "the feature\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  git(root, "checkout", "-q", "main");
  const project = {
    name: "demo",
    root,
    baseBranch: "main",
    tracker: fakeTracker({ kind: "files" }),
    label: "ready-for-agent",
    gates: [{ name: "check", command: gate }],
    setup: [],
    generated: [],
  } as unknown as Project;
  const open: Opener = async (branch) => {
    const path = join(tmp, `wt-${n++}`);
    assert.equal(git(root, "worktree", "add", "-q", "-b", branch, path, "main").status, 0);
    return {
      worktreePath: path,
      // execGate wraps commands in `timeout -k n n`, which macOS lacks.
      exec: async (cmd) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
      },
    };
  };
  recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle land"));
  // landTicket prints a red gate's FAIL lines to stdout; a green suite must not carry them.
  const log = mock.method(console, "log", () => {});
  let error: Error | undefined;
  try {
    await landTicket(project, makeTracker(project), "demo-01", () => ({ open }));
  } catch (e) {
    error = e as Error;
  } finally {
    log.mock.restore();
  }
  const record = JSON.parse(readFileSync(join(root, ".sandcastle", ".run", "git-config-baseline.json"), "utf8"));
  return { project, root, error, clean: record.clean };
};

test("a land whose gates are red on the merge records a clean end: the operator's later fix is not blamed on a sandbox", async () => {
  const { project, root, error, clean } = await landRed("false");
  assert.match(error?.message ?? "", /Gates red on the merge of agent\/issue-demo-01 into main: check/);
  assert.equal(clean, true);
  git(root, "config", "core.hooksPath", join(tmp, "hooks"));
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle land"), (e: Error) => /Something wrote them between the runs\./.test(e.message) && !/did not end cleanly/.test(e.message));
});

test("a land whose sandbox changed the shared .git stops and leaves the record unclean", async () => {
  // The host worktree shares .git, as a sandbox does: `--local` writes the common config.
  const { error, clean } = await landRed(`git config --local core.hooksPath ${join(tmp, "planted")}; false`);
  assert.match(error?.message ?? "", /STOPPED after landing agent\/issue-demo-01 in a sandbox: \.git\/config/);
  assert.equal(clean, false);
});
