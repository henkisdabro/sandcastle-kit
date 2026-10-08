// The status view's hand-merged row said "closes on push" for ever, even after the merge was pushed.
// It cannot ask the tracker on every refresh, but whether the merge commit is on origin's base branch
// is one cheap git call. Throwaway repos with a bare repository as origin; no gh, no Docker.
//
//   pnpm test:file test/hand-merged-pushed.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const started = "2026-10-01T08:00:00.000Z";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

type Remote = "none" | "before the merge" | "after the merge" | "branch only" | "fast-forward, then a local merge";

/**
 * A project whose held branch agent/issue-7 was merged by hand. `remote` is what origin has: nothing,
 * the base as it was before the merge, the base with the merge pushed, or only the branch's commit
 * pushed to the base (its tip is on origin's base, the merge commit is not), or the branch fast-forwarded
 * into the base and pushed, with another branch merged on top locally since.
 * `fromRun` records the ticket as held in run.json (the live view's row) instead of only in the outcomes.
 */
const repo = (remote: Remote, fromRun: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hand-pushed-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  writeFileSync(join(root, ".scratch/shop/issues/07-a.md"), "# A\n\nStatus: ready-for-human\n\nDo it.\n\n## Comments\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  if (remote !== "none") {
    const origin = mkdtempSync(join(tmpdir(), "sandcastle-hand-pushed-origin-"));
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(root, "remote", "add", "origin", origin);
    if (remote !== "branch only") git(root, "push", "-q", "origin", "main");
  }
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  writeFileSync(join(root, "work.txt"), "work\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the work");
  if (remote === "branch only") git(root, "push", "-q", "origin", "agent/issue-7:main");
  git(root, "checkout", "-q", "main");
  if (remote === "fast-forward, then a local merge") {
    git(root, "merge", "--ff-only", "-q", "agent/issue-7");
    git(root, "push", "-q", "origin", "main");
    git(root, "checkout", "-q", "-b", "other");
    writeFileSync(join(root, "other.txt"), "other\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "other work");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "--no-ff", "-qm", "Merge other", "other");
  } else git(root, "merge", "--no-ff", "-qm", "Merge agent/issue-7", "agent/issue-7");
  if (remote === "after the merge") git(root, "push", "-q", "origin", "main");
  if (remote !== "none") git(root, "fetch", "-q", "origin");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/outcomes.json"), JSON.stringify({ "7": { run: started, kind: "held", text: "needs a human merge" } }));
  // A branch is a row once an agent log names it.
  writeFileSync(join(root, ".sandcastle/logs/agent-issue-7-impl-7.log"), "done\n");
  const tickets = fromRun ? { "7": { state: "held", title: "A" } } : {};
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: started, exitCode: 0, tickets }));
  return root;
};

/** The status view's row for #7, as the shell test renders it. */
const rowOf = (root: string) => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-bin-"));
  writeFileSync(join(bin, "sandcastle"), "#!/usr/bin/env bash\necho '[]'\n");
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "sandcastle"), 0o755);
  chmodSync(join(bin, "docker"), 0o755);
  const r = spawnSync("bash", [join(import.meta.dirname, "../status.sh"), "0", "all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SANDCASTLE_PROJECT: root,
      SANDCASTLE_BIN: join(bin, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: "120",
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(bin, "cache"),
    },
  });
  const frame = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  return frame.split("\n").filter((l) => l.includes("#7")).join("\n") || `(no row for #7) ${r.status}\n${frame}`;
};

for (const fromRun of [false, true]) {
  const via = fromRun ? "a held ticket in the run record" : "an outcome with no commits";
  test(`status: a hand merge already on origin's base drops "closes on push" (${via})`, () => {
    for (const remote of ["after the merge", "fast-forward, then a local merge"] as const) {
      const row = rowOf(repo(remote, fromRun));
      assert.match(row, /merged .*merged by hand/, `${remote}: ${row}`);
      assert.doesNotMatch(row, /closes on push/, `${remote}: ${row}`);
    }
  });

  test(`status: a hand merge not yet pushed keeps "closes on push" (${via})`, () => {
    for (const remote of ["before the merge", "branch only"] as const) {
      const row = rowOf(repo(remote, fromRun));
      assert.match(row, /merged .*merged by hand; closes on push/, `${remote}: ${row}`);
    }
  });

  test(`status: a hand merge with no origin/<base> keeps "closes on push" (${via})`, () => {
    const row = rowOf(repo("none", fromRun));
    assert.match(row, /merged .*merged by hand; closes on push/, row);
  });
}
