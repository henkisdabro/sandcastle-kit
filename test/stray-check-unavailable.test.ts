// A conflict resolution's stray check that cannot run (git older than 2.38, or a git call that failed in a full
// clone) lets the resolution go on (#99), and its screen line is said once per process (#568). Each turn still
// records why in `mergeCheckGap()`, which burndown() writes to the run record's `mergeUnchecked` and the closing
// summary prints as `Merge checks: ...`: a drain's later turn prints nothing, yet its summary must not read as if
// every resolution was checked. Temp git repos with a local filtered upstream; no Docker, model or network.
//
// The tests run in order: the first unavailable call of this process prints the screen line, the rest print none.
//
//   pnpm test:file test/stray-check-unavailable.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

const { mergeCheckGap, resetMergeCheckGap, strayChanges } = await import("../src/resolution.ts");
const { render } = await import("../src/report.ts");
import type { Facts } from "../src/report.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-stray-gap-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// A full repository whose main and agent/issue-5 both change shared.txt, and a blobless clone of it.
const full = join(tmp, "full");
git(tmp, "init", "-q", full);
git(full, "config", "uploadpack.allowFilter", "true");
git(full, "symbolic-ref", "HEAD", "refs/heads/main");
writeFileSync(join(full, "shared.txt"), "a\nb\nc\n");
git(full, "add", "-A");
git(full, "commit", "-q", "-m", "base");
git(full, "checkout", "-q", "-b", "agent/issue-5");
writeFileSync(join(full, "shared.txt"), "a\nbranch\nc\n");
git(full, "commit", "-q", "-am", "branch");
git(full, "checkout", "-q", "main");
writeFileSync(join(full, "shared.txt"), "a\nmain\nc\n");
git(full, "commit", "-q", "-am", "main");

const partial = join(tmp, "partial");
git(tmp, "clone", "-q", "--no-checkout", "--filter=blob:none", `file://${full}`, partial);

const OLD_GIT = "a conflict resolution was not checked against git's own merge: it needs git 2.38 or newer";
const FAILED = /^a conflict resolution was not checked against git's own merge: git failed \(.*no-such-ref/;

const oldGit = () => strayChanges(full, { ours: "main", theirs: "agent/issue-5", resolved: "main", gitVersion: "git version 2.37.1" });
const failedGit = () => strayChanges(full, { ours: "main", theirs: "agent/issue-5", resolved: "no-such-ref" });

test("a git older than 2.38 lets the resolution go on, and the turn's merge-check note names git 2.38", async () => {
  resetMergeCheckGap();
  const { result, lines } = await quietly(oldGit);
  assert.equal(result, undefined);
  assert.equal(lines.length, 1, `said: ${lines.join(" | ")}`);
  assert.equal(mergeCheckGap(), OLD_GIT);
});

test("a git call that fails in a full clone leaves a note naming the failure", async () => {
  resetMergeCheckGap();
  assert.equal(mergeCheckGap(), undefined);
  const { result } = await quietly(failedGit);
  assert.equal(result, undefined);
  assert.match(mergeCheckGap() ?? "", FAILED);
});

test("the next turn records the note again but prints no second screen line", async () => {
  resetMergeCheckGap();
  assert.equal(mergeCheckGap(), undefined, "the reset forgets the last turn's note");
  const { result, lines } = await quietly(oldGit);
  assert.equal(result, undefined);
  assert.deepEqual(lines, [], "the screen line is once per process");
  assert.equal(mergeCheckGap(), OLD_GIT);
});

test("two causes in one turn give both notes, each once", async () => {
  resetMergeCheckGap();
  await quietly(() => [oldGit(), failedGit(), oldGit(), failedGit()]);
  const notes = (mergeCheckGap() ?? "").split("; ");
  assert.equal(notes.length, 2, `notes: ${mergeCheckGap()}`);
  assert.equal(notes[0], OLD_GIT);
  assert.match(notes[1], FAILED);
});

test("a partial clone's gap and a stray-check note in one turn both come back, the partial clone's first", async () => {
  resetMergeCheckGap();
  // The stray check's note comes first in time; the partial clone's still leads the summary's line.
  await quietly(oldGit);
  const { result } = await quietly(() => strayChanges(partial, { ours: "origin/main", theirs: "origin/agent/issue-5", resolved: "origin/main" }));
  assert.equal(result, undefined);
  // The partial clone's own sentence holds a `; `, so the notes are told apart by how each begins and ends.
  const gap = mergeCheckGap() ?? "";
  assert.match(gap, /^a host merge check could not run, because objects are missing in this partial clone: .*a full clone holds them all; /);
  assert.ok(gap.endsWith(`; ${OLD_GIT}`), `notes: ${gap}`);
  assert.equal(gap.split(OLD_GIT).length, 2, "the stray-check note once");
});

test("the closing summary's Merge checks line names a resolution the old git left unchecked", async () => {
  resetMergeCheckGap();
  await quietly(oldGit);
  const facts: Facts = { base: "main", tracker: "github", started: "2026-11-11T06:41:00.000Z", finished: "2026-11-11T06:49:00.000Z", live: false, dryRun: false, gateCount: 1, tickets: {}, runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, stage: "report", exitCode: 0, verify: null, mergeUnchecked: mergeCheckGap() };
  const line = render(facts).split("\n").find((l) => l.startsWith("Merge checks: "));
  assert.equal(line, "Merge checks: a conflict resolution was not checked against git's own merge: it needs git 2.38 or newer.");
});
