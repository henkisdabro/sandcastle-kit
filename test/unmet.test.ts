// An agent's <unmet> line: the acceptance criterion it knowingly left undone. How it is read
// (unmetOf), how a branch carrying one lands (merged as "part of" its ticket, the ticket left
// open, never closed and never found as "merged earlier"), how the ledger says it, how the closing
// summary lists it under Needs you, and that both prompts ask for it. Temp repos and a fake
// tracker: no Docker, no gh, no network.
//
//   pnpm exec tsx --test test/unmet.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { unmetOf } = await import("../src/burndown.ts");
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { accountLanding, createLedger } = await import("../src/ledger.ts");
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { render } = await import("../src/report.ts");
const { endSummary } = await import("../src/notify.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Facts = import("../src/report.ts").Facts;
type TicketRecord = import("../mod/hooks/run-record.ts").TicketRecord;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-unmet-"));
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

const UNMET = "the export module does not use the new rule";

const harness = (root: string, mode: "merge" | "squash" = "merge") => {
  const closed: string[] = [];
  const byLedger: Record<string, TicketRecord> = {};
  const tracker = {
    ref: (id: string) => `#${id}`,
    get: () => ({ body: "" }),
    close: (id: string) => void closed.push(id),
    hold: () => {},
  };
  const project = { root, name: "fixture", baseBranch: "main", land: mode, generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [{ name: "test", pass: true }], failures: [] }),
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
  const land = async (id: string, unmet?: string) => {
    const green = { issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${id}`), ...(unmet && { unmet }) };
    const landed = await landOne(ctx, green);
    ledger.record(id, { kind: "landing", green, landed, attempts: 1 });
    return landed;
  };
  const posted = () => [...ledger.entries.values()].flatMap(({ id, said }) => (said.tracker?.kind === "comment" ? [{ id, text: said.tracker.text }] : []));
  return { land, closed, byLedger, posted, ledger };
};

test("unmetOf reads one tag, the last of two, and one line out of many", () => {
  assert.equal(unmetOf("done.\n<unmet>skipped the export module</unmet>\n"), "skipped the export module");
  assert.equal(unmetOf("<unmet>first</unmet>\nthen\n<unmet>second</unmet>"), "second");
  assert.equal(unmetOf("<unmet>skipped\n   the export\tmodule</unmet>"), "skipped the export module");
});

test("unmetOf ignores the placeholder, an empty tag, no tag and an <ungated> line", () => {
  assert.equal(unmetOf("<unmet>...</unmet>"), undefined);
  assert.equal(unmetOf("<unmet>  </unmet>"), undefined);
  assert.equal(unmetOf("<ungated>open the page</ungated>"), undefined);
  assert.equal(unmetOf("all criteria met"), undefined);
});

test("a branch with an unmet criterion merges as part of its ticket and the ticket is not closed", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  const h = harness(root);
  const landed = await h.land("1", UNMET);
  assert.deepEqual(landed, { kind: "partly-done", unmet: UNMET });
  assert.deepEqual(h.closed, []);
  assert.equal(git(root, "log", "main", "-1", "--format=%s"), "Merge agent/issue-1 (part of #1)");
  // The work is on the base, and its branch is gone: it merged.
  assert.equal(git(root, "show", "main:a.txt"), "a");
  assert.equal(git(root, "branch", "--list", "agent/issue-1"), "");
  // Never found as "merged earlier": the next run does the remainder instead of closing the ticket.
  assert.equal(git(root, "log", "main", "-1", "--format=%h", "--fixed-strings", "--grep=Merge agent/issue-1 (closes #1)"), "");
});

test("a branch merged in a sandbox, or squashed, is also part of its ticket", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const h = harness(root);
  await h.land("1");
  assert.deepEqual(await h.land("2", UNMET), { kind: "partly-done", unmet: UNMET });
  assert.deepEqual(h.closed, ["1"]);
  assert.equal(git(root, "log", "main", "-1", "--format=%s"), "Merge agent/issue-2 (part of #2)");

  const squashed = makeRepo({ 3: { "c.txt": "c\n" } });
  const s = harness(squashed, "squash");
  assert.deepEqual(await s.land("3", UNMET), { kind: "partly-done", unmet: UNMET, squashed: true });
  assert.equal(git(squashed, "log", "main", "-1", "--format=%s"), "Merge agent/issue-3 (part of #3)");
});

test("without an unmet criterion the merge closes the ticket as before", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  const h = harness(root);
  assert.deepEqual(await h.land("1"), { kind: "merged" });
  assert.deepEqual(h.closed, ["1"]);
  assert.equal(git(root, "log", "main", "-1", "--format=%s"), "Merge agent/issue-1 (closes #1)");
});

test("the ledger records it merged with the criterion, counts it merged, and words the one comment", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  const h = harness(root);
  await h.land("1", UNMET);
  assert.deepEqual(h.byLedger["1"], { state: "merged", note: "merged; ticket left open (a criterion is unmet)", unmet: UNMET });
  assert.deepEqual(accountLanding(h.ledger.entries.values()).merged, ["1"]);
  const [comment] = h.posted();
  assert.match(comment.text, /Left open: an acceptance criterion is unmet\.\*\* the export module does not use the new rule/);
  assert.match(comment.text, /The next run picks up the remainder\./);
  assert.match(comment.text, /Merged locally, not yet pushed/);
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});
const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("the closing summary lists a partly done ticket under Needs you, once, and not as closed", () => {
  const out = render(
    facts({
      tickets: {
        "3": { state: "merged", title: "Adopt the rule", unmet: UNMET, note: "merged; ticket left open (a criterion is unmet)" },
        "4": { state: "merged", title: "Other" },
      },
    }),
    true,
  );
  const needs = body(out, "## Needs you");
  assert.match(needs, new RegExp(`#3 Adopt the rule - merged, partly done: ${UNMET} - the ticket is still open`));
  assert.equal(needs.split("\n").filter((l) => l.includes("#3")).length, 1);
  assert.doesNotMatch(needs, /#4/);
  const done = body(out, "## Done");
  assert.match(done, /1 merged and closed on GitHub: #4/);
  assert.match(done, /1 merged, partly done, and left open in the tracker: #3/);
  assert.match(out, / - 2 merged - 1 need you - /);
  assert.match(body(out, "## Next step"), /#3 \(merged, partly done, ticket open\)/);
});

test("a partly done ticket counts as needing you in the closing notification", () => {
  const run = { tickets: { "1": { state: "merged" }, "2": { state: "merged", unmet: UNMET } } } as unknown as Parameters<typeof endSummary>[0];
  assert.match(endSummary(run), /2 merged, 1 need you/);
});

test("both prompts put criteria and a branch's regressions in scope, and ask for the <unmet> line", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-unmet-prompts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project: Project = {
    root,
    name: "unmet-test",
    baseBranch: "main",
    label: "ready-for-agent",
    concurrency: 1,
    mounts: [],
    setup: [],
    lean: { keep: [], dropHooks: [] },
    gates: [{ name: "unit", command: "echo gate-ok" }],
    hookTests: [],
    land: "merge",
    generated: [],
    implement: {},
    review: {},
    repair: {},
    tracker: fakeTracker(),
  };
  const paths = renderPrompts(project, makeTracker(project));
  for (const file of [paths.implement, paths.review, paths.rereview]) {
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("<unmet>...</unmet>"), file);
    assert.ok(!text.includes("{{KIT_"), file);
  }
  const implement = readFileSync(paths.implement, "utf8");
  assert.match(implement, /Every acceptance criterion the ticket lists is in scope/);
  assert.match(implement, /a regression your change causes/);
  assert.match(readFileSync(paths.review, "utf8"), /every one is in scope, and so\s+is a regression this branch causes/);
});
