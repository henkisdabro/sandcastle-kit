// A red end-of-run verify on a tree a landing's own gates passed is red for its sandbox (a gate-only
// sandbox has no git identity, a ticket's has one), not because tickets met. `landingOfTree` finds
// that landing from git, the run records it as `verify.gatedTree`, and the closing summary's re-gated
// line and first next step say "the sandbox, not the merge" instead of "together". A new tree keeps
// "RED TOGETHER". Temp repos only; `burndown()` needs Docker, so its call site is held by a source match.
//
//   pnpm test:file test/verify-same-tree.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");
const { landingOfTree } = await import("../src/landing.ts");
type Facts = Parameters<typeof render>[0];

const repo = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const commit = (file: string, text: string) => {
  writeFileSync(join(repo, file), text);
  git("add", file);
  git("commit", "-q", "-m", `change ${file}`);
  return git("rev-parse", "HEAD");
};

const facts = (verify: Facts["verify"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: { "1": { state: "merged", title: "a" }, "2": { state: "merged", title: "b" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  verify,
});
const regated = (verify: Facts["verify"]) => render(facts(verify), true).split("\n").find((l) => l.startsWith("Merged main"));
const nextStep = (verify: Facts["verify"]) => render(facts(verify), true).split("\n").find((l) => l.startsWith("1. Fix main"));

test("a red verify on a tree a landing's gates passed says the sandbox differs, not the merge", () => {
  const line = regated({ green: false, line: "test=FAIL", gatedTree: "#451" })!;
  assert.match(line, /^Merged main re-gated: RED in a clean sandbox on the tree #451's own gates passed - the difference is the sandbox, not the merge \(test=FAIL\) - do not push main/);
  assert.doesNotMatch(line, /TOGETHER/);
  const next = nextStep({ green: false, line: "test=FAIL", gatedTree: "#451" })!;
  assert.match(next, /on the tree #451's own gates passed/);
  assert.doesNotMatch(next, /together/);
});

test("a red verify on a tree a landing sandbox gated points at a flaky test, not the sandbox or the merge", () => {
  const line = regated({ green: false, line: "test=FAIL", cleanTree: "#451" })!;
  assert.match(line, /^Merged main re-gated: RED on the tree #451's landing gates passed in a clean sandbox - likely a flaky or order-dependent test, not the merge \(test=FAIL\)/);
  assert.doesNotMatch(line, /TOGETHER|the difference is the sandbox/);
  assert.match(nextStep({ green: false, line: "test=FAIL", cleanTree: "#451" })!, /run `sandcastle gates` again to see whether a test is flaky/);
});

test("a red verify on a new tree keeps RED TOGETHER", () => {
  assert.match(regated({ green: false, line: "test=FAIL" })!, /^Merged main re-gated: RED TOGETHER \(test=FAIL\)/);
  assert.match(nextStep({ green: false, line: "test=FAIL" })!, /merged together, the gates are red/);
  // A record of the wrong type is no ticket.
  assert.match(regated({ green: false, line: "test=FAIL", gatedTree: 7 } as unknown as Facts["verify"])!, /RED TOGETHER/);
});

test("the landing whose tree is the base tip's is found, and none when the tip is a new tree", () => {
  git("init", "-q", "-b", "main");
  const first = commit("a.txt", "a\n");
  const second = commit("b.txt", "b\n");
  const landed = new Map([
    ["1", { commit: first }],
    ["2", { commit: second }],
  ]);
  assert.equal(landingOfTree(repo, "refs/heads/main", landed), "2");
  // A merge commit holding the second landing's exact tree (a fast-forward written as a merge) is the same tree.
  const merged = git("commit-tree", `${second}^{tree}`, "-p", second, "-m", "merge");
  git("update-ref", "refs/heads/main", merged);
  assert.notEqual(git("rev-parse", "main"), second);
  assert.equal(landingOfTree(repo, "refs/heads/main", landed), "2");
  // Another commit makes a tree no landing's gates saw: that is a merge of tickets.
  commit("c.txt", "c\n");
  assert.equal(landingOfTree(repo, "refs/heads/main", landed), undefined);
  assert.equal(landingOfTree(repo, "refs/heads/missing", landed), undefined);
});

test("the run compares the verified tree with its landings and records the match", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /landingOfTree\(project\.root, `refs\/heads\/\$\{base\}`, landed, project\.tracker\.kind === "files" \? project\.tracker\.dir : undefined\)/);
  assert.match(src, /gatedTree: verifyTreeOf/);
  assert.match(src, /cleanTree: verifyCleanTreeOf/);
  assert.match(src, /if \(same && landed\.get\(same\)\?\.clean\) verifyCleanTreeOf = ref\(same\);/);
  // A landing merged in a sandbox says so where it is recorded; a fast-forward does not.
  const landing = readFileSync(new URL("../src/landing.ts", import.meta.url), "utf8");
  assert.match(landing, /record\(before, result\.commit, true\);/);
  assert.match(landing, /^\s+record\(before, after\);$/m);
  assert.match(src, /^\s+landed,$/m);
});
