// With the Markdown ticket-files tracker the close of a ticket is a commit of its ticket file after the
// landing, so the base tip never has a landing's exact tree. `landingOfTree` told the ticket directory
// ignores changes under it, so a red verify still says "the sandbox, not the merge"; a change outside it
// keeps "RED TOGETHER". Temp repos only.
//
//   pnpm test:file test/verify-same-tree-files-tracker.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { landingOfTree } = await import("../src/landing.ts");

const repo = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();
const commit = (file: string, text: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
  git("add", file);
  git("commit", "-q", "-m", `change ${file}`);
  return git("rev-parse", "HEAD");
};

test("a ticket file committed after a landing leaves the landing's tree the verified one, only with the files tracker", () => {
  git("init", "-q", "-b", "main");
  commit(".scratch/feat/issues/01-a.md", "open\n");
  const first = commit("a.txt", "a\n");
  const second = commit("b.txt", "b\n");
  const landed = new Map([
    ["1", { commit: first }],
    ["2", { commit: second }],
  ]);
  // The tracker's close of ticket 2, then a follow-up filed mid-run.
  commit(".scratch/feat/issues/01-a.md", "closed\n");
  commit(".scratch/feat/issues/02-follow-up.md", "open\n");
  assert.equal(landingOfTree(repo, "refs/heads/main", landed, ".scratch"), "2");
  assert.equal(landingOfTree(repo, "refs/heads/main", landed, "./.scratch/"), "2");
  // GitHub: no directory, so the exact tree is still required.
  assert.equal(landingOfTree(repo, "refs/heads/main", landed), undefined);
  // Another directory is not the tracker's.
  assert.equal(landingOfTree(repo, "refs/heads/main", landed, "tickets"), undefined);
  // A change a gate could read, beside a ticket file, is a new tree.
  commit("c.txt", "c\n");
  assert.equal(landingOfTree(repo, "refs/heads/main", landed, ".scratch"), undefined);
});
