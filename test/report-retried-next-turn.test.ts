// A ticket the next turn of the autonomy loop runs again by itself is not "Needs fixing" for a person:
// the closing summary of a turn the loop follows leaves it out of the count, the groups and the advice,
// and lists it apart with the turn that runs it. Made-up facts; no Docker, model or network.
//
//   pnpm test:file test/report-retried-next-turn.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");
type Facts = Parameters<typeof render>[0];

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: { green: true, line: "ok" },
  gateCount: 1,
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

const next = { level: "drain" as const, turn: 2, tickets: ["7"] };
const timeout = () => ({ "7": { state: "not landed" as const, note: "gh issue view failed" }, "8": { state: "merged" as const } });

test("a not-landed ticket the next turn re-runs is not counted as needing a fix", () => {
  const out = render(facts({ tickets: timeout(), next }), true);
  assert.match(out, /0 need fixing/);
  assert.match(body(out, "## Needs fixing"), /not landed: gh issue view failed - turn 2 runs it again by itself/);
});

test("a conflicted ticket the next turn re-runs says so in its own word", () => {
  const out = render(facts({ tickets: { "9": { state: "conflict", note: "a.txt with #3" } }, next: { ...next, tickets: ["9"] } }), true);
  assert.match(body(out, "## Needs fixing"), /merge conflict: a\.txt with #3 - turn 2 runs it again by itself/);
  assert.match(out, /0 need fixing/);
});

test("a re-run ticket does not join a shared-test group with a ticket that needs a fix", () => {
  const failing = ["test/a.test.ts > x"];
  const out = render(
    facts({ tickets: { "7": { state: "not landed", note: "x", failing }, "10": { state: "red", note: "red", failing } }, next }),
    true,
  );
  const section = body(out, "## Needs fixing");
  assert.doesNotMatch(section, /Same failing test/);
  assert.match(section, /#10 .*gate red/);
  assert.match(out, /1 need fixing/);
});

test("without a next turn (operatorSteps) the ticket is back under Needs fixing with its advice", () => {
  const out = render(facts({ tickets: timeout() }), true);
  assert.match(out, /1 need fixing/);
  assert.match(body(out, "## Next step"), /Look at #7/);
  assert.doesNotMatch(out, /runs it again by itself/);
});
