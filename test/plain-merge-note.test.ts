// The landing merge's tree check (`plainMergeNote`, src/land.ts) tells a merge that conflicts from
// a git call that failed. Temp git repos - no Docker, model or network.
//
//   pnpm test:file test/plain-merge-note.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { plainMergeNote } = await import("../src/land.ts");
const { mergeTreeSupported } = await import("../src/resolution.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-plain-merge-note-"));
const supported = mergeTreeSupported(TMP);
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const repo = () => {
  const root = mkdtempSync(join(TMP, "repo-"));
  git(root, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Operator Example"], ["user.email", "operator@example.com"], ["commit.gpgsign", "false"]]) git(root, "config", k, v);
  writeFileSync(join(root, "a.txt"), "start\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "start");
  return root;
};

test("a failed git call is reported as one, not as a conflict", { skip: !supported && "git older than 2.38" }, () => {
  const root = repo();
  const base = git(root, "rev-parse", "main");
  const missing = "1".repeat(base.length);
  const note = plainMergeNote(root, base, base, missing);
  assert.match(note ?? "", /could not be run/);
  assert.doesNotMatch(note ?? "", /conflicts/);
});

test("a conflicting merge is still reported as a conflict", { skip: !supported && "git older than 2.38" }, () => {
  const root = repo();
  git(root, "checkout", "-q", "-b", "branch");
  writeFileSync(join(root, "a.txt"), "from the branch\n");
  git(root, "commit", "-q", "-am", "branch");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "a.txt"), "from the base\n");
  git(root, "commit", "-q", "-am", "base");
  const base = git(root, "rev-parse", "main");
  const head = git(root, "rev-parse", "branch");
  assert.equal(plainMergeNote(root, base, base, head), "the host's own merge of base and the gated head conflicts, but the sandbox's did not");
});
