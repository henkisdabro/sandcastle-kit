// In a partial (promisor) clone a blob only the remote holds cannot be read by the host's merge checks (they
// never fetch). They used to fail quietly and read the merge as clean; now `sandcastle doctor` warns on such a
// clone, and a check that hits a missing object says so once and leaves a note for the closing summary.
// Temp git repos with a local filtered upstream; no Docker, model or network.
//
//   pnpm test:file test/partial-clone-merge-check.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";
import { runKit } from "./cli-spawn.ts";

const { isPartialClone, mergeCheckGap, mergeTree, noteMissingObjects, strayChanges } = await import("../src/resolution.ts");
const { render } = await import("../src/report.ts");
import type { Facts } from "../src/report.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-partial-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// An upstream whose main and agent/issue-5 both change shared.txt, then a clone of it with no blobs (`--filter=blob:none`):
// the merge of the two needs shared.txt's blobs, which only the upstream has.
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
const full = join(tmp, "full");
git(tmp, "clone", "-q", "--no-checkout", `file://${upstream}`, full);

test("a partial clone is told from a full one by its promisor settings", () => {
  assert.equal(isPartialClone(partial), true);
  assert.equal(isPartialClone(full), false);
});

test("a merge check that needs a blob the partial clone lacks says so once and does not call the merge clean", async () => {
  const { result, lines } = await quietly(() => {
    const first = strayChanges(partial, { ours: "origin/main", theirs: "origin/agent/issue-5", resolved: "origin/main" });
    const second = strayChanges(partial, { ours: "origin/main", theirs: "origin/agent/issue-5", resolved: "origin/main" });
    return [first, second];
  });
  assert.deepEqual(result, [undefined, undefined]);
  assert.equal(lines.length, 1, `said once: ${lines.join(" | ")}`);
  assert.match(lines[0], /host merge check could not run, because objects are missing in this partial clone/);
  assert.doesNotMatch(lines[0], /git failed/);
  assert.match(mergeCheckGap() ?? "", /partial clone/);
});

test("a failed merge-tree in a partial clone is recognised as missing objects, and the same failure in a full clone is not", async () => {
  let failure: unknown;
  try {
    mergeTree(partial, "origin/main", "origin/agent/issue-5");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "the merge needs shared.txt's blobs, which the partial clone lacks");
  const { result } = await quietly(() => [noteMissingObjects(partial, failure), noteMissingObjects(full, failure)]);
  assert.deepEqual(result, [true, false]);
  // The full clone merges, naming the path that conflicts.
  assert.deepEqual([...mergeTree(full, "origin/main", "origin/agent/issue-5").conflicted], ["shared.txt"]);
});

test("the closing summary names a merge check that could not run", () => {
  const facts: Facts = { base: "main", tracker: "github", started: "2026-10-05T06:41:00.000Z", finished: "2026-10-05T06:49:00.000Z", live: false, dryRun: false, gateCount: 1, tickets: {}, runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, stage: "report", exitCode: 0, verify: null };
  assert.match(render({ ...facts, mergeUnchecked: "a host merge check could not run, because objects are missing in this partial clone: x" }), /^Merge checks: a host merge check could not run/m);
  assert.doesNotMatch(render(facts), /Merge checks:/);
});

test("the call sites tell the run: conflictBefore, the landing precheck, the base merge check and the run record", () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(read("burndown.ts"), /noteMissingObjects\(project\.root, error\)/);
  assert.match(read("burndown.ts"), /mergeUnchecked/);
  assert.match(read("landing.ts"), /noteMissingObjects\(root, error\)/);
  assert.match(read("land.ts"), /noteMissingObjects\(root, error\)/);
});

test("doctor warns on a partial clone and says nothing on a full one", () => {
  const env = { PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: join(tmp, "config"), XDG_CACHE_HOME: join(tmp, "cache"), GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const doctor = (cwd: string) => {
    const r = runKit(["doctor"], { cwd, encoding: "utf8", env });
    return r.stdout + r.stderr;
  };
  assert.match(doctor(partial), /^warn partial clone: .*never fetch/m);
  assert.doesNotMatch(doctor(full), /partial clone/);
});
