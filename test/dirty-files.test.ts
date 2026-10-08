// dirtyFiles (src/run.ts) in a throwaway repo: what it names when a merge is refused
// because of the working tree. Pins that staged, unstaged and untracked paths all
// appear, and that a line starting with a space (an unstaged edit, ` M path`) keeps its
// status column - sh() would trim it away. Plain git, so it holds on macOS and Linux.
//
//   pnpm test:file test/dirty-files.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dirtyFiles } from "../src/run.ts";

// Explicit `-b main` because CI may default to master; identity per command because
// CI has no global git config.
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-dirty-files-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { root, git };
};

test("a clean tree has no dirty files", () => {
  assert.deepEqual(dirtyFiles(repo().root), []);
});

test("staged, unstaged and untracked paths are all named", () => {
  const { root, git } = repo();
  writeFileSync(join(root, "a.txt"), "changed\n");
  git("add", "a.txt");
  writeFileSync(join(root, "b.txt"), "changed\n");
  writeFileSync(join(root, "new.txt"), "new\n");
  assert.deepEqual(dirtyFiles(root).sort(), ["?? new.txt", " M b.txt", "M  a.txt"].sort());
});

test("the first line's leading space survives", () => {
  const { root } = repo();
  writeFileSync(join(root, "a.txt"), "changed\n");
  assert.deepEqual(dirtyFiles(root), [" M a.txt"]);
});
