// A sandbox landing whose host fast-forward fails on an `index.lock` that appeared mid-run: a lock that is gone
// after a short wait costs that ticket only, one that stays stops the landings once, naming the file, instead of
// costing every later ticket a sandbox and a gate run. The landing sandbox is a host worktree - no Docker, no
// model, no network.
//
//   pnpm test:file test/landing-sandbox-lock.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-sandbox-lock-cache-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-sandbox-lock-cfg-"));
process.env.SANDCASTLE_MAX_SANDBOXES = "1";
const { createHostGit, landOne, LandingStop } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { inject } = await import("../src/pool.ts");
const { commandOf } = await import("../src/live-runs.ts");
// This process takes a slot, as a run would: `ps` would call it a test runner, and its slot stale.
inject({ probe: (pid) => (pid === process.pid ? everyPidIsTheKit() : commandOf(pid)) });
type Project = import("../src/config.ts").Project;
type Ctx = import("../src/landing.ts").LandContext;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-sandbox-lock-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};

// A repo whose base moved past the branch's start, so the merge is made and gated in a landing sandbox.
const setup = () => {
  const dir = join(tmp, `case${n++}`);
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  git(root, "checkout", "-q", "main");
  const head = git(root, "rev-parse", "agent/issue-7").out;
  writeFileSync(join(root, "c.txt"), "c\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base moved");
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const opened: string[] = [];
  const open: Opener = async (branch) => {
    opened.push(branch);
    const path = join(dir, `wt${opened.length}`);
    assert.equal(git(root, "worktree", "add", "-q", "-b", branch, path, "main").status, 0);
    return {
      worktreePath: path,
      exec: async (cmd) => {
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => git(root, "worktree", "remove", "--force", path),
    };
  };
  const lock = join(root, ".git", "index.lock");
  // The lock appears while the sandbox gates, after the host's last check and before its fast-forward.
  const ctx = (lockRecheckMs: number, onLock: () => void): Ctx => ({
    lockRecheckMs,
    project,
    tracker: { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: open,
    runId: "2026-10-10T09:00:00.000Z",
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => {
      writeFileSync(lock, "");
      onLock();
      return { gates: [], failures: [] };
    },
    landed: new Map(),
  });
  return { root, head, lock, opened, ctx };
};
const green = (head: string) => ({ issue: "7", branch: "agent/issue-7", status: "green" as const, commits: 1, repairs: 0, head });

test("a lock that stays after a sandbox landing's fast-forward stops the landings once, naming the file", async () => {
  const s = setup();
  const ctx = s.ctx(50, () => {});
  await assert.rejects(
    quietly(() => landOne(ctx, green(s.head))),
    (e: Error) => e instanceof LandingStop && e.message.includes(s.lock) && /Nothing more lands/.test(e.message) && /remove .*index\.lock/.test(e.message),
  );
  assert.equal(s.opened.length, 1);
  assert.ok(existsSync(s.lock), "the kit does not delete a lock it did not take");
  assert.notEqual(git(s.root, "rev-parse", "main").out, git(s.root, "rev-parse", "agent/issue-7").out);
});

test("a lock that is gone after a short wait costs the landing's ticket only, not the run", async () => {
  const s = setup();
  const ctx = s.ctx(200, () => void setTimeout(() => rmSync(s.lock, { force: true }), 300));
  const { result } = await quietly(() => landOne(ctx, green(s.head)));
  assert.equal(result.kind, "not-landed");
  assert.ok(!existsSync(s.lock));
});
