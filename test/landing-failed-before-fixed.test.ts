// A test a ticket's gates failed and a repair then fixed is not "seen on the branch before" when a landed ticket breaks it
// again: `rememberFailed` drops it at a green run on another head, and keeps a flake that went green on the same head.
// Temp repos and a host worktree for the landing sandbox, as test/landing-red-rerun.test.ts has: no Docker, no gh, no network.
//
//   pnpm test:file test/landing-failed-before-fixed.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne, rememberFailed } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { quietly } = await import("./quiet.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-failed-before-fixed-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
const makeRepo = (branches: Record<string, Record<string, string>>) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "shared.txt", "start\n", "start");
  for (const [id, files] of Object.entries(branches)) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    for (const [file, text] of Object.entries(files)) commitFile(root, file, text, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  return root;
};
const opener = (root: string): Ctx["opener"] => async (branch) => {
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
};

const redOn = (name: string, head: string | undefined, ...tests: string[]): GateRun => {
  const failure = { name, command: name, exitCode: 1, output: tests.map((t) => `FAIL ${t}`).join("\n") };
  return { gates: [{ name: "lint", pass: true }, { name, pass: false }], failure, failures: [failure], ...(head ? { head } : {}) };
};
const greenAt = (head: string | undefined): GateRun => ({ gates: [{ name: "lint", pass: true }, { name: "test", pass: true }], failures: [], ...(head ? { head } : {}) });
const tests = (kept: Map<string, Set<string>>, id: string) => [...(kept.get(id) ?? [])].sort();

test("a test red at one head and green at another, after a repair commit, is no longer kept", () => {
  const kept = new Map<string, Set<string>>();
  rememberFailed(kept, "7", redOn("test", "h1", "t.test.ts", "u.test.ts"));
  rememberFailed(kept, "7", greenAt("h2"));
  assert.deepEqual(tests(kept, "7"), []);
});

test("a test red and then green on the same head is a flake and stays", () => {
  const kept = new Map<string, Set<string>>();
  rememberFailed(kept, "7", redOn("test", "h1", "t.test.ts"));
  rememberFailed(kept, "7", greenAt("h1"));
  assert.deepEqual(tests(kept, "7"), ["t.test.ts"]);
  // The in-slot re-run: one result, the green re-run on the red run's head.
  rememberFailed(kept, "8", { ...greenAt("h1"), rerunOf: redOn("test", "h1", "a.test.ts") });
  assert.deepEqual(tests(kept, "8"), ["a.test.ts"]);
});

test("a red run that does not list the test drops nothing, whatever its head", () => {
  const kept = new Map<string, Set<string>>();
  rememberFailed(kept, "7", redOn("test", "h1", "t.test.ts"));
  rememberFailed(kept, "7", redOn("test", "h2", "other.test.ts"));
  assert.deepEqual(tests(kept, "7"), ["other.test.ts", "t.test.ts"]);
  rememberFailed(kept, "7", redOn("lint", "h3"));
  assert.deepEqual(tests(kept, "7"), ["other.test.ts", "t.test.ts"]);
});

test("a test red again after the repair is recorded again, on its new head", () => {
  const kept = new Map<string, Set<string>>();
  rememberFailed(kept, "7", redOn("test", "h1", "t.test.ts"));
  rememberFailed(kept, "7", greenAt("h2"));
  rememberFailed(kept, "7", redOn("test", "h3", "t.test.ts"));
  assert.deepEqual(tests(kept, "7"), ["t.test.ts"]);
  rememberFailed(kept, "7", greenAt("h3"));
  assert.deepEqual(tests(kept, "7"), ["t.test.ts"], "red and green on h3: a flake");
  rememberFailed(kept, "7", greenAt("h4"));
  assert.deepEqual(tests(kept, "7"), []);
});

test("runs with no head count as the same head, so a fake's reds and greens read as before", () => {
  const kept = new Map<string, Set<string>>();
  rememberFailed(kept, "7", redOn("test", undefined, "t.test.ts"));
  rememberFailed(kept, "7", greenAt(undefined));
  assert.deepEqual(tests(kept, "7"), ["t.test.ts"]);
  rememberFailed(kept, "7", greenAt("h2"));
  assert.deepEqual(tests(kept, "7"), ["t.test.ts"]);
});

// Both branches add t.test.ts with the same text: git merges that cleanly, and the landed ticket changed a file the branch did.
const landRed = async (failedBefore: Map<string, Set<string>>) => {
  const root = makeRepo({ 1: { "t.test.ts": "one\n" }, 2: { "t.test.ts": "one\n", "b.txt": "b\n" } });
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const red = redOn("test", undefined, "t.test.ts");
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, get: () => ({ body: "" }), close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "lint, test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => red,
    landed: new Map(),
    reds: new Map(),
    failedBefore,
  };
  const land = async (id: string) =>
    (await quietly(() => landOne(ctx, { issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${id}`) }))).result;
  assert.equal((await land("1")).kind, "merged");
  return land("2");
};

test("a landing red on a test a repair fixed names the ticket that landed and broke it again", async () => {
  const kept = new Map<string, Set<string>>();
  rememberFailed(kept, "2", redOn("test", "h1", "t.test.ts"));
  rememberFailed(kept, "2", greenAt("h2"));
  const landed = await landRed(kept);
  assert.equal(landed.kind, "red");
  assert.deepEqual(landed.kind === "red" && landed.with, ["1"]);
  assert.equal(landed.kind === "red" && landed.seen, undefined);
});

test("a landing red on a flake that went green on the same head is still seen on the branch before", async () => {
  const kept = new Map<string, Set<string>>();
  rememberFailed(kept, "2", redOn("test", "h1", "t.test.ts"));
  rememberFailed(kept, "2", greenAt("h1"));
  const landed = await landRed(kept);
  assert.equal(landed.kind, "red");
  assert.deepEqual(landed.kind === "red" && landed.with, []);
  assert.equal(landed.kind === "red" && landed.seen, true);
});
