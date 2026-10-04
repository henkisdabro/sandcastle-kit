// landOne (src/landing.ts) writes no verdict: it returns how the landing went, with the facts the
// run record keeps - the files a conflict or a hold names, the failing tests of a red merged tree,
// the paths beyond the Touches line, the error of a failed close - and the ledger (src/ledger.ts)
// records them from the ending the scheduler tells. A requeued ticket whose second attempt never
// began is recorded from that ending too, with nothing to undo. Temp repos, a fake tracker and a
// host worktree for the sandbox: no Docker, no gh, no network. The fake sandbox strips the
// `timeout -k` wrapper macOS lacks.
//
//   pnpm exec tsx --test test/landing-facts.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { TicketRecord } from "../mod/hooks/run-record.ts";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { createLedger, describe } = await import("../src/ledger.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Landed = import("../src/landing.ts").Landed;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;
type TicketEnding = import("../src/ledger.ts").TicketEnding;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-facts-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
// main holds shared.txt; each branch is cut from that start and changes the files it is given.
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

const outcome = (root: string, id: string) => ({ issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${id}`) });

// The sandbox a merge that is not a fast-forward is made and gated in: a host worktree.
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

const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const failure = { name: "test", command: "test", exitCode: 1, output: "FAIL src/pair.test.ts\n" };
const RED: GateRun = { gates: [{ name: "test", pass: false }], failure, failures: [failure] };

/** One run's landing: what landOne writes itself, kept apart from what the ledger records of each ending. */
const harness = (root: string, over: { gate?: Ctx["gate"]; failClose?: boolean; body?: string } = {}) => {
  const byLanding: [string, TicketRecord][] = [];
  const byLedger: Record<string, TicketRecord> = {};
  const tracker = {
    ref: (id: string) => `#${id}`,
    get: () => ({ body: over.body ?? "" }),
    close: () => {
      if (over.failClose) throw new Error("HTTP 502");
    },
    hold: () => {},
  };
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: (id, fields) => void byLanding.push([id, fields]) },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: over.gate ?? (async () => GREEN),
    landed: new Map(),
  };
  const ledger = createLedger({
    run: { ticket: (id, fields) => void (byLedger[id] = { ...byLedger[id], ...fields }) },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: tracker.ref,
    say: () => {},
  });
  const land = async (id: string) => {
    const green = outcome(root, id);
    const landed = await landOne(ctx, green);
    ledger.record(id, { kind: "landing", green, landed, attempts: 1 });
    return landed;
  };
  return { land, byLanding, byLedger };
};

test("landOne writes only that a ticket is landing; the ledger records the conflict, with its files", async () => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n" } });
  const h = harness(root);
  assert.deepEqual(await h.land("1"), { kind: "merged" });
  assert.deepEqual(await h.land("2"), { kind: "conflict", files: ["shared.txt"], with: ["1"] });
  assert.deepEqual(h.byLanding, [
    ["1", { state: "landing" }],
    ["2", { state: "landing" }],
  ]);
  assert.deepEqual(h.byLedger["1"], { state: "merged", note: "merged and closed" });
  assert.deepEqual(h.byLedger["2"], { state: "conflict", note: "with #1: shared.txt", files: ["shared.txt"] });
});

test("a merged tree that is red returns its failing tests, and the ledger records them", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  // Each branch is green alone; together they never are.
  const together: Ctx["gate"] = async (box) => ((await box.exec("test -e a.txt && test -e b.txt")).exitCode === 0 ? RED : GREEN);
  const h = harness(root, { gate: together });
  await h.land("1");
  assert.deepEqual(await h.land("2"), { kind: "red", with: [], gates: ["test"], failing: ["src/pair.test.ts"] });
  assert.deepEqual(h.byLanding.filter(([id]) => id === "2"), [["2", { state: "landing" }]]);
  assert.deepEqual(h.byLedger["2"], { state: "red", note: "red on the merged tree (gate test; failing src/pair.test.ts)", failing: ["src/pair.test.ts"] });
});

test("a held branch, a failed close and a Touches overrun are facts landOne returns and the ledger records", async () => {
  const root = makeRepo({ 1: { ".github/workflows/ci.yml": "on: push\n" }, 2: { "src/a.ts": "a\n", "docs/x.md": "x\n" } });
  const h = harness(root, { failClose: true, body: "Touches: src/a.ts" });
  const held = await h.land("1");
  assert.equal(held.kind, "held");
  assert.deepEqual(h.byLedger["1"], { state: "held", note: "human merge: .github/workflows/ci.yml", files: [".github/workflows/ci.yml"] });
  assert.deepEqual(await h.land("2"), { kind: "close-failed", error: "HTTP 502", overrun: ["docs/x.md"] });
  assert.deepEqual(h.byLedger["2"], { state: "merged", note: "merged; closing the ticket failed", closeFailed: "HTTP 502", overrun: ["docs/x.md"] });
  assert.deepEqual(h.byLanding.map(([, f]) => f), [{ state: "landing" }, { state: "landing" }]);
});

test("landing.ts writes no ticket state but the landing stage, and keeps no requeue record", () => {
  const src = readFileSync(new URL("../src/landing.ts", import.meta.url), "utf8");
  assert.deepEqual(src.match(/\.ticket\([^)]*\)/g), ['.ticket(o.issue, { state: "landing" })']);
  assert.doesNotMatch(src, /createRequeueRecord|restoredRecord/);
});

// A requeued ticket's ending as the scheduler makes it when the second attempt never began: its first landing, attempts 1.
const green = { issue: "2", branch: "agent/issue-2", status: "green", commits: 1, repairs: 0, head: "abc1234" };
const first = (landed: Landed): TicketEnding => ({ kind: "landing", green, landed, attempts: 1 });
const REQUEUED = { base: "main", gateNames: "test", requeued: "requeued after conflict with #1" };

test("requeued, its second attempt never begun: the first landing stands and the record no longer promises a second", () => {
  const said = describe(first({ kind: "conflict", files: ["shared.txt"], with: ["1"] }), REQUEUED);
  assert.deepEqual(said.record, { state: "conflict", note: "with #1: shared.txt", files: ["shared.txt"], requeued: null });
  assert.equal(said.outcome?.text, "merge conflict: with #1: shared.txt");
});

test("requeued, then withdrawn before the second start: recorded as not started, its outcome withdrawn", () => {
  const said = describe(first({ kind: "withdrawn", reason: "closed during the run" }), REQUEUED);
  assert.deepEqual(said.record, { state: "withdrawn", note: "closed - not started", requeued: null });
  assert.deepEqual(said.outcome, { kind: "withdrawn", text: "withdrawn: closed during the run" });
});

test("a second attempt's landing keeps the line the status view shows it with", () => {
  const second: TicketEnding = { kind: "landing", green, landed: { kind: "merged" }, attempts: 2, again: { kind: "conflict", with: ["1"] } };
  assert.deepEqual(describe(second, REQUEUED).record, { state: "merged", note: "merged and closed" });
});

test("the ledger records a requeue as it is told, and drops a withdrawn ticket's first pipeline line", () => {
  const writes: [string, TicketRecord][] = [];
  const said: string[] = [];
  const dropped: string[] = [];
  const ledger = createLedger({
    run: { ticket: (id, fields) => void writes.push([id, fields]) },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: (id) => void dropped.push(id),
    ref: (id) => `#${id}`,
    say: (line) => void said.push(line),
  });
  ledger.tell({ kind: "requeued", id: "2", again: { kind: "conflict", with: ["1"] } });
  assert.deepEqual(writes, [["2", { state: "queued", note: "requeued after conflict with #1", requeued: "requeued after conflict with #1" }]]);
  assert.deepEqual(said, ["#2: requeued after conflict with #1; it is tried again in this run."]);
  assert.equal(ledger.requeuedAs.get("2"), "requeued after conflict with #1");
  ledger.tell({ kind: "ended", id: "2", ending: first({ kind: "withdrawn", reason: "closed during the run" }) });
  assert.deepEqual(writes.at(-1), ["2", { state: "withdrawn", note: "closed - not started", requeued: null }]);
  assert.deepEqual(dropped, ["2"]);
  assert.equal(ledger.requeuedAs.has("2"), false);
  // A ticket withdrawn at its first landing, never requeued, keeps its first pipeline's line.
  ledger.tell({ kind: "ended", id: "3", ending: { kind: "landing", green: { ...green, issue: "3" }, landed: { kind: "withdrawn", reason: "closed during the run" }, attempts: 1 } });
  assert.deepEqual(dropped, ["2"]);
  assert.deepEqual(writes.at(-1), ["3", { state: "withdrawn", note: "closed during the run" }]);
});
