// A landing sandbox's peak memory goes to the machine-wide peaks file, filed under the run, as a
// ticket's, base and verify sandboxes' do: a landing gate is often the run's largest. A run's landing
// (`landOne`) hands `landInSandbox` the run's id from its `LandContext`. The sandbox is a host
// worktree whose `exec` answers for the kernel's `memory.peak`, the cache directory a temp
// XDG_CACHE_HOME - no Docker, no model, no network.
//
//   pnpm exec tsx --test test/peaks-landing.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-peaks-landing-cache-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-peaks-landing-cfg-"));
const { landInSandbox } = await import("../src/land.ts");
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { PEAKS_FILE } = await import("../src/peaks.ts");
type Project = import("../src/config.ts").Project;
type Ctx = import("../src/landing.ts").LandContext;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-peaks-landing-"));
const MIB = 2 ** 20;
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};

/** A repo whose agent branch merges cleanly into main, and a landing sandbox whose `memory.peak` reads `peakMib`. */
const fixture = (peakMib: number) => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  git(root, "checkout", "-q", "main");
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const events: string[] = [];
  const open: Opener = async (branch) => {
    const path = join(tmp, `wt-${n++}`);
    assert.equal(git(root, "worktree", "add", "-q", "-b", branch, path, "main").status, 0);
    return {
      worktreePath: path,
      exec: async (cmd) => {
        if (cmd.includes("memory.peak")) {
          events.push("peak read");
          return { exitCode: 0, stdout: `${peakMib * MIB}\n`, stderr: "" };
        }
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => {
        events.push("closed");
        return git(root, "worktree", "remove", "--force", path);
      },
    };
  };
  return { project, open, events, head: git(root, "rev-parse", "agent/issue-7").out };
};

const peakLines = () => (existsSync(PEAKS_FILE) ? readFileSync(PEAKS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("a landing sandbox's close writes one peaks line under the run's id", async () => {
  const f = fixture(5632);
  const before = peakLines().length;
  const r = await landInSandbox(f.project, { branch: "agent/issue-7", head: f.head, message: "Merge agent/issue-7 (closes #7)", run: "2026-10-05T09:00:00.000Z" }, f.open);
  assert.equal(r.kind, "merged");
  const lines = peakLines().slice(before);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].run, "2026-10-05T09:00:00.000Z");
  assert.equal(lines[0].peakMib, 5632);
  assert.equal(lines[0].agentMib, undefined, "a landing sandbox runs no agent");
  assert.deepEqual(f.events.slice(-2), ["peak read", "closed"], "read before the sandbox closes");
});

test("a landing sandbox whose kernel gives no peak writes no line", async () => {
  const f = fixture(0);
  const before = peakLines().length;
  const r = await landInSandbox(f.project, { branch: "agent/issue-7", head: f.head, message: "Merge agent/issue-7 (closes #7)", run: "run-2" }, f.open);
  assert.equal(r.kind, "merged");
  assert.equal(peakLines().length, before);
});

test("a run's landing files its sandbox's peak under the run's id", async () => {
  const f = fixture(5300);
  // The base moved past the branch's start, so the merge is made and gated in a landing sandbox.
  writeFileSync(join(f.project.root, "c.txt"), "c\n");
  git(f.project.root, "add", "-A");
  git(f.project.root, "commit", "-q", "-m", "base moved");
  const ctx: Ctx = {
    project: f.project,
    tracker: { ref: (id: string) => `#${id}`, close: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: f.open,
    runId: "2026-10-05T11:00:00.000Z",
    withdrawal: () => undefined,
    host: createHostGit(f.project, gitFingerprint(f.project)),
    gate: async () => ({ gates: [], failures: [] }),
    landed: new Map(),
  };
  const before = peakLines().length;
  const landed = await landOne(ctx, { issue: "7", branch: "agent/issue-7", status: "green", commits: 1, repairs: 0, head: f.head });
  assert.equal(landed.kind, "merged");
  const lines = peakLines().slice(before);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].run, "2026-10-05T11:00:00.000Z");
  assert.equal(lines[0].peakMib, 5300);
});
