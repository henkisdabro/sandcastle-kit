// A held ticket a person merged by hand with a "part of" merge never closes on a push, and the closing
// summary words it `merged by hand, partly done: stays open`. The status view must say the same, pushed
// or not (it read `closes on push`). Throwaway repos with a bare repository as origin; no gh, no Docker.
//
//   pnpm test:file test/status-hand-merged-partly.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const started = "2026-10-01T08:00:00.000Z";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

type Merge = "part of" | "closes" | "git's own subject" | "earlier part of, then closes";

/**
 * A project whose held branch agent/issue-7 was merged by hand with the subject `merge` says. For
 * "earlier part of, then closes" the branch's first commit was merged as a "part of" merge earlier
 * and the hand merge of its tip says "closes". `pushed` is whether origin has the hand merge.
 * `fromRun` records the ticket as held in run.json (the live view's row) instead of only in the outcomes.
 */
const repo = (merge: Merge, pushed: boolean, fromRun: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hand-partly-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  writeFileSync(join(root, ".scratch/shop/issues/07-a.md"), "# A\n\nStatus: ready-for-human\n\nDo it.\n\n## Comments\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const origin = mkdtempSync(join(tmpdir(), "sandcastle-hand-partly-origin-"));
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  if (merge === "earlier part of, then closes") {
    writeFileSync(join(root, "first.txt"), "first\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "the first part");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "--no-ff", "-qm", "Merge agent/issue-7 (part of #7)", "agent/issue-7");
    git(root, "push", "-q", "origin", "main");
    git(root, "checkout", "-q", "agent/issue-7");
  }
  writeFileSync(join(root, "work.txt"), "work\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the work");
  git(root, "checkout", "-q", "main");
  const subject = {
    "part of": "Merge agent/issue-7 (part of #7)",
    closes: "Merge agent/issue-7 (closes #7)",
    "git's own subject": "Merge branch 'agent/issue-7'",
    "earlier part of, then closes": "Merge agent/issue-7 (closes #7)",
  }[merge];
  git(root, "merge", "--no-ff", "-qm", subject, "agent/issue-7");
  if (pushed) git(root, "push", "-q", "origin", "main");
  git(root, "fetch", "-q", "origin");
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

  test(`status: a "part of" hand merge says partly done: stays open, pushed or not (${via})`, () => {
    for (const pushed of [false, true]) {
      const row = rowOf(repo("part of", pushed, fromRun));
      assert.match(row, /merged .*merged by hand, partly done: stays open/, `pushed ${pushed}: ${row}`);
      assert.doesNotMatch(row, /closes on push/, `pushed ${pushed}: ${row}`);
    }
  });

  test(`status: a "closes" hand merge after an earlier "part of" merge keeps "closes on push" (${via})`, () => {
    const row = rowOf(repo("earlier part of, then closes", false, fromRun));
    assert.match(row, /merged .*merged by hand; closes on push/, row);
    assert.doesNotMatch(row, /partly done/, row);
  });

  test(`status: a "closes" hand merge once pushed says merged by hand (${via})`, () => {
    const row = rowOf(repo("earlier part of, then closes", true, fromRun));
    assert.match(row, /merged .*merged by hand/, row);
    assert.doesNotMatch(row, /closes on push|partly done/, row);
  });

  test(`status: a hand merge with git's own subject keeps "closes on push" (${via})`, () => {
    const row = rowOf(repo("git's own subject", false, fromRun));
    assert.match(row, /merged .*merged by hand; closes on push/, row);
    assert.doesNotMatch(row, /partly done/, row);
  });
}
