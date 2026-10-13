// A landing claims the gates pool once it holds its sandbox slot (src/pool.ts `claimSlot`), hands the claim to its gate
// (`ctx.gate`'s last argument), and ends it: a landing that gates spends exactly its own claim with its priority wait, and
// one that ends without gating releases it. Real `landOne` against a temp repo, a fake tracker and a host worktree for the
// sandbox, with the gate port a pool wait: the claims are seen through a ticket gate's wait for the one gates slot.
//
//   pnpm test:file test/landing-claim-gates.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
// Before anything from src/: it points the pool at a temp directory and answers its process probe.
import { cleanup, pool, POLL, sleep, until } from "./pool-sim.ts";

for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { claimSlot, withSlot } = pool;
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-claim-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const r of releases.splice(0)) r();
  await cleanup();
});
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
  // The base moved after the branch forked: the merge is made and gated in a landing sandbox.
  writeFileSync(join(root, "other.txt"), "other\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-q", "-m", "work on another ticket");
  return root;
};

/** A ticket gate of the run asking for the gates pool: whether it holds a slot is `held`. */
const ticketGate = () => {
  const t = { held: false };
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  releases.push(release);
  void withSlot("gates", "ticket gate", async () => {
    t.held = true;
    await hold;
  }, undefined, POLL);
  return t;
};

/**
 * Lands ticket 1 with `gate` as the context's port; `gate` is given the landing's claim, as `landOne` hands it.
 * Returns whether the landing merged.
 */
const land = async (gate: Ctx["gate"]) => {
  const root = makeRepo();
  const tracker = { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} };
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
    gate,
    landed: new Map(),
  };
  const head = git(root, "rev-parse", "agent/issue-1");
  const landed = await landOne(ctx, { issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0, head });
  return landed.kind;
};

const green = { gates: [{ name: "test", pass: true }], failures: [] };

test("a landing that gates spends its own claim with its priority wait, so a ticket gate asked after the wait takes the slot", async () => {
  let ticketHeld: boolean | undefined;
  const kind = await land(async (_box, _id, _how, claim) => {
    await withSlot("gates", "landing gate", async () => {}, undefined, POLL, true, false, undefined, claim);
    // The landing is still running (its claim would end with it): the gate wait has spent it, and the slot is free.
    const ticket = ticketGate();
    await sleep(150);
    ticketHeld = ticket.held;
    return green;
  });
  assert.equal(kind, "merged");
  assert.equal(ticketHeld, true);
});

test("a landing that gates ends only its own claim: another landing's still holds a ticket gate back", async () => {
  const other = claimSlot("gates");
  releases.push(other.release);
  let ticketHeld: boolean | undefined;
  const kind = await land(async (_box, _id, _how, claim) => {
    await withSlot("gates", "landing gate", async () => {}, undefined, POLL, true, false, undefined, claim);
    const ticket = ticketGate();
    await sleep(150);
    ticketHeld = ticket.held;
    return green;
  });
  assert.equal(kind, "merged");
  assert.equal(ticketHeld, false);
});

test("a landing that ends without gating releases its claim", async () => {
  let ticket: ReturnType<typeof ticketGate> | undefined;
  let heldWhileRunning: boolean | undefined;
  const kind = await land(async () => {
    // The port makes no gates wait: the claim the landing took stands until the landing ends.
    ticket = ticketGate();
    await sleep(150);
    heldWhileRunning = ticket.held;
    return green;
  });
  assert.equal(kind, "merged");
  assert.equal(heldWhileRunning, false, "the claim stood while the landing ran");
  await until(() => ticket!.held, "the ticket gate's slot, once the landing ended");
});
