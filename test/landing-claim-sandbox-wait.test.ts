// The run's gates claim (src/pool.ts `createRunClaim`) stands from the moment a green branch is queued to land, before the
// landing holds a sandbox slot. A ticket's gates run in the sandbox slot its pipeline holds: with that slot the last one free
// (a pool of one), the landing waits for it while the ticket's gate waits behind the claim, and neither ever moves. So a claim
// holds a ticket gate back only while no landing of the run waits for a sandbox slot (`priorityAhead`). Real `landOne` through
// `createLanding`, against a temp repo with a host worktree for the sandbox, a sandboxes limit of 1 and a gates limit of 1.
//
//   pnpm test:file test/landing-claim-sandbox-wait.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
// Before anything from src/: it points the pool at a temp directory and answers its process probe.
import { cleanup, pool, POLL, steady, until } from "./pool-sim.ts";

// Before the pool first reads its sandboxes limit, which it keeps.
process.env.SANDCASTLE_MAX_SANDBOXES = "1";
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne } = await import("../src/landing.ts");
const { createLanding, createStopState } = await import("../src/schedule.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { createRunClaim, limit, withSlot } = pool;
type Ctx = import("../src/landing.ts").LandContext;
type Landable = import("../src/landing.ts").Landable;
type Landed = import("../src/landing.ts").Landed;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-claim-sandbox-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const r of releases.splice(0)) r();
  await cleanup();
});

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const makeRepo = () => {
  const root = join(TMP, "repo");
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
  // The base moved after the branch forked: the merge is made and gated in a landing sandbox, which needs a slot.
  writeFileSync(join(root, "other.txt"), "other\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-q", "-m", "work on another ticket");
  return root;
};

test("a landing waiting for the sandbox slot a ticket holds leaves that ticket's gate the gates slot, and lands after it", async () => {
  assert.equal(limit("sandboxes"), 1);
  assert.equal(limit("gates"), 1);
  const root = makeRepo();
  const tracker = { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} };
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const log: string[] = [];
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: async (branch) => {
      const path = join(TMP, "wt");
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
    gate: async (_box, _id, _how, claim) => {
      await withSlot("gates", "landing gate", async () => void log.push("landing gate"), undefined, POLL, true, false, undefined, claim);
      return { gates: [{ name: "test", pass: true }], failures: [] } as unknown as Awaited<ReturnType<Ctx["gate"]>>;
    },
    landed: new Map(),
  };

  // A ticket's pipeline holds the pool's only sandbox slot; its gates will run in it.
  let askGates!: () => void;
  const gatesAsked = new Promise<void>((r) => (askGates = r));
  releases.push(askGates);
  let inSandbox = false;
  const ticket = withSlot("sandboxes", "ticket", async () => {
    inSandbox = true;
    await gatesAsked;
    await withSlot("gates", "ticket gate", async () => void log.push("ticket gate"), undefined, POLL);
  }, undefined, POLL);
  await until(() => inSandbox, "the ticket's sandbox slot");

  // The ticket's branch before it went green, queued to land: the run's claim stands from here.
  const claim = createRunClaim("gates");
  const landing = createLanding<Landable & { issue: string }>(
    { claim, host: { check: async () => {}, failed: undefined }, land: (o) => landOne(ctx, o, { claim }) },
    createStopState(),
    { settled: (_g: unknown, landed: Landed) => void log.push(landed.kind) } as never,
  );
  landing.push({ issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", "agent/issue-1") });
  const running = landing.run();
  landing.close();
  // The landing now waits for the sandbox slot the ticket holds; the ticket's gate asks for the free gates slot.
  await steady(() => !log.includes("landing gate"), "the landing waited for the ticket's sandbox slot", 60);
  askGates();
  await until(() => log.includes("ticket gate"), "the ticket gate's slot, while the landing waits for the ticket's sandbox");
  await ticket;
  await running;
  assert.deepEqual(log, ["ticket gate", "landing gate", "merged"]);
});
