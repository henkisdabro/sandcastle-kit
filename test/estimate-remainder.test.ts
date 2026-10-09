// The estimate prices a remainder - a ticket re-run for what an earlier "part of" merge left - from past
// remainders, not as a new ticket (src/run.ts `estimate`, `isRemainder`). A drain's second turn priced three of
// them at 2.8M to 4.2M tokens and 6m to 8m, and they used about a tenth of that. Made-up timings and a temp git
// repo; no tracker, Docker or network.
//
//   pnpm test:file test/estimate-remainder.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate, isRemainder } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tok = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output });
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

const fresh = (issue: number, minutes: number, input: number, output: number) => [line({ issue: String(issue), phase: "implement", ms: minutes * MIN, tokens: tok(input, output) })];
/** A remainder's lines, as the run writes them for a ticket re-run after a "part of" merge. */
const remainder = (issue: number, minutes: number, input: number, output: number) => [
  line({ issue: String(issue), phase: "implement", ms: minutes * MIN, remainder: true, tokens: tok(input, output) }),
];

const project = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-remainder-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

const noLoad = / No history at .*$/;

test("three remainders are priced from the history of remainders, not from the full tickets before them", () => {
  // Three full tickets (3M in, 10m) and three past remainders (300k in, 1m).
  const p = project([
    ...fresh(1, 10, 3_000_000, 30_000), ...fresh(2, 10, 3_000_000, 30_000), ...fresh(3, 10, 3_000_000, 30_000),
    ...remainder(4, 1, 300_000, 3_000), ...remainder(5, 1, 300_000, 3_000), ...remainder(6, 1, 300_000, 3_000),
  ]);
  assert.equal(
    estimate(p, 3, 3, 0, undefined, { remainder: [true, true, true] })?.replace(noLoad, ""),
    "Estimate (rough, from 3 ticket(s) in the last 3 runs): about 900k tokens in / 9k out and 1m for 3 ticket(s) (3 remainder, 0 fresh), 3 at a time.",
  );
});

test("fresh tickets are not priced from remainders", () => {
  const p = project([...fresh(1, 10, 3_000_000, 30_000), ...fresh(2, 10, 3_000_000, 30_000), ...remainder(3, 1, 300_000, 3_000)]);
  assert.match(estimate(p, 1, 1)!, /about 3\.0M tokens in \/ 30k out and 10m for 1 ticket\(s\), 1 at a time\./);
});

test("a remainder with no remainder history is priced as a fresh ticket and the line says it may be high", () => {
  const p = project([...fresh(1, 10, 3_000_000, 30_000), ...fresh(2, 10, 3_000_000, 30_000)]);
  const text = estimate(p, 3, 3, 0, undefined, { remainder: [true, true, false] })!;
  assert.match(text, /about 9\.0M tokens in/);
  assert.match(text, /\(2 remainder, 1 fresh\)/);
  assert.match(text, /2 remainder ticket\(s\) have no remainder history here; priced as fresh tickets, so it may be high\./);
  // Not the "no history at this concurrency" warning, which stays for the load and says it may be low.
  assert.match(text, /No history at 3 at a time .*so it may be low\.$/);
  assert.ok(!/have no remainder history/.test(estimate(p, 3, 3, 0, undefined, { remainder: [false, false, false] })!));
});

test("a carried branch is carried work even when an earlier merge was partial", () => {
  const p = project([...fresh(1, 10, 3_000_000, 30_000), ...remainder(2, 1, 300_000, 3_000)]);
  const text = estimate(p, 1, 1, 0, undefined, { carried: [true], remainder: [true] })!;
  assert.match(text, /\(1 carried, 0 fresh\)/);
  assert.ok(!/remainder/.test(text.replace(/^Estimate/, "")));
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("a ticket whose branch merged as 'part of' is a remainder, one that was closed or has new commits is not", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-remainder-repo-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a"), "a\n");
  git(root, "add", "a");
  git(root, "commit", "-q", "-m", "init");
  const merge = (id: number, word: "part of" | "closes") => {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`);
    writeFileSync(join(root, `f${id}`), "x\n");
    git(root, "add", `f${id}`);
    git(root, "commit", "-q", "-m", `work ${id}`);
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", `agent/issue-${id}`, "-m", `Merge agent/issue-${id} (${word} #${id})`);
  };
  merge(1, "part of");
  merge(2, "closes");
  merge(3, "part of");
  // Ticket 3 was re-run and has work of its own ahead of the base: carried, not a remainder.
  git(root, "checkout", "-q", "agent/issue-3");
  writeFileSync(join(root, "g3"), "y\n");
  git(root, "add", "g3");
  git(root, "commit", "-q", "-m", "more 3");
  git(root, "checkout", "-q", "main");
  assert.equal(isRemainder(root, "main", "1"), true);
  assert.equal(isRemainder(root, "main", "2"), false);
  assert.equal(isRemainder(root, "main", "3"), false);
  assert.equal(isRemainder(root, "main", "9"), false);
});

test("a run records the remainder on its timings lines and prices its estimate by it", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(source, /const remainderAtStart = new Set\(candidates\.filter\(\(i\) => isRemainder\(project\.root, project\.baseBranch, i\.id\)\)/);
  assert.match(source, /remainder: candidates\.map\(\(i\) => remainderAtStart\.has\(i\.id\)\)/);
  assert.match(source, /\.\.\.\(remainderAtStart\.has\(issue\) \? \{ remainder: true \} : \{\}\)/);
});
