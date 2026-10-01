// The closing summary's headline counts match its sections: "need you" is the
// Needs you section, "need fixing" is the Needs fixing section.
//
//   pnpm exec tsx --test test/report-headline.test.ts

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

// The body of one section: the lines between its heading and the next.
const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("conflicts are counted as needing fixing, never as needing you", () => {
  const out = render(
    facts({
      tickets: {
        "1": { state: "conflict", title: "a", note: "with #2: x.txt", files: ["x.txt"] },
        "2": { state: "conflict", title: "b", note: "with #1: x.txt", files: ["x.txt"] },
        "3": { state: "conflict", title: "c", note: "with #1: y.txt", files: ["y.txt"] },
      },
    }),
  );
  assert.match(out, /- 3 attempted - 0 merged - 0 need you - 3 need fixing -/);
  assert.equal(body(out, "## 🙋 Needs you").trim(), "none");
  const fixing = body(out, "## ❌ Needs fixing");
  for (const id of ["#1", "#2", "#3"]) assert.ok(fixing.includes(id), `${id} missing from Needs fixing`);
});

test("one held and one red ticket are counted separately", () => {
  const out = render(
    facts({
      tickets: {
        "1": { state: "held", title: "a", files: ["a.txt"] },
        "2": { state: "red", title: "b", note: "pytest red" },
      },
      changed: { "1": 1 },
    }),
  );
  assert.match(out, /- 1 need you - 1 need fixing -/);
});
