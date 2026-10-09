// A landing whose sandbox is slow to start (Sandcastle's container-start timeout, through `openOrAbandon`) costs that
// ticket only: it is not landed, with the words that name the cause, and the run is not stopped as for a failed `.git`
// check. landOne (src/landing.ts) against a temp git repo; the opener throws the library's error the way it arrives
// through `Effect.runPromise`. No Docker, no gh, no network.
//
//   pnpm test:file test/landing-start-timeout.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// landOne takes a sandbox slot from the machine-wide pool, whose directory is derived from this at import.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { landOne, createHostGit } = await import("../src/landing.ts");
const { gitFingerprint, openOrAbandon } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-timeout-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};

test("a landing sandbox that times out starting leaves the ticket not landed and does not stop the run", async () => {
  const root = join(TMP, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "shared.txt", "start\n", "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1");
  commitFile(root, "a.txt", "a\n", "work on 1");
  git(root, "checkout", "-q", "main");
  // The base moved since the branch was cut: no fast-forward, so the merge is made in a sandbox.
  commitFile(root, "b.txt", "b\n", "elsewhere");
  const before = git(root, "rev-parse", "main");

  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const opener: Ctx["opener"] = (branch) =>
    openOrAbandon(project, branch, async () => {
      throw Object.assign(new Error("Sandbox container start timed out after 120000ms"), { name: "(FiberFailure) Error" });
    });
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener,
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [], failures: [] }),
    landed: new Map(),
  };
  const head = git(root, "rev-parse", "agent/issue-1");
  const { result: landed } = await quietly(() => landOne(ctx, { issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0, head } as Parameters<typeof landOne>[1]));

  assert.equal(landed.kind, "not-landed");
  assert.match((landed as { reason: string }).reason, /Docker took longer than 120 s to start a container.*retry once the machine is quieter/s);
  assert.equal(git(root, "rev-parse", "main"), before, "nothing landed");
  assert.equal(ctx.host.failed, undefined, "the host's writer is not stopped");
});
