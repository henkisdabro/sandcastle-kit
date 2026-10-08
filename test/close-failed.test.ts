// A close the tracker refuses is recorded as `close-failed`, the merge standing, and is not tried
// again: a retry after a close that had posted its comment and then failed posted the comment
// twice. The run releases the ticket's dependants all the same (test/release-dependants.test.ts).
// landOne (src/landing.ts) on a temp repo with a fake tracker and a host worktree for the sandbox.
// No Docker, no gh, no network.
//
//   pnpm test:file test/close-failed.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-close-failed-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "shared.txt"), "start\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-q", "-m", "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  writeFileSync(join(root, "one.txt"), "one\n");
  git(root, "add", "one.txt");
  git(root, "commit", "-q", "-m", "work on 1");
  git(root, "checkout", "-q", "main");
  return root;
};

/** Lands ticket 1 with a tracker whose close throws for its first `refusals` calls. */
const land = async (refusals: number) => {
  const root = makeRepo();
  let calls = 0;
  const tracker = {
    ref: (id: string) => `#${id}`,
    close: () => {
      if (++calls <= refusals) throw new Error("HTTP 502");
    },
    hold: () => {},
  };
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
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
    gate: async () => ({ gates: [{ name: "test", pass: true }], failures: [] }),
    landed: new Map(),
  };
  const head = git(root, "rev-parse", "agent/issue-1");
  const landed = await landOne(ctx, { issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0, head });
  return { landed, calls };
};

test("a close the tracker refuses is recorded as close-failed, and asked once", async () => {
  const { landed, calls } = await land(1);
  assert.deepEqual(landed, { kind: "close-failed", error: "HTTP 502" });
  assert.equal(calls, 1);
});
