// The closing summary's Next step for a merged ticket's kept worktree: it holds the branch the landing
// could not delete, and only `sandcastle clean` removes it. Every other kept worktree has a step of its
// own or holds work `clean` would delete, so none of those is sent there.
//
//   pnpm test:file test/report-kept-worktree-step.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "97.5M in / 725k out",
  verify: { green: true, line: "ruff=pass pytest=pass" },
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
const nextStep = (f: Facts) => body(render(f), "## 👉 Next step");

const wt7 = ".sandcastle/worktrees/agent-issue-7";
const mergedTicket = { state: "merged", title: "a" } as const;

test("a merged ticket's kept worktree and no standing branch: the next step names the ticket, the path and sandcastle clean", () => {
  const next = nextStep(facts({ tickets: { "7": { ...mergedTicket } }, keptWorktrees: [{ issue: "7", path: wt7 }] }));
  assert.match(next, /Look at the files left in the kept worktree of #7 \(`\.sandcastle\/worktrees\/agent-issue-7`\): its work is merged\./);
  assert.match(next, /Then `sandcastle clean` removes it and the branch it holds and archives its logs - and removes every other kept worktree too, so do the steps above first\./);
});

test("the same worktree path listed twice is named once", () => {
  const next = nextStep(facts({ tickets: { "7": { ...mergedTicket } }, keptWorktrees: [{ issue: "7", path: wt7 }, { issue: "7", path: wt7 }] }));
  assert.equal(next.split(wt7).length - 1, 1);
});

test("two merged tickets' kept worktrees are one step naming each", () => {
  const wt8 = ".sandcastle/worktrees/agent-issue-8";
  const next = nextStep(facts({ tickets: { "7": { ...mergedTicket }, "8": { ...mergedTicket } }, keptWorktrees: [{ issue: "7", path: wt7 }, { issue: "8", path: wt8 }] }));
  assert.equal(next.split("sandcastle clean").length - 1, 1);
  assert.ok(next.includes(wt7) && next.includes(wt8));
});

test("a merged ticket's kept worktree and a standing branch: one clean line naming both", () => {
  const next = nextStep(
    facts({
      tickets: { "7": { ...mergedTicket }, "9": { state: "conflict", title: "b", note: "conflicts in src/a.ts", files: ["src/a.ts"] } },
      standing: ["agent/issue-9"],
      keptWorktrees: [{ issue: "7", path: wt7 }],
    }),
  );
  assert.equal(next.split("`sandcastle clean`").length - 1, 1);
  assert.match(next, /`sandcastle clean` once the branches above are resolved and you have looked at the files left in the kept worktree of #7 \(`\.sandcastle\/worktrees\/agent-issue-7`\)\./);
});

test("an uncommitted ticket's kept worktree: its commit step and no sandcastle clean", () => {
  const next = nextStep(facts({ tickets: { "7": { state: "uncommitted", title: "a", note: `work left uncommitted in ${wt7}` } }, keptWorktrees: [{ issue: "7", path: wt7 }] }));
  assert.match(next, /Commit the finished work of #7/);
  assert.doesNotMatch(next, /sandcastle clean/);
});

test("a crashed ticket's kept worktree with no standing branch: no sandcastle clean", () => {
  const next = nextStep(facts({ tickets: { "7": { state: "crashed", title: "a", note: "agent crashed" } }, keptWorktrees: [{ issue: "7", path: wt7 }] }));
  assert.doesNotMatch(next, /sandcastle clean/);
});

test("a merged ticket's kept worktree on a red base: no clean step", () => {
  const next = nextStep(
    facts({
      stage: "base gates",
      exitCode: 1,
      tickets: { "7": { ...mergedTicket } },
      keptWorktrees: [{ issue: "7", path: wt7 }],
      baseRed: ["tests/test_x.py::test_y"],
    }),
  );
  assert.doesNotMatch(next, /sandcastle clean/);
});
