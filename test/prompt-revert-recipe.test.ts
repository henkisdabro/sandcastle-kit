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

test("every file that names the recipe saves and reverts the same files, both from HEAD", () => {
  for (const f of carriers) {
    const t = read(f);
    assert.match(t, /git diff HEAD -- <files> > \/tmp\/p && git checkout HEAD -- <files>/, f);
    assert.doesNotMatch(t, /git diff > \/tmp\/p/, f);
    assert.doesNotMatch(t, /git checkout -- <files>/, f);
  }
});
