// The estimate prices a carried branch (one ahead of the base, often conflicting with it) apart from a
// fresh ticket, prints a median-to-80th-percentile range, and counts a chain's own tickets' times
// (src/run.ts `estimate`, `isCarried`). The first test is the run that was priced at half its cost: ten
// mostly carried tickets, 18.8M tokens in / 179k out and 43 minutes against 9.2M / 133k and 19m. Made-up
// timings and a temp git repo; no tracker, Docker or network.
//
//   pnpm test:file test/estimate-carried.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate, isCarried } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tok = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output });
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

/** A fresh ticket: `minutes` in one implement step. */
const fresh = (issue: number, minutes: number, input: number, output: number) => [line({ issue: String(issue), phase: "implement", ms: minutes * MIN, tokens: tok(input, output) })];
/** A carried ticket: its lines say `carried`, as the run writes them for a branch ahead of the base at the start. */
const carried = (issue: number, minutes: number, input: number, output: number) => [
  line({ issue: String(issue), phase: "resolve", ms: 2 * MIN, carried: true, tokens: tok(0, 0) }),
  line({ issue: String(issue), phase: "implement", ms: (minutes - 2) * MIN, carried: true, tokens: tok(input, output) }),
];

const project = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-carried-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

/** The two ends of a range such as "9.2M to 14.0M" or "19m" (a lone figure is both), in tokens or minutes. */
const parse = (text: string): [number, number] => {
  const figures = [...text.matchAll(/(\d+(?:\.\d+)?)([kM]?)/g)].map((m) => Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1));
  return [figures[0], figures[figures.length - 1]];
};

test("a run of carried branches, history of one large carried ticket: the high end is within 2x of the real cost", () => {
  // One large carried ticket in the history, and the small fresh ones that used to set the median.
  const p = project([...fresh(1, 2, 900_000, 13_000), ...fresh(2, 2, 900_000, 13_000), ...carried(3, 6, 1_900_000, 18_000)]);
  const ten = Array.from({ length: 10 }, () => true);
  const text = estimate(p, 10, 4, 5, undefined, { carried: ten, chainAt: [0, 1, 2, 3, 4] })!;
  assert.match(text, /\(10 carried, 0 fresh\)/);
  const [, inHigh] = parse(text.match(/about (.*?) tokens in/)![1]);
  const [, outHigh] = parse(text.match(/in \/ (.*?) out/)![1]);
  const [, minHigh] = parse(text.match(/and (.*?) for/)![1]);
  const real = { inTokens: 18_800_000, out: 179_000, minutes: 43 };
  for (const [high, truth] of [[inHigh, real.inTokens], [outHigh, real.out], [minHigh, real.minutes]]) {
    assert.ok(high >= truth / 2 && high <= truth * 2, `${high} is not within 2x of ${truth}: ${text}`);
  }
  // The five-ticket chain is 5 x 6m = 30m, longer than the 10 tickets' 6m each over 4 slots (15m).
  assert.match(text, /and 30m for 10 ticket\(s\) \(10 carried, 0 fresh\), 4 at a time \(5 tickets in sequence\)\.(?: No history at .*)?$/);
  // The same history priced as fresh tickets, as before: about half the real tokens, outside 2x.
  const [, asFresh] = parse(estimate(p, 10, 4, 5)!.match(/about (.*?) tokens in/)![1]);
  assert.ok(asFresh < real.inTokens / 2, `${asFresh}`);
});

test("carried and fresh tickets are priced from their own history, and a range runs from the median to the 80th percentile", () => {
  // Fresh: 1M, 1M, 3M in (median 1M, p80 3M). Carried: 6M in.
  const p = project([...fresh(1, 5, 1_000_000, 10_000), ...fresh(2, 5, 1_000_000, 10_000), ...fresh(3, 15, 3_000_000, 30_000), ...carried(4, 20, 6_000_000, 60_000)]);
  assert.equal(
    estimate(p, 2, 2, 0, undefined, { carried: [true, false] })?.replace(/ No history at .*$/, ""),
    "Estimate (rough, from 4 ticket(s) in the last 3 runs): about 7.0M to 9.0M tokens in / 70k to 90k out and 20m for 2 ticket(s) (1 carried, 1 fresh), 2 at a time.",
  );
  // The median end is the carried ticket's own 20m (the summed 35m over 2 slots is 17.5m); the high end is 65m over 2 slots.
  assert.equal(
    estimate(p, 4, 2, 0, undefined, { carried: [true, false, false, false] })!.match(/and (.*?) for/)![1],
    "20m to 33m",
  );
  // No carried ticket in the run: no split, and the fresh figures.
  assert.match(estimate(p, 2, 2)!, /about 2\.0M to 6\.0M tokens in \/ 20k to 60k out and 5m to 15m for 2 ticket\(s\), 2 at a time\.(?: No history at .*)?$/);
});

test("a carried ticket with no carried history says the estimate is low", () => {
  const p = project([...fresh(1, 5, 1_000_000, 10_000), ...fresh(2, 5, 1_000_000, 10_000)]);
  const text = estimate(p, 3, 3, 0, undefined, { carried: [true, true, false] })!;
  assert.match(text, /about 3\.0M tokens in/);
  assert.match(text, /\(2 carried, 1 fresh\)/);
  assert.match(text, /2 carried ticket\(s\) have no carried history here; the estimate is low\.(?: No history at .*)?$/);
  assert.ok(!/have no carried history/.test(estimate(p, 3, 3, 0, undefined, { carried: [false, false, false] })!));
});

test("a chain adds up its own tickets' times, not the average of the run", () => {
  // Carried 10m, fresh 2m. Tickets 0 and 2 are carried, 1 and 3 fresh; the chain is 0, 1, 2.
  const p = project([...fresh(1, 2, 100_000, 1_000), ...carried(2, 10, 100_000, 1_000)]);
  const flags = [true, false, true, false];
  const real = estimate(p, 4, 4, 3, undefined, { carried: flags, chainAt: [0, 1, 2] })!;
  assert.match(real, /and 22m for 4 ticket\(s\) \(2 carried, 2 fresh\), 4 at a time \(3 tickets in sequence\)\.(?: No history at .*)?$/);
  // Without the chain's tickets each takes the average, 6m: 18m.
  assert.match(estimate(p, 4, 4, 3, undefined, { carried: flags })!, /and 18m for 4 ticket\(s\)/);
});

test("a history ticket whose timings lines say `carried` counts as carried", () => {
  const p = project([...fresh(1, 2, 100_000, 1_000), line({ issue: "2", phase: "implement", ms: 10 * MIN, carried: true, tokens: tok(900_000, 9_000) })]);
  assert.match(estimate(p, 1, 1, 0, undefined, { carried: [true] })!, /about 900k tokens in \/ 9k out and 10m for 1 ticket\(s\) \(1 carried, 0 fresh\), 1 at a time\.(?: No history at .*)?$/);
});

test("isCarried: a branch ahead of the base is, a landed or missing one is not", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-carried-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("branch", "agent/issue-1");
  git("checkout", "-q", "agent/issue-1");
  git("commit", "-q", "--allow-empty", "-m", "work");
  git("checkout", "-q", "main");
  git("branch", "agent/issue-2");
  assert.equal(isCarried(root, "main", "1"), true);
  assert.equal(isCarried(root, "main", "2"), false, "on the base already: a reopened ticket runs fresh");
  assert.equal(isCarried(root, "main", "3"), false, "no branch");
  git("merge", "-q", "--ff-only", "agent/issue-1");
  assert.equal(isCarried(root, "main", "1"), false, "landed");
});
