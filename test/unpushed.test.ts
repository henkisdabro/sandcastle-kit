// A ticket closes on the local merge, so the close comment says "not yet
// pushed" and the status header shows how far the base branch is ahead of its
// upstream (by the last fetch; the view never fetches). A throwaway bare remote
// and clone, a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm exec tsx --test test/unpushed.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-unpushed-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
const { closeComment } = await import("../src/burndown.ts");
after(() => rmSync(TMP, { recursive: true, force: true }));

test("the close comment says the work is merged locally, not pushed", () => {
  const text = closeComment({ branch: "agent/issue-7", commits: 2, repairs: 1 }, "test, lint", "did X");
  assert.ok(text.startsWith("Merged locally, not yet pushed"), text);
  for (const part of ["agent/issue-7", "2 commit(s)", "1 repair pass(es)", "test, lint all green before merge", "\n\ndid X"]) {
    assert.ok(text.includes(part), `missing ${part}: ${text}`);
  }
  assert.ok(!closeComment({ branch: "agent/issue-7", commits: 2, repairs: 0 }, "test").includes("repair"));
});

const KIT = join(import.meta.dirname, "..");
const FAKE = join(TMP, "bin");
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
script(join(FAKE, "sandcastle"), "#!/usr/bin/env bash\nprintf '[]\\n'\n");
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });

const makeRepo = (name: string, remote: boolean) => {
  const repo = join(TMP, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  if (remote) {
    const bare = join(TMP, `${name}.git`);
    git(TMP, "init", "-q", "--bare", "-b", "main", bare);
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "-u", "origin", "main");
  }
  mkdirSync(join(repo, ".sandcastle", "logs"), { recursive: true });
  return repo;
};

const titleOf = (repo: string): string => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [FAKE, process.env.PATH].join(delimiter),
      SANDCASTLE_PROJECT: repo,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      TERM_COLS: "120",
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
  });
  const line = r.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.includes("Sandcastle") && l.includes("base main"));
  assert.ok(line, `no title line in:\n${r.stdout}\n${r.stderr}`);
  return line;
};

test("the status title shows how many commits the base branch is ahead of its upstream", () => {
  const repo = makeRepo("ahead", true);
  assert.ok(!titleOf(repo).includes("unpushed"), "pushed base should show nothing");
  git(repo, "commit", "-q", "--allow-empty", "-m", "one");
  git(repo, "commit", "-q", "--allow-empty", "-m", "two");
  assert.match(titleOf(repo), /base main 2 unpushed/);
});

test("a base branch with no upstream shows no unpushed count", () => {
  const repo = makeRepo("local-only", false);
  git(repo, "commit", "-q", "--allow-empty", "-m", "one");
  assert.ok(!titleOf(repo).includes("unpushed"));
});
