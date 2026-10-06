// A red merged tree blames a landed ticket only when that ticket changed a file this branch changed
// (both known from git); otherwise it is "red on the merged tree". Every red line - the requeue line,
// the outcome note, the tracker comment - names the red gate and up to five failing tests. Temp
// repos and a host worktree for the sandbox: no Docker, no gh, no network. The fake sandbox strips
// the `timeout -k` wrapper macOS lacks.
//
//   node --test test/requeue-red-wording.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { againLine, createHostGit, landOne, redDetail, redNote, requeuedLine } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { describe, notLandedComment } = await import("../src/ledger.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Landed = import("../src/landing.ts").Landed;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-red-wording-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const withLine = (at: number, text: string) => TEN.map((l, i) => (i === at ? text : l)).join("\n") + "\n";

// main holds big.txt (ten lines). 1 edits its first line, 2 its last: git merges both cleanly. 3 adds an unrelated file.
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "big.txt"), TEN.join("\n") + "\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "start");
  const branch = (id: string, file: string, text: string) => {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    writeFileSync(join(root, file), text);
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", `work on ${id}`);
    git(root, "checkout", "-q", "main");
  };
  branch("1", "big.txt", withLine(0, "ONE"));
  branch("2", "big.txt", withLine(9, "TEN"));
  branch("3", "other.txt", "other\n");
  branch("4", "own.txt", "own\n");
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

const failure = { name: "test", command: "test", exitCode: 1, output: "FAIL src/pair.test.ts\nFAIL src/other.test.ts\n" };
const RED: GateRun = { gates: [{ name: "test", pass: false }], failure, failures: [failure] };
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

const harness = (root: string, gate: Ctx["gate"]) => {
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, get: () => ({ body: "" }), close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate,
    landed: new Map(),
  };
  const head = (id: string) => git(root, "rev-parse", `agent/issue-${id}`);
  return { land: (id: string) => landOne(ctx, { issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: head(id) }) };
};

// Red once the merged tree has both of 1 and 2's edits: the gate cannot be told apart from a flake by the branch's own files.
const bothEdits: Ctx["gate"] = async (box) => ((await box.exec("grep -q ONE big.txt && grep -q TEN big.txt")).exitCode === 0 ? RED : GREEN);

test("red after a landed ticket that changed the same file names that ticket, and only it", async () => {
  const root = makeRepo();
  const h = harness(root, bothEdits);
  await h.land("1");
  await h.land("3");
  assert.deepEqual(await h.land("2"), { kind: "red", with: ["1"], gates: ["test"], failing: ["src/pair.test.ts", "src/other.test.ts"] });
});

test("red after landed tickets that share no file with the branch says it is red on the merged tree", async () => {
  const root = makeRepo();
  // One host for the repo (a second would read the first's landings as tampering): green until 4 lands.
  let red = false;
  const h = harness(root, async () => (red ? RED : GREEN));
  await h.land("1");
  await h.land("3");
  red = true;
  assert.deepEqual(await h.land("4"), { kind: "red", with: [], gates: ["test"], failing: ["src/pair.test.ts", "src/other.test.ts"] });
});

const red = (extra: Partial<Extract<Landed, { kind: "red" }>> = {}): Landed => ({ kind: "red", with: [], gates: ["test"], ...extra });
const ctx = { base: "main", gateNames: "test" };
const green = { issue: "2", branch: "agent/issue-2", status: "green", commits: 1, repairs: 0, head: "abc1234" };

test("the requeue line names the red gate and the failing tests, and a ticket only when one is named", () => {
  assert.equal(requeuedLine("red", [], { gates: ["test"], failing: ["a.test.ts", "b.test.ts"] }), "requeued after red on the merged tree (gate test; failing a.test.ts, b.test.ts)");
  assert.equal(requeuedLine("red", ["1", "3"], { gates: ["lint", "test"] }), "requeued after red with #1, #3 (gates lint, test)");
  assert.equal(requeuedLine("red", []), "requeued after red on the merged tree");
  assert.equal(requeuedLine("conflict", ["1"]), "requeued after conflict with #1");
  assert.equal(againLine("red", [], { gates: ["test"] }), "red again on the merged tree after a requeue (gate test)");
  assert.equal(againLine("red", ["1"], { gates: ["test"], failing: ["a.test.ts"] }), "red again with #1 after a requeue (gate test; failing a.test.ts)");
  assert.equal(redDetail(), "");
  assert.equal(redNote({ with: [] }), "red on the merged tree");
});

test("the outcome note, the outcome text and the tracker comment say the same", () => {
  const said = describe({ kind: "landing", green, landed: red({ failing: ["a.test.ts"] }), attempts: 1 }, ctx);
  assert.equal(said.record?.note, "red on the merged tree (gate test; failing a.test.ts)");
  assert.equal(said.outcome?.text, "red when merged (gate test; failing a.test.ts)");
  assert.match(said.tracker?.text ?? "", /Failing: a\.test\.ts\. Red on the merged tree: no ticket landed since this branch forked changed a file it changed\./);
  const named = describe({ kind: "landing", green, landed: red({ with: ["1"], failing: ["a.test.ts"] }), attempts: 1 }, ctx);
  assert.equal(named.record?.note, "red with #1 (gate test; failing a.test.ts)");
  assert.equal(named.outcome?.text, "red when merged with #1 (gate test; failing a.test.ts)");
  assert.match(named.tracker?.text ?? "", /changing a file it also changed: #1\./);
  assert.doesNotMatch(named.tracker?.text ?? "", /on the merged tree/);
  assert.match(notLandedComment(undefined, undefined, { branch: "b", base: "main", with: [], gates: ["test"] }) ?? "", /Red on the merged tree/);
});
