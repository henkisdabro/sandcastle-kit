// The commit count in a ticket's close comment: a carried branch's own work,
// without the merge commits the kit makes to bring the base in.
//
//   pnpm exec tsx --test test/commits.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ownCommits } from "../src/sandbox.ts";

test("a branch of two work commits and a merge of the base counts two", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-commits-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  const commit = (file: string) => {
    writeFileSync(join(root, file), `${file}\n`);
    git("add", file);
    git("commit", "-q", "-m", file);
  };
  git("init", "-q", "-b", "main");
  commit("start");
  git("checkout", "-q", "-b", "agent/issue-1");
  commit("work-1");
  commit("work-2");
  git("checkout", "-q", "main");
  commit("moved-on");
  git("checkout", "-q", "agent/issue-1");
  git("merge", "-q", "--no-ff", "-m", "Merge branch 'main' into agent/issue-1", "main");
  assert.equal(Number(git("rev-list", "--count", "main..agent/issue-1").trim()), 3);
  assert.equal(ownCommits("main", "agent/issue-1", root), 2);
});
