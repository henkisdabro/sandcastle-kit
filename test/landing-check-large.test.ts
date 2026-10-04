// The host's check on a landing commit lists the paths of each side with `git diff --name-only`.
// A side that changed more than 1 MiB of paths (a vendored directory, a mass rename) overran
// execFileSync's default buffer and the landing failed with ENOBUFS on a merge that was fine.
// A temp git repo, no Docker, no model, no network.
//
//   pnpm exec tsx --test test/landing-check-large.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { checkLandingMerge } = await import("../src/land.ts");
const { dirtyFiles } = await import("../src/run.ts");

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-landing-large-"));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// Some 1.3 MiB of path names, in one directory whose name fills most of each path.
const PATHS = 6000;
const bulk = (root: string, tree: string) => {
  const dir = join(root, tree, "d".repeat(180));
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PATHS; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
};

test("a landing whose base and branch each changed over 1 MiB of paths is checked as any other", () => {
  const root = join(tmp, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "1\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "branch");
  bulk(root, "vendor-branch");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  const h = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  bulk(root, "vendor-base");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main");
  const b = git(root, "rev-parse", "HEAD");
  assert.ok(git(root, "diff", "--name-only", "-z", `${h}~1`, h).length > 1024 * 1024, "the fixture must exceed 1 MiB of paths");
  git(root, "checkout", "-q", "-B", "scratch", b);
  git(root, "merge", "-q", "--no-ff", "-m", "land", h);
  const c = git(root, "rev-parse", "HEAD");
  assert.equal(checkLandingMerge(root, c, b, h, []), undefined);

  // A stray change is still found past the large lists.
  git(root, "checkout", "-q", "-B", "scratch2", b);
  git(root, "merge", "-q", "--no-ff", "--no-commit", h);
  writeFileSync(join(root, "a.txt"), "sneaked\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "land");
  assert.match(checkLandingMerge(root, git(root, "rev-parse", "HEAD"), b, h, []) ?? "", /a\.txt/);
});

test("dirtyFiles lists more than 1 MiB of untracked paths", () => {
  const root = join(tmp, "dirty");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  bulk(root, "vendor");
  assert.equal(dirtyFiles(root).length, 1);
  git(root, "add", "-A");
  assert.equal(dirtyFiles(root).length, PATHS);
});
