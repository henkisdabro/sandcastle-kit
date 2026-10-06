// A finished ticket whose commit was refused (a git hook, a full disk, a signing failure)
// ends with no commits and a kept worktree. It must read as uncommitted work - not as
// "nothing to change", and not as a hand-back to redo.
//
//   node --test test/uncommitted-work.test.ts

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { rerunnable } from "../src/autonomy.ts";
import { keptFor, keptPath } from "../src/burndown.ts";
import { describe } from "../src/ledger.ts";
import { type Facts, render } from "../src/report.ts";

// Built with node:path, so the test holds on a path with backslashes as well as slashes.
const root = join("/", "work", "project");
const kept = join(root, ".sandcastle", "worktrees", "agent-issue-7");
const none = { issue: "7", status: "nochange" as const, commits: 0 };

/**
 * The state a pipeline that added no commits ends on: the ledger's, from its ending, described with
 * the ticket's kept worktree (as burndown's context names it) and whether it has a hold note.
 */
const noCommitRecord = (o: typeof none, kept: { issue: string; path: string }[], root: string, holdNote: boolean) => {
  const k = kept.find((w) => w.issue === o.issue);
  const ending = { kind: "pipeline" as const, outcome: { ...o, branch: `agent/issue-${o.issue}`, repairs: 0, gates: [] }, attempts: 1 as const };
  return describe(ending, { base: "main", gateNames: "test", ...(k && { kept: keptPath(root, k.path) }), ...(holdNote && { hold: "note" as const }) }).record!;
};

test("0 commits and a kept worktree: uncommitted, with the worktree named", () => {
  const record = noCommitRecord(none, [{ issue: "7", path: kept }], root, false);
  assert.equal(record.state, "uncommitted");
  assert.equal(record.note, "work left uncommitted in .sandcastle/worktrees/agent-issue-7");
});

test("0 commits and no kept worktree: nothing to change; another ticket's worktree does not count", () => {
  assert.deepEqual(noCommitRecord(none, [], root, false), { state: "nochange", note: "nothing to change" });
  assert.equal(noCommitRecord(none, [{ issue: "8", path: kept }], root, false).state, "nochange");
});

test("a hand-back with a kept worktree is uncommitted, not held; without one, held", () => {
  assert.equal(noCommitRecord(none, [{ issue: "7", path: kept }], root, true).state, "uncommitted");
  assert.deepEqual(noCommitRecord(none, [], root, true), { state: "held", note: "handed back - for a human" });
});

test("a pipeline that committed is not uncommitted work, whatever else is kept", () => {
  assert.equal(keptFor({ issue: "7", status: "green", commits: 2 }, [{ issue: "7", path: kept }]), undefined);
  assert.equal(keptFor({ issue: "7", status: "nochange", commits: 1 }, [{ issue: "7", path: kept }]), undefined);
});

test("a kept worktree outside the project is named as it is", () => {
  const away = join("/", "elsewhere", "wt");
  assert.equal(noCommitRecord(none, [{ issue: "7", path: away }], root, false).note, `work left uncommitted in ${away}`);
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
  tickets: {
    "7": { state: "uncommitted", title: "the work", note: "work left uncommitted in .sandcastle/worktrees/agent-issue-7" },
    "9": { state: "held", title: "a question", note: "handed back - for a human" },
  },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [{ issue: "7", path: ".sandcastle/worktrees/agent-issue-7" }],
  changed: { "9": 0 },
  ...over,
});

const section = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("the closing summary: Needs-you line, and the Next step names it first", () => {
  const out = render(facts(), true);
  const needs = section(out, "## Needs you");
  assert.match(
    needs,
    /- #7 the work - finished but not committed - the work is in \.sandcastle\/worktrees\/agent-issue-7\. Fix what refused the commit \(the agent's comment says\), then `sandcastle requeue <ticket>`: the next run reuses that worktree\. Or commit it there yourself\./,
  );
  assert.doesNotMatch(needs.split("\n").find((l) => l.includes("#7"))!, /no commits|do it yourself and close/);
  const next = section(out, "## Next step").split("\n").filter(Boolean);
  assert.match(next[0], /^1\. .*#7/);
  assert.match(out, / 2 need you /);
  // Not "nothing to change", and the hand-back keeps its own line.
  assert.doesNotMatch(section(out, "## Done"), /Nothing to change/);
  assert.match(needs, /#9 a question - handed back - for a human, no commits/);
});

test("a further turn does not take an uncommitted ticket", () => {
  assert.deepEqual(rerunnable(facts()), { conflicted: [], unblocked: [], partial: [] });
});
