// A carried branch no head record vouches for (stopped before its review) gets a full review, so the estimate
// prices it as a fresh ticket and not as a land-only carried one (src/run.ts `carriedKind`, `priceRun`). In one run two
// such branches cost 1.98M and 1.63M tokens against the 0.55M a carried ticket was priced at. Made-up timings and a
// temp git repo; no tracker, Docker or network.
//
//   pnpm test:file test/estimate-carried-unreviewed.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate, carriedKind, recordHead } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tok = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output });
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

const fresh = (issue: number, minutes: number, input: number, output: number) => [line({ issue: String(issue), phase: "implement", ms: minutes * MIN, tokens: tok(input, output) })];
/** A land-only carried ticket: a resolve and its gates, flagged `carried` as the run writes it. */
const landOnly = (issue: number, minutes: number, input: number) => [line({ issue: String(issue), phase: "resolve", ms: minutes * MIN, carried: true, tokens: tok(input, 1_000) })];

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const project = (lines: string[], root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-unreviewed-"))) => {
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

/** Three fresh tickets of 3M in / 10m and three land-only carried ones of 500k in / 2m. */
const history = [
  ...fresh(1, 10, 3_000_000, 30_000), ...fresh(2, 10, 3_000_000, 30_000), ...fresh(3, 10, 3_000_000, 30_000),
  ...landOnly(4, 2, 500_000), ...landOnly(5, 2, 500_000), ...landOnly(6, 2, 500_000),
];
const noLoad = / No history at .*$/;

test("a branch with no head record is priced above a land-only carried branch from the same window", () => {
  const p = project(history);
  const landOnlyText = estimate(p, 1, 1, 0, undefined, { carried: [true] })!;
  const unreviewedText = estimate(p, 1, 1, 0, undefined, { unreviewed: [true] })!;
  assert.match(landOnlyText, /about 500k tokens in \/ 1k out and 2m for 1 ticket\(s\) \(1 carried, 0 fresh\)/);
  assert.match(unreviewedText, /about 3\.0M tokens in \/ 30k out and 10m for 1 ticket\(s\) \(1 to review, 0 fresh\)/);
});

test("the start line counts a branch to review apart from the carried and the fresh", () => {
  const p = project(history);
  const text = estimate(p, 3, 3, 0, undefined, { carried: [true, false, false], unreviewed: [false, true, false] })!;
  assert.match(text.replace(noLoad, ""), /\(1 carried, 1 to review, 1 fresh\)/);
  // Priced: 500k for the carried one and 3M for each of the other two.
  assert.match(text, /about 6\.5M tokens in/);
  assert.ok(!/have no carried history/.test(text));
});

test("with no fresh history an unreviewed branch is priced from the whole window", () => {
  const p = project(landOnly(4, 2, 500_000).concat(landOnly(5, 2, 500_000)));
  assert.match(estimate(p, 1, 1, 0, undefined, { unreviewed: [true] })!, /about 500k tokens in/);
});

test("a past unreviewed branch is a fresh sample, and the carried history stays land-only", () => {
  const reviewed = (issue: number) => [
    line({ issue: String(issue), phase: "resolve", ms: 4 * MIN, unreviewed: true, tokens: tok(2_000_000, 20_000) }),
    line({ issue: String(issue), phase: "review", ms: 6 * MIN, unreviewed: true, tokens: tok(0, 0) }),
  ];
  const p = project([...landOnly(4, 2, 500_000), ...landOnly(5, 2, 500_000), ...reviewed(7), ...reviewed(8)]);
  // Carried work is priced from the two land-only tickets alone ...
  assert.match(estimate(p, 1, 1, 0, undefined, { carried: [true] })!, /about 500k tokens in \/ 1k out and 2m for 1 ticket\(s\) \(1 carried, 0 fresh\)/);
  // ... and a branch to review from the two that were reviewed.
  assert.match(estimate(p, 1, 1, 0, undefined, { unreviewed: [true] })!, /about 2\.0M tokens in \/ 20k out and 10m for 1 ticket\(s\)/);
});

test("a carried branch is carried work only when a recorded head vouches for it", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-carried-kind-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a"), "a\n");
  git(root, "add", "a");
  git(root, "commit", "-q", "-m", "init");
  const branch = (id: number) => {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`);
    writeFileSync(join(root, `f${id}`), "x\n");
    git(root, "add", `f${id}`);
    git(root, "commit", "-q", "-m", `work ${id}`);
    const tip = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    return tip;
  };
  const green = branch(1);
  const reviewed = branch(2);
  branch(3);
  branch(4);
  recordHead(root, "1", { branch: "agent/issue-1", reviewed: green, green }, "run");
  recordHead(root, "2", { branch: "agent/issue-2", reviewed }, "run");
  // Ticket 4 was reviewed at an earlier tip and has a commit since: new work, a full review.
  recordHead(root, "4", { branch: "agent/issue-4", reviewed: git(root, "rev-parse", "main"), green: git(root, "rev-parse", "main") }, "run");
  assert.equal(carriedKind(root, "main", "1"), "carried");
  assert.equal(carriedKind(root, "main", "2"), "carried");
  assert.equal(carriedKind(root, "main", "3"), "unreviewed");
  assert.equal(carriedKind(root, "main", "4"), "unreviewed");
  assert.equal(carriedKind(root, "main", "9"), undefined);
});

test("a run records an unreviewed branch on its timings lines in place of carried, and prices its estimate by it", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(source, /const carriedKinds = new Map\(candidates\.map\(\(i\) => \[i\.id, carriedKind\(project\.root, project\.baseBranch, i\.id\)\] as const\)\)/);
  assert.match(source, /const carriedAtStart = new Set\(candidates\.filter\(\(i\) => carriedKinds\.get\(i\.id\) === "carried"\)/);
  assert.match(source, /const unreviewedAtStart = new Set\(candidates\.filter\(\(i\) => carriedKinds\.get\(i\.id\) === "unreviewed"\)/);
  assert.match(source, /unreviewed: candidates\.map\(\(i\) => unreviewedAtStart\.has\(i\.id\)\)/);
  assert.match(source, /\.\.\.\(unreviewedAtStart\.has\(issue\) \? \{ unreviewed: true \} : \{\}\)/);
  assert.equal(source.match(/carried: carriedAtStart\.has\(id\), unreviewed: unreviewedAtStart\.has\(id\)/g)?.length, 3);
});
