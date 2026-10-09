// Agents' commits carry no issue-closing keyword: a partly done ticket the kit left open was closed by an
// implementer's "(closes #N)" once the branch reached the default branch. And the changelog ask names the
// length past which a line is dropped, and says "nothing to do" is no Upgrading note (#664).
//
//   pnpm test:file test/prompt-no-closing-keyword.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(KIT, p), "utf8").replace(/\s+/g, " ");

test("every prompt that commits forbids closing keywords", () => {
  for (const p of ["prompts/implement.md", "prompts/review.md", "prompts/repair.md"]) {
    assert.match(read(p), /Never write an issue-closing keyword \(`Closes #N`, `Fixes #N`, `Resolves #N`\) in a commit/, p);
  }
});

test("the changelog ask names the dropped length and refuses an empty Upgrading note", async () => {
  const run = read("src/run.ts");
  const { CHANGELOG_MAX } = await import("../src/burndown.ts");
  assert.match(run, new RegExp(`under ${CHANGELOG_MAX} characters`));
  assert.match(run, /Write no `Upgrading:` line when an existing project has nothing/);
});
