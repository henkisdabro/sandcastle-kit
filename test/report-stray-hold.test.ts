// A branch held for its conflict resolution's stray edits says so under Needs you, in the note's own
// words, and not as "changes <files>", which is how a protected-path hold reads.
//
//   pnpm exec tsx --test test/report-stray-hold.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";
import { strayNote } from "../src/resolution.ts";

const facts = (tickets: Facts["tickets"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:45:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets,
  runnable: [],
  blocked: [],
  standing: ["agent/issue-1", "agent/issue-2"],
  keptWorktrees: [],
  changed: { "1": 2, "2": 1 },
});

const section = (text: string, heading: string) => text.split(heading)[1]?.split("\n## ")[0] ?? "";

test("a stray hold prints its note, and a protected-path hold still prints the files", () => {
  const note = strayNote(["test/a.test.ts"]);
  const out = render(
    facts({
      "1": { state: "held", title: "stray", note },
      "2": { state: "held", title: "protected", note: "changes how the repo executes", files: [".githooks/pre-push"] },
    }),
    true,
  );
  const needs = section(out, "## Needs you");
  assert.match(needs, /- #1 stray - conflict resolution changed test\/a\.test\.ts, which merged cleanly - check no other ticket's lines were lost - 2 file\(s\)\n/);
  assert.doesNotMatch(needs, /#1 stray - changes /);
  assert.match(needs, /- #2 protected - changes \.githooks\/pre-push - 1 file\(s\)\n/);
});
