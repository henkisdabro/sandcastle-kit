// The closing summary's next step for a conflicted or red ticket: these keep
// their queue label, so it must say the next run resumes the branch and not
// send the operator to a "requeue" step that does not exist.
//
//   node --test test/report-next-step.test.ts

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

// The body of one section: the lines between its heading and the next.
const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("a conflicted and a red ticket: the next step says still queued, resumes the branch, merges by hand", () => {
  const out = render(
    facts({
      tickets: {
        "101": { state: "conflict", title: "a", note: "conflicts in src/a.ts", files: ["src/a.ts"] },
        "102": { state: "red", title: "b", note: "pytest red", failing: ["tests/test_b.py::test_other"], files: ["src/b.ts"] },
      },
      standing: ["agent/issue-101", "agent/issue-102"],
    }),
  );
  const next = body(out, "## 👉 Next step");
  assert.match(next, /Look at #101 #102: /);
  assert.match(
    next,
    /still queued - add a comment for the implementer if it helps, and the next `sandcastle run` resumes its branch; or fix the branch yourself and land it: `sandcastle land <n>`/,
  );
  assert.doesNotMatch(next, /git merge/);
  assert.doesNotMatch(next, /requeue the issue with a note/);
});

test("one conflicted ticket's land command names it", () => {
  const next = body(render(facts({ tickets: { "49": { state: "conflict", title: "snake", note: "with #48: src/text.js", files: ["src/text.js"] } }, standing: ["agent/issue-49"] })), "## 👉 Next step");
  assert.match(next, /`sandcastle land 49`/);
});
