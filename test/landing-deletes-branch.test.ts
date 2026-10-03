// A landed branch is deleted at its landing in both modes (`land: "merge"` and `"squash"`), so merged
// `agent/issue-*` branches do not pile up until `sandcastle clean`; a branch that did not land is
// kept. Real `landOne` against a temp repo, a fake tracker and a host worktree for the sandbox: no
// Docker, no gh, no network.
//
//   pnpm exec tsx --test test/landing-deletes-branch.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-deletes-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
// main holds shared.txt; each branch is cut from it and changes one file.
const makeRepo = (branches: Record<string, [string, string]>) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "shared.txt", "start\n", "start");
  for (const [id, [file, text]] of Object.entries(branches)) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    commitFile(root, file, text, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  return root;
};

const land = (root: string, id: string, mode: "merge" | "squash", red = false) => {
  const tracker = { ref: (i: string) => `#${i}`, close: () => {}, comment: () => {}, hold: () => {} };
  const project = { root, name: "fixture", baseBranch: "main", land: mode, generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    // The sandbox a merge is made and gated in: a host worktree.
    opener: async (branch) => {
      const path = join(TMP, `wt${n++}`);
      git(root, "worktree", "add", "-q", "-b", branch, path, "main");
      return {
        worktreePath: path,
        exec: async (cmd) => {
          const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
          return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
        },
        close: async () => git(root, "worktree", "remove", "--force", path),
      };
    },
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    // Red on a merged tree holding both tickets' files: a lone branch fast-forwards and is not gated again.
    gate: async (box) => {
      const bad = red && (await box.exec("test -e a.txt && test -e b.txt")).exitCode === 0;
      const failure = { name: "test", command: "test", exitCode: 1, output: "FAIL" };
      return bad ? { gates: [{ name: "test", pass: false }], failure, failures: [failure] } : { gates: [{ name: "test", pass: true }], failures: [] };
    },
    landed: new Map(),
  } as Ctx;
  return landOne(ctx, {
    issue: id,
    branch: `agent/issue-${id}`,
    status: "green",
    commits: 1,
    repairs: 0,
    head: git(root, "rev-parse", `agent/issue-${id}`),
  });
};

for (const mode of ["merge", "squash"] as const) {
  test(`${mode}: the landed branch is deleted and its work is on the base`, async () => {
    const root = makeRepo({ 1: ["a.txt", "a\n"], 2: ["b.txt", "b\n"] });
    assert.equal((await land(root, "1", mode)).kind, "merged");
    assert.equal(git(root, "branch", "--list", "agent/issue-1"), "");
    assert.equal(git(root, "show", "main:a.txt"), "a");
    // Only the landed ticket's branch goes.
    assert.notEqual(git(root, "branch", "--list", "agent/issue-2"), "");
    assert.equal(git(root, "log", "main", "-1", "--format=%s"), "Merge agent/issue-1 (closes #1)");
  });

  test(`${mode}: a red landing keeps the branch`, async () => {
    const root = makeRepo({ 1: ["a.txt", "a\n"], 2: ["b.txt", "b\n"] });
    assert.equal((await land(root, "1", mode, true)).kind, "merged");
    assert.equal((await land(root, "2", mode, true)).kind, "red");
    assert.equal(git(root, "branch", "--list", "agent/issue-1"), "");
    assert.notEqual(git(root, "branch", "--list", "agent/issue-2"), "");
  });

  test(`${mode}: a branch a worktree still holds is kept, and the landing stands`, async () => {
    const root = makeRepo({ 1: ["a.txt", "a\n"] });
    const kept = join(TMP, `kept${n++}`);
    // git refuses to delete a branch checked out in another worktree.
    git(root, "worktree", "add", "-q", kept, "agent/issue-1");
    assert.equal((await land(root, "1", mode)).kind, "merged");
    assert.notEqual(git(root, "branch", "--list", "agent/issue-1"), "");
    assert.equal(git(root, "show", "main:a.txt"), "a");
    git(root, "worktree", "remove", "--force", kept);
  });
}
