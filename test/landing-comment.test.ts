// The comment a ticket gets when it did not land: the conflict, the agents'
// report, or both in one.
//
//   pnpm test:file test/landing-comment.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { notLandedComment } from "../src/burndown.ts";

const conflict = (over: Partial<{ files: string[]; with: string[] }> = {}) => ({
  branch: "agent/issue-7",
  base: "main",
  files: ["a.ts", "b.ts"],
  with: ["12"],
  ...over,
});

test("a report alone keeps today's exact text", () => {
  assert.equal(notLandedComment("It went red.", undefined), "Sandcastle ran this ticket and did not land it. What the agents reported:\n\nIt went red.");
});

test("a conflict alone names the branch, base, other ticket and files", () => {
  const text = notLandedComment(undefined, conflict())!;
  for (const part of ["agent/issue-7", "main", "with #12", "a.ts, b.ts"]) assert.ok(text.includes(part), part);
  assert.ok(!text.includes("What the agents reported"));
});

test("a conflict and a report make one comment", () => {
  const text = notLandedComment("Tests were green.", conflict())!;
  assert.ok(text.includes("conflicted (with #12: a.ts, b.ts)"));
  assert.ok(text.endsWith("\n\nWhat the agents reported:\n\nTests were green."));
});

test("neither is no comment", () => {
  assert.equal(notLandedComment(undefined, undefined), undefined);
});

test("five files list three and count the rest", () => {
  const text = notLandedComment(undefined, conflict({ files: ["a", "b", "c", "d", "e"] }))!;
  assert.ok(text.includes("a, b, c and 2 more"));
});
