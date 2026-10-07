// A branch that no longer merges onto the base is found on the host, with git's own merge-tree,
// before it takes a landing sandbox slot: `landOne` answers `conflict` at once, with no slot asked
// for and no sandbox opened. A conflict only in generated files stays on the sandbox path (it
// regenerates them there), and so does a git older than 2.38, which has no `merge-tree --write-tree`.
// Temp repos, a host worktree for the sandbox, a fake tracker - no Docker, no model, no network.
//
//   pnpm test:file test/landing-precheck.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-precheck-cache-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-precheck-cfg-"));
process.env.SANDCASTLE_MAX_SANDBOXES = "1";
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { inject } = await import("../src/pool.ts");
const { commandOf } = await import("../src/live-runs.ts");
// This process takes slots, as a run would: `ps` would call it a test runner, and its slot stale.
inject({ probe: (pid) => (pid === process.pid ? everyPidIsTheKit() : commandOf(pid)) });
type Project = import("../src/config.ts").Project;
type Ctx = import("../src/landing.ts").LandContext;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-precheck-"));
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};
const commit = (root: string, files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  git(root, "add", "-A");
  assert.equal(git(root, "commit", "-q", "-m", message).status, 0);
};

/**
 * main holds `shared.txt` and `lock.txt`; `agent/issue-7` changes `branch`, then main changes `base`,
 * so the merge is not a fast-forward; ticket 3 stands for the landing that changed `base`.
 */
const setup = (branch: Record<string, string>, base: Record<string, string>, generated: Project["generated"] = []) => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  commit(root, { "shared.txt": "start\n", "lock.txt": "lock 0\n" }, "start");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  commit(root, branch, "work on 7");
  git(root, "checkout", "-q", "main");
  const head = git(root, "rev-parse", "agent/issue-7").out;
  commit(root, base, "ticket 3 landed");
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated, gates: [], setup: [] } as unknown as Project;
  const opened: string[] = [];
  const open: Opener = async (name) => {
    opened.push(name);
    const path = join(tmp, `wt${n++}`);
    assert.equal(git(root, "worktree", "add", "-q", "-b", name, path, "main").status, 0);
    return {
      worktreePath: path,
      exec: async (cmd) => {
        // The fake sandbox is a host worktree: macOS has no `timeout -k`.
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => git(root, "worktree", "remove", "--force", path),
    };
  };
  // A landing that asks the pool for a slot raises `n` first: `asked` is the most it ever reached.
  let wanted = 0;
  const asked = { value: 0 };
  const slotWanted = {
    get n() {
      return wanted;
    },
    set n(v: number) {
      wanted = v;
      asked.value = Math.max(asked.value, v);
    },
  };
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, close: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: open,
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [], failures: [] }),
    landed: new Map([["3", { commit: git(root, "rev-parse", "main").out, files: Object.keys(base) }]]),
    slotWanted,
  };
  const land = (c: Ctx = ctx) => quietly(() => landOne(c, { issue: "7", branch: "agent/issue-7", status: "green", commits: 1, repairs: 0, head })).then((r) => r.result);
  return { root, ctx, land, opened, asked };
};

test("a branch whose file the base changed too is a conflict at once, with no slot asked for and no sandbox opened", async () => {
  const { land, opened, asked } = setup({ "shared.txt": "from seven\n" }, { "shared.txt": "from three\n" });
  const landed = await land();
  assert.deepEqual(landed, { kind: "conflict", files: ["shared.txt"], with: ["3"] });
  assert.deepEqual(opened, []);
  assert.equal(asked.value, 0);
});

test("a conflict outside the generated files is a conflict at once, though a generated file conflicted too", async () => {
  const generated = [{ paths: ["lock.txt"], regen: "echo regenerated > lock.txt" }];
  const { land, opened } = setup({ "shared.txt": "from seven\n", "lock.txt": "lock 7\n" }, { "shared.txt": "from three\n", "lock.txt": "lock 3\n" }, generated);
  const landed = await land();
  assert.deepEqual(landed, { kind: "conflict", files: ["lock.txt", "shared.txt"], with: ["3"] });
  assert.deepEqual(opened, []);
});

test("a branch that merges cleanly still goes to the sandbox", async () => {
  const { land, opened, asked } = setup({ "shared.txt": "from seven\n" }, { "other.txt": "from three\n" });
  const landed = await land();
  assert.equal(landed.kind, "merged");
  assert.equal(opened.length, 1);
  assert.equal(asked.value, 1);
});

test("a conflict only in generated files still goes to the sandbox, which regenerates them", async () => {
  const generated = [{ paths: ["lock.txt"], regen: "echo regenerated > lock.txt" }];
  const { land, opened, asked } = setup({ "lock.txt": "lock 7\n" }, { "lock.txt": "lock 3\n" }, generated);
  const landed = await land();
  assert.equal(landed.kind, "merged");
  assert.equal(opened.length, 1);
  assert.equal(asked.value, 1);
});

test("with a git older than 2.38 the conflict is found by the sandbox, as before", async () => {
  const { ctx, land, opened, asked } = setup({ "shared.txt": "from seven\n" }, { "shared.txt": "from three\n" });
  const landed = await land({ ...ctx, gitVersion: "git version 2.37.9" });
  assert.deepEqual(landed, { kind: "conflict", files: ["shared.txt"], with: ["3"] });
  assert.equal(opened.length, 1);
  assert.equal(asked.value, 1);
});
