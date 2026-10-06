// The landing check's path lists ignore rename detection: a stray deletion paired with a file
// either side added must still be named, not hidden behind that side's path.
// A temp git repo, no Docker, no model, no network.
//
//   node --test test/landing-renames.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { checkLandingMerge } = await import("../src/land.ts");

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test("a stray deletion that looks like a rename to each side's new file is named", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-landing-renames-"));
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "other.txt"), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "branch");
  writeFileSync(join(root, "from-branch.txt"), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  const h = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "from-main.txt"), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main");
  const b = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-B", "scratch", b);
  git(root, "merge", "-q", "--no-ff", "--no-commit", h);
  git(root, "rm", "-q", "other.txt");
  git(root, "commit", "-q", "-m", "land");
  const c = git(root, "rev-parse", "HEAD");
  assert.equal(checkLandingMerge(root, c, b, h, [{ paths: ["dist/"], regen: "x" }]), "landing merge changed paths outside generated: other.txt");
});
