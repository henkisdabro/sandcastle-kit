// The overrun of a branch against its `Touches:` line leaves out what only a repair pass or a conflict
// resolution changed, and a note whose overrun is only test and docs files is not printed (the run
// record keeps the paths). Temp repos and made-up records: no Docker, no gh, no network.
//
//   pnpm exec tsx --test test/overrun-repair-resolve.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { createHostGit, landOne, touchesOverrun } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { recordHead } = await import("../src/run.ts");
const { describe } = await import("../src/ledger.ts");
const { overrunNoted, render } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-overrun-repair-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};
const commit = (root: string, files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
};
// main holds src/a.ts and src/b.ts; `agent/issue-1` is checked out, forked from it.
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  commit(root, { "src/a.ts": "a\n", "src/b.ts": "b\n" }, "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  return root;
};
const overrun = (root: string, repaired: string[] = []) =>
  touchesOverrun(root, "main", git(root, "rev-parse", "agent/issue-1"), "Touches: src/a.ts", new Set(repaired));

test("a file only a repair commit changed is left out; one the implementation changed too stays", () => {
  const root = makeRepo();
  commit(root, { "src/a.ts": "a2\n", "src/own.ts": "o\n" }, "implement");
  const fix = commit(root, { "src/flaky.ts": "f\n", "src/own.ts": "o2\n" }, "repair");
  assert.deepEqual(overrun(root).sort(), ["src/flaky.ts", "src/own.ts"], "without the record every file counts, as before");
  assert.deepEqual(overrun(root, [fix]), ["src/own.ts"]);
});

test("a repair's changes alone leave no overrun", () => {
  const root = makeRepo();
  commit(root, { "src/a.ts": "a2\n" }, "implement");
  const fix = commit(root, { "src/flaky.ts": "f\n", "test/flaky.test.ts": "t\n" }, "repair");
  assert.deepEqual(overrun(root, [fix]), []);
});

test("a file only a conflict resolution changed is left out", () => {
  const root = makeRepo();
  commit(root, { "src/a.ts": "a2\n" }, "implement");
  git(root, "checkout", "-q", "main");
  commit(root, { "src/b.ts": "b2\n" }, "main moves");
  git(root, "checkout", "-q", "agent/issue-1");
  git(root, "merge", "--no-commit", "--no-ff", "main");
  write(root, "src/glue.ts", "g\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Merge main into agent/issue-1");
  assert.deepEqual(overrun(root), []);
});

test("overrunNoted: only an overrun with a source file is worth a note", () => {
  assert.ok(overrunNoted(["src/a.ts", "test/a.test.ts"]));
  assert.ok(!overrunNoted(["test/a.test.ts", "README.md", "docs/x.md"]));
  assert.ok(!overrunNoted([]));
  assert.ok(!overrunNoted(undefined));
});

test("an overrun of tests and docs stays in the record but is neither in the close comment nor the report", () => {
  const paths = ["test/a.test.ts", "test/b.test.ts", "docs/x.md"];
  const green = { issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0 };
  const ending = (overrun: string[]) =>
    describe({ kind: "landing", green, landed: { kind: "merged", overrun }, attempts: 1 }, { base: "main", gateNames: "test" });
  const quiet = ending(paths);
  assert.deepEqual(quiet.record?.overrun, paths);
  assert.ok(!quiet.tracker?.text.includes("Touches"), quiet.tracker?.text);
  assert.ok(ending(["src/x.ts", ...paths]).tracker?.text.includes("changed beyond its Touches line: src/x.ts, +2 test files, +1 docs file"));

  const facts = (overrun: string[]) =>
    ({
      base: "main", tracker: "github", started: "2026-10-02T10:00:00Z", finished: "2026-10-02T10:30:00Z", live: false, dryRun: false,
      gateCount: 1, tickets: { "1": { state: "merged", title: "t", overrun } },
      runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, stage: "report", exitCode: 0,
    }) as unknown as Facts;
  assert.ok(!render(facts(paths), true).includes("beyond Touches"));
  assert.ok(render(facts(["src/x.ts", ...paths]), true).includes("#1 t - beyond Touches: src/x.ts, +2 test files, +1 docs file"));
});

test("landing reads the repair commits from the ticket's head record", async () => {
  const root = makeRepo();
  commit(root, { "src/a.ts": "a2\n" }, "implement");
  const fix = commit(root, { "src/flaky.ts": "f\n" }, "repair");
  git(root, "checkout", "-q", "main");
  recordHead(root, "1", { branch: "agent/issue-1", repaired: [fix] }, "run");
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const tracker = {
    ref: (id: string) => `#${id}`,
    get: () => ({ id: "1", title: "t", body: "Touches: src/a.ts", comments: [], open: true, held: false }),
    close: () => undefined,
  };
  const ctx: Ctx = {
    project, tracker: tracker as unknown as Ctx["tracker"], base: "main", gateNames: "test", reports: new Map(),
    run: { ticket: () => undefined }, dryRun: false,
    opener: (() => { throw new Error("no sandbox needed"); }) as unknown as Ctx["opener"],
    withdrawal: () => undefined, host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [], failures: [] }), landed: new Map(),
  };
  const outcome = { issue: "1", branch: "agent/issue-1", status: "green", commits: 2, repairs: 1, head: git(root, "rev-parse", "agent/issue-1") };
  assert.deepEqual(await landOne(ctx, outcome), { kind: "merged" });
});
