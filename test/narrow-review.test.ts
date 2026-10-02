// Which review a re-run gets: the recorded reviewed head, and whether everything since it is
// the base merge (narrowReviewBase), and the narrow prompt that shows a merge's resolution.
// Temp git repos and temp directories; no Docker, model or network.
//
//   pnpm exec tsx --test test/narrow-review.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Importing run.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { narrowReviewBase, recordHead, renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const commit = (cwd: string, file: string, text: string, subject = `edit ${file}`) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", subject);
};

/** A repo on agent/issue-5, one commit ahead of main, with that tip recorded as reviewed. */
const repo = (t: { after: (fn: () => void) => void }, file = "b.txt", text = "b\n") => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-narrow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  commit(dir, "a.txt", "a\n");
  git(dir, "checkout", "-q", "-b", "agent/issue-5");
  commit(dir, file, text, "branch work");
  const reviewed = git(dir, "rev-parse", "HEAD");
  recordHead(dir, "5", { branch: "agent/issue-5", reviewed }, "run-1");
  return { dir, reviewed };
};

/** main gains a commit on another file, then is merged into the branch. */
const mergeBase = (dir: string) => {
  git(dir, "checkout", "-q", "main");
  commit(dir, "m.txt", "m\n", "main work");
  git(dir, "checkout", "-q", "agent/issue-5");
  git(dir, "merge", "-q", "--no-edit", "main");
};

test("only a base merge since the review: the recorded SHA", (t) => {
  const { dir, reviewed } = repo(t);
  mergeBase(dir);
  assert.equal(narrowReviewBase(dir, "main", "5"), reviewed);
});

test("a tip equal to the reviewed head: the recorded SHA", (t) => {
  const { dir, reviewed } = repo(t);
  assert.equal(narrowReviewBase(dir, "main", "5"), reviewed);
});

test("an ordinary commit after the merge reviews in full", (t) => {
  const { dir } = repo(t);
  mergeBase(dir);
  commit(dir, "c.txt", "c\n");
  assert.equal(narrowReviewBase(dir, "main", "5"), undefined);
});

test("no record, or another branch's record, reviews in full", (t) => {
  const { dir } = repo(t);
  recordHead(dir, "6", { branch: "agent/issue-6", green: "x" }, "run-1");
  assert.equal(narrowReviewBase(dir, "main", "6"), undefined);
  recordHead(dir, "7", { branch: "agent/issue-5", reviewed: git(dir, "rev-parse", "HEAD") }, "run-1");
  assert.equal(narrowReviewBase(dir, "main", "7"), undefined);
  assert.equal(narrowReviewBase(dir, "main", "8"), undefined);
});

test("a record with no reviewed field reviews in full", (t) => {
  const { dir } = repo(t);
  recordHead(dir, "9", { branch: "agent/issue-9", green: git(dir, "rev-parse", "HEAD") }, "run-1");
  assert.equal(narrowReviewBase(dir, "main", "9"), undefined);
});

test("a reviewed SHA the branch does not contain reviews in full, with no throw", (t) => {
  const { dir } = repo(t);
  git(dir, "checkout", "-q", "main");
  commit(dir, "m.txt", "m\n", "main work");
  recordHead(dir, "5", { branch: "agent/issue-5", reviewed: git(dir, "rev-parse", "HEAD") }, "run-2");
  git(dir, "checkout", "-q", "agent/issue-5");
  assert.equal(narrowReviewBase(dir, "main", "5"), undefined);
});

test("a deleted branch reviews in full, with no throw", (t) => {
  const { dir } = repo(t);
  git(dir, "checkout", "-q", "main");
  git(dir, "branch", "-D", "agent/issue-5");
  assert.equal(narrowReviewBase(dir, "main", "5"), undefined);
});

const project = (root: string): Project => ({
  root,
  name: "narrow-review-test",
  baseBranch: "main",
  label: "ready-for-agent",
  concurrency: 1,
  mounts: [],
  setup: [],
  lean: { keep: [], dropHooks: [] },
  gates: [{ name: "unit", command: "echo gate-ok" }],
  hookTests: [],
  land: "merge",
  generated: [],
  implement: {},
  review: {},
  repair: {},
  tracker: { kind: "github", held: "ready-for-human", triage: "needs-triage", dir: "", done: [], source: "default" },
});

test("a conflict resolved inside the merge is still merge-only, and the narrow prompt's log shows the resolution", (t) => {
  const { dir, reviewed } = repo(t, "a.txt", "branch-side\n");
  git(dir, "checkout", "-q", "main");
  commit(dir, "a.txt", "main-side\n", "main edits a");
  git(dir, "checkout", "-q", "agent/issue-5");
  assert.throws(() => git(dir, "merge", "--no-edit", "main"));
  writeFileSync(join(dir, "a.txt"), "resolved-line\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "--no-edit");
  assert.equal(narrowReviewBase(dir, "main", "5"), reviewed);

  const root = mkdtempSync(join(tmpdir(), "sandcastle-narrow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { remerge } = renderPrompts(project(root), makeTracker(project(root)));
  const line = readFileSync(remerge, "utf8").split("\n").find((l) => l.startsWith("!`git log -p --cc "));
  assert.ok(line, "no git log command in the remerge prompt");
  const cmd = line.replaceAll("{{REVIEW_BASE}}", reviewed).replace(/^!`/, "").replace(/`$/, "");
  const out = execFileSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(out.includes("resolved-line"), out);
  assert.ok(!out.includes("branch work"), out);
});

test("the remerge prompt is rendered beside the others, and only it says it follows a base merge", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-narrow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = renderPrompts(project(root), makeTracker(project(root)));
  assert.equal(paths.remerge, join(root, ".sandcastle/.run", "remerge.md"));
  const text = readFileSync(paths.remerge, "utf8");
  assert.ok(text.includes("This is a second review, after a base merge"));
  assert.ok(text.includes("{{REVIEW_BASE}}"));
  for (const other of [paths.review, paths.rereview]) {
    assert.ok(!readFileSync(other, "utf8").includes("after a base merge"));
  }
});
