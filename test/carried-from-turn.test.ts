// A carried branch's lines name the turn of this run it came from (a head record written by an earlier
// turn), not "an earlier run". The turn is found through history.jsonl: the lines of the same pid and
// orchestrator whose `settings.turn` counts down from this turn. Temp files only: no Docker, no network.
//
//   pnpm test:file test/carried-from-turn.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { carriedBranch, carriedMergeLine, greenCarriedLine, reviewedCarriedLine } = await import("../src/landing.ts");
const { turnOfHead } = await import("../src/report.ts");

test("a branch from an earlier turn names the turn", () => {
  assert.equal(
    greenCarriedLine("#140", "16bf062abc", { turn: 1 }),
    "#140: reviewed and green at 16bf062 in turn 1 - no implement or full review; the gates decide.",
  );
  assert.equal(
    reviewedCarriedLine("#140", "16bf062abc", { turn: 2 }),
    "#140: reviewed at 16bf062 in turn 2, no gate result since - no implement or full review; the gates decide.",
  );
  assert.equal(carriedMergeLine("#140", "main", 2, { turn: 1 }), "#140: merged main (2 commit(s)) into its branch from turn 1.");
  assert.equal(carriedBranch(false, { turn: 3 }), "its branch from turn 3");
});

test("a boolean source reads as before", () => {
  assert.equal(carriedMergeLine("#140", "main", 2, true), "#140: merged main (2 commit(s)) into its branch from its first attempt.");
  assert.equal(carriedMergeLine("#140", "main", 2, false), "#140: merged main (2 commit(s)) into its branch from an earlier run.");
});

const S0 = "2026-01-01T00:00:00.000Z";
const S1 = "2026-02-01T00:00:00.000Z";
const S2 = "2026-02-01T01:00:00.000Z";
const S3 = "2026-02-01T02:00:00.000Z";

test("the turn a head record came from is found in history, and an older run's is none", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const line = (startedAt: string, turn: number, pid = 50) => JSON.stringify({ startedAt, pid, orchestrator: "sandcastle-kit", settings: { turn } });
  writeFileSync(join(root, ".sandcastle/logs/history.jsonl"), [line(S0, 1), line(S1, 1), line(S2, 2)].join("\n") + "\n");
  const current = { startedAt: S3, pid: 50, orchestrator: "sandcastle-kit", settings: { turn: 3 } };
  assert.equal(turnOfHead(root, current, S1), 1);
  assert.equal(turnOfHead(root, current, S2), 2);
  assert.equal(turnOfHead(root, current, S0), undefined);
  assert.equal(turnOfHead(root, current, undefined), undefined);
});

test("burndown hands the turn lookup to the carried branch's lines", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /const from: From = requeued \|\| \(headTurn === undefined \? false : \{ turn: headTurn \}\)/);
  assert.match(source, /greenHead, from, lateComment/);
  assert.match(source, /carriedMergeLine\(ref\(issue\.id\), base, behind, from\)/);
  assert.doesNotMatch(source, /carried(MergeLine|Branch)\([^)]*requeued/);
});
