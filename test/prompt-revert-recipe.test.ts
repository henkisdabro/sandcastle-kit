// The "test without your change" recipe saves and reverts the same files, both from HEAD. Saving
// every unstaged change while reverting only some left hunks in the patch that were already in
// place, so `git apply` refused the whole patch and the change stayed reverted; and a plain
// `git checkout -- <files>` restores from the index, so a staged change survived the revert and the
// check passed with the change in place. No model calls.
//
//   pnpm test:file test/prompt-revert-recipe.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8").replace(/\s+/g, " ");

const carriers = [
  ...readdirSync(join(root, "prompts")).map((n) => join("prompts", n)),
  join("container", "git-guard.sh"),
].filter((f) => read(f).includes("git apply /tmp/p"));

test("the recipe is carried by the implement, review and repair prompts and the stash refusal", () => {
  for (const f of ["prompts/implement.md", "prompts/review.md", "prompts/repair.md", "container/git-guard.sh"]) {
    assert.ok(carriers.includes(f), f);
  }
});

// A reviewer's change is already committed, so a diff against HEAD is empty and the HEAD recipe
// reverts nothing; its recipe diffs against the target branch and reverses the patch instead.
const reviewer = join("prompts", "review.md");

test("every file that names the recipe, bar the review prompt, saves and reverts the same files, both from HEAD", () => {
  for (const f of carriers.filter((c) => c !== reviewer)) {
    const t = read(f);
    assert.match(t, /git diff HEAD -- <files> > \/tmp\/p && git checkout HEAD -- <files>/, f);
    assert.doesNotMatch(t, /git diff > \/tmp\/p/, f);
    assert.doesNotMatch(t, /git checkout -- <files>/, f);
  }
});

test("the review prompt reverts the branch's committed change against the target branch", () => {
  const t = read(reviewer);
  assert.match(t, /git diff \{\{TARGET_BRANCH\}\}\.\.\.HEAD -- <files> > \/tmp\/p && git apply -R \/tmp\/p/);
  assert.match(t, /then `git apply \/tmp\/p`/);
  assert.doesNotMatch(t, /git diff HEAD -- <files>/);
  assert.doesNotMatch(t, /git checkout HEAD -- <files>/);
});
