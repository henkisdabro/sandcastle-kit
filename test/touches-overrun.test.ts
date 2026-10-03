// A diff that leaves its ticket's `Touches:` line: named in run.json and in the close comment as a
// warning, never a hold. landOne returns it with the merge, and the ledger records it. Temp repos and a
// fake tracker: no Docker, no gh, no network.
//
//   pnpm exec tsx --test test/touches-overrun.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { createHostGit, landOne, touchesOverrun } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { describe } = await import("../src/ledger.ts");
const { render } = await import("../src/report.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;
type Facts = import("../src/report.ts").Facts;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-touches-overrun-"));
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
};
// main holds src/a.ts and src/b.ts; `agent/issue-1` forks from it and commits `files`.
const makeRepo = (files: Record<string, string>) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  commit(root, { "src/a.ts": "a\n", "src/b.ts": "b\n" }, "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  commit(root, files, "work");
  git(root, "checkout", "-q", "main");
  return root;
};
const overrun = (root: string, body: string) => touchesOverrun(root, "main", git(root, "rev-parse", "agent/issue-1"), body);

test("a change the line declares gives no warning", () => {
  const root = makeRepo({ "src/a.ts": "a2\n" });
  assert.deepEqual(overrun(root, "Touches: src/a.ts"), []);
});

test("an extra file is named", () => {
  const root = makeRepo({ "src/a.ts": "a2\n", "src/other.ts": "x\n", "docs/notes.md": "y\n" });
  assert.deepEqual(overrun(root, "Do it.\n\nTouches: src/a.ts\n").sort(), ["docs/notes.md", "src/other.ts"]);
});

test("a directory, and a glob, cover a new file", () => {
  const root = makeRepo({ "src/new.ts": "n\n", "src/deep/er.ts": "e\n" });
  assert.deepEqual(overrun(root, "Touches: src/"), []);
  assert.deepEqual(overrun(root, "Touches: src/*.ts"), ["src/deep/er.ts"]);
  assert.deepEqual(overrun(root, "Touches: src/**/*.ts"), []);
});

test("a file the branch deleted is covered by a glob that matches it on the base", () => {
  const root = makeRepo({ "src/a.ts": "a2\n" });
  git(root, "checkout", "-q", "agent/issue-1");
  git(root, "rm", "-q", "src/b.ts");
  git(root, "commit", "-q", "-m", "drop b");
  git(root, "checkout", "-q", "main");
  assert.deepEqual(overrun(root, "Touches: src/*.ts"), []);
  assert.deepEqual(overrun(root, "Touches: src/a.ts"), ["src/b.ts"]);
});

test("a ticket with no Touches line is skipped silently", () => {
  const root = makeRepo({ "src/other.ts": "x\n" });
  assert.deepEqual(overrun(root, "Just a body."), []);
  assert.deepEqual(overrun(root, "```\nTouches: src/a.ts\n```"), []);
});

const harness = (root: string, body: string) => {
  const comments: string[] = [];
  const states: Record<string, Record<string, unknown>> = {};
  const tracker = {
    ref: (id: string) => `#${id}`,
    get: () => ({ id: "1", title: "t", body, comments: [], open: true, held: false }),
    close: (_id: string, text: string) => void comments.push(text),
    hold: () => {
      throw new Error("an overrun must not hold");
    },
  };
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: (id, fields) => void (states[id] = { ...states[id], ...fields }) },
    dryRun: false,
    opener: (() => {
      throw new Error("no sandbox needed");
    }) as unknown as Ctx["opener"],
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [], failures: [] }),
    landed: new Map(),
  };
  const head = git(root, "rev-parse", "agent/issue-1");
  return { ctx, comments, states, outcome: { issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0, head } };
};

test("landing still merges, records the overrun and says it in the close comment", async () => {
  const root = makeRepo({ "src/a.ts": "a2\n", "src/other.ts": "x\n" });
  const { ctx, comments, states, outcome } = harness(root, "Touches: src/a.ts");
  const landed = await landOne(ctx, outcome);
  assert.deepEqual(landed, { kind: "merged", overrun: ["src/other.ts"] });
  // The record the ledger writes of the merge.
  const record = describe({ kind: "landing", green: outcome, landed, attempts: 1 }, { base: "main", gateNames: "test" }).record;
  assert.deepEqual(record, { state: "merged", note: "merged and closed", overrun: ["src/other.ts"] });
  assert.equal(states["1"].overrun, undefined, "landOne writes no verdict, nor the facts that go with it");
  assert.equal(comments.length, 1);
  assert.ok(comments[0].includes("\n\nchanged beyond its Touches line: src/other.ts"), comments[0]);
  assert.equal(git(root, "show", "main:src/other.ts"), "x");
});

test("a declared change lands with no overrun and no extra line", async () => {
  const root = makeRepo({ "src/a.ts": "a2\n" });
  const { ctx, comments, states, outcome } = harness(root, "Touches: src/a.ts");
  const landed = await landOne(ctx, outcome);
  assert.deepEqual(landed, { kind: "merged" });
  assert.equal(describe({ kind: "landing", green: outcome, landed, attempts: 1 }, { base: "main", gateNames: "test" }).record?.overrun, undefined);
  assert.ok(!comments[0].includes("Touches"), comments[0]);
});

test("the closing report carries the line for a merged ticket", () => {
  const facts = {
    base: "main", tracker: "github", started: "2026-10-02T10:00:00Z", finished: "2026-10-02T10:30:00Z", live: false, dryRun: false,
    gateCount: 1, tickets: { "1": { state: "merged", title: "t", overrun: ["src/other.ts", "docs/x.md"] }, "2": { state: "merged", title: "u" } },
    runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, stage: "report", exitCode: 0,
  } as unknown as Facts;
  const text = render(facts, true);
  assert.ok(text.includes("#1 t changed beyond its Touches line: src/other.ts, docs/x.md"), text);
  assert.equal(text.split("changed beyond its Touches line").length, 2);
});
