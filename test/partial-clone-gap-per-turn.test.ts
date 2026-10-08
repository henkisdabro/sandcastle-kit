// A multi-turn `sandcastle run` calls burndown() once per turn in one process, and each turn writes a run
// record and a closing summary of its own. The note that a host merge check hit a missing object in a partial
// clone is module state, so it is forgotten at the top of every turn: a turn names the gap only when its own
// checks hit it. Temp git repos with a local filtered upstream; no Docker, model or network.
//
//   pnpm test:file test/partial-clone-gap-per-turn.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

const { mergeCheckGap, resetMergeCheckGap, strayChanges } = await import("../src/resolution.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-partial-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// An upstream whose main and agent/issue-5 both change shared.txt, then a clone with no blobs: the merge needs blobs only the upstream has.
const upstream = join(tmp, "upstream");
git(tmp, "init", "-q", upstream);
git(upstream, "config", "uploadpack.allowFilter", "true");
git(upstream, "symbolic-ref", "HEAD", "refs/heads/main");
writeFileSync(join(upstream, "shared.txt"), "a\nb\nc\n");
git(upstream, "add", "-A");
git(upstream, "commit", "-q", "-m", "base");
git(upstream, "checkout", "-q", "-b", "agent/issue-5");
writeFileSync(join(upstream, "shared.txt"), "a\nbranch\nc\n");
git(upstream, "commit", "-q", "-am", "branch");
git(upstream, "checkout", "-q", "main");
writeFileSync(join(upstream, "shared.txt"), "a\nmain\nc\n");
git(upstream, "commit", "-q", "-am", "main");

const partial = join(tmp, "partial");
git(tmp, "clone", "-q", "--no-checkout", "--filter=blob:none", `file://${upstream}`, partial);

const check = () => strayChanges(partial, { ours: "origin/main", theirs: "origin/agent/issue-5", resolved: "origin/main" });

test("a turn's merge-check note is forgotten for the next turn, which says it again when its own check fails", async () => {
  const first = await quietly(check);
  assert.equal(first.lines.length, 1, `said: ${first.lines.join(" | ")}`);
  assert.match(mergeCheckGap() ?? "", /objects are missing in this partial clone/);

  resetMergeCheckGap();
  assert.equal(mergeCheckGap(), undefined);

  const second = await quietly(check);
  assert.equal(second.lines.length, 1, `said again: ${second.lines.join(" | ")}`);
  assert.match(mergeCheckGap() ?? "", /objects are missing in this partial clone/);
});

test("burndown() forgets the merge-check note before it records its run", () => {
  // burndown() needs Docker, so no test drives it: the reset's place is held by its source.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  const start = src.indexOf("export const burndown = ");
  const reset = src.indexOf("resetMergeCheckGap();", start);
  const record = src.indexOf("recordRun(", start);
  assert.ok(start >= 0 && reset > start, "burndown() calls resetMergeCheckGap()");
  assert.ok(record > reset, "the reset comes before recordRun");
});
