// A run's landing goes before the run's tickets for a freed sandbox slot, even a ticket that began
// waiting first: `slotTurn` stops only pipelines that have not yet asked the pool, and within a run
// the pool serves ordinary waits in the order they began (src/pool.ts). With the run's share at one
// slot, a landing behind every ticket already waiting would wait out each of their pipelines. The
// pool is a temp XDG_CACHE_HOME of one sandbox slot, the landing sandbox a host worktree - no
// Docker, no model, no network.
//
//   node --test test/landing-slot-first.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-landing-slot-cache-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-landing-slot-cfg-"));
process.env.SANDCASTLE_MAX_SANDBOXES = "1";
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { inject, withSlot } = await import("../src/pool.ts");
const { commandOf } = await import("../src/live-runs.ts");
// This process takes slots, as a run would: `ps` would call it a test runner, and its slot stale.
inject({ probe: (pid) => (pid === process.pid ? everyPidIsTheKit() : commandOf(pid)) });
type Project = import("../src/config.ts").Project;
type Ctx = import("../src/landing.ts").LandContext;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-landing-slot-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};

test("a landing that asks for a sandbox slot after a ticket of its run still takes the next one freed", async () => {
  const root = join(tmp, "repo");
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
  const head = git(root, "rev-parse", "agent/issue-7").out;
  // The base moved past the branch's start, so the merge is made and gated in a landing sandbox.
  writeFileSync(join(root, "c.txt"), "c\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base moved");
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;

  const order: string[] = [];
  const open: Opener = async (branch) => {
    order.push("landing");
    const path = join(tmp, "wt");
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
  const slotWanted = { n: 0 };
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, close: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: open,
    runId: "2026-10-07T09:00:00.000Z",
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [], failures: [] }),
    landed: new Map(),
    slotWanted,
  };

  // The waits' lines are console.log's: kept out of the gate log.
  const { result: landed } = await quietly(async () => {
    let ticket: Promise<void> | undefined;
    let landing: ReturnType<typeof landOne> | undefined;
    await withSlot("sandboxes", "holder", async () => {
      let waits = false;
      // The ticket looks every 20 ms and the landing every 5 s: only the order can give the landing the slot.
      ticket = withSlot("sandboxes", "fixture #9", async () => void order.push("ticket"), () => (waits = true), 20);
      while (!waits) await sleep(5);
      await sleep(50);
      landing = landOne(ctx, { issue: "7", branch: "agent/issue-7", status: "green", commits: 1, repairs: 0, head });
      while (slotWanted.n === 0) await sleep(5);
      await sleep(50);
    });
    await ticket;
    return landing!;
  });
  assert.equal(landed.kind, "merged");
  assert.deepEqual(order, ["landing", "ticket"]);
});
