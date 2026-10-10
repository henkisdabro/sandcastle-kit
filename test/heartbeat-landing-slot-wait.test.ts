// The run's heartbeat does not count a landing's wait for a machine-wide sandbox slot as landing
// time: `landOne` (src/landing.ts) tells its `slotWait` port when it starts waiting and when it
// has the slot, and burndown's port (src/burndown.ts, which needs Docker, so held by a
// source match) sets the phase and restarts the landing's clock. Real `landOne` against a temp
// repo, a fake tracker and a host worktree for the sandbox: no Docker, no gh, no network.
//
//   pnpm test:file test/heartbeat-landing-slot-wait.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
// Before anything from src/: it points the pool at a temp directory and answers its process probe.
import { cleanup } from "./pool-sim.ts";

for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-slot-wait-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(cleanup);
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
  // The base moved after the branch forked: the merge is made and gated in a landing sandbox, which takes a slot.
  writeFileSync(join(root, "other.txt"), "other\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-q", "-m", "work on another ticket");
  return root;
};

/** Lands ticket 1 with `slotWait` as the context's port. */
const land = async (slotWait: Ctx["slotWait"]) => {
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
    gate: async () => ({ gates: [{ name: "test", pass: true }], failures: [] }),
    landed: new Map(),
    slotWait,
  };
  const head = git(root, "rev-parse", "agent/issue-1");
  return landOne(ctx, { issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0, head });
};

test("a landing that reaches its merge sandbox tells the heartbeat it waits for a slot, then that it has one", async () => {
  const told: string[] = [];
  const landed = await land((issue, state) => void told.push(`${issue} ${state}`));
  assert.equal(landed.kind, "merged");
  assert.deepEqual(told, ["1 waiting", "1 taken"]);
});

test("a heartbeat port that throws does not change the landing's result", async () => {
  const quiet = await land(undefined);
  const loud = await land(() => {
    throw new Error("the heartbeat broke");
  });
  assert.equal(loud.kind, quiet.kind);
});

const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");

test("the run's slotWait port sets the landing's phase while it waits and restarts its clock when the slot is taken", () => {
  const port = source.match(/slotWait: \(issue, state\) => \{[\s\S]*?\n    \},/)?.[0] ?? "";
  assert.match(port, /landing\.get\(issue\)/);
  assert.match(port, /if \(!step\) return;/);
  assert.match(port, /step\.phase = "waiting for a sandbox slot"/);
  assert.match(port, /delete step\.phase;\s+step\.since = Date\.now\(\)/);
});
