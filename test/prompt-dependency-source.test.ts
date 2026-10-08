// A reviewer was never asked where a dependency the branch adds comes from: a package installed
// from a URL, a git ref or a local path skips the project's registry, and with it any release-age
// cooldown, and nothing in the review noticed. The prompts now ask, in stack-neutral words. No
// Docker, model or network.
//
//   pnpm test:file test/prompt-dependency-source.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "prompts", name), "utf8").replace(/\s+/g, " ");

test("the review asks where each added or changed dependency comes from", () => {
  const review = read("review.md");
  assert.match(review, /3\. \*\*Dependencies the branch adds or changes\.\*\* For each one in a manifest or lockfile, say where it comes from \(the project's registry, a git ref, a URL, a local path\), whether it is pinned as the project pins the rest, and whether the ticket needs it\./);
  assert.match(review, /A package from outside the registry skips it, and with it any release-age cooldown the project sets\./);
});

test("the review removes an unneeded dependency and switches one to the registry's release", () => {
  const review = read("review.md");
  assert.match(review, /Remove one the ticket does not need; switch one from outside the registry to the registry's release where there is one;/);
});

test("a dependency the ticket needs only from elsewhere goes in an <ungated> line, with its package and source", () => {
  const review = read("review.md");
  assert.match(review, /if the ticket needs one only published elsewhere, keep it and name the package and its source in an `<ungated>` line, so a person checks it\./);
  assert.match(review, /a dependency from outside the registry \(item 3\)/);
});

test("the review items stay in order, with item 1 where other prompts refer to it", () => {
  const review = readFileSync(join(import.meta.dirname, "..", "prompts", "review.md"), "utf8");
  const numbers = [...review.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(review, /^1\. \*\*Does it do what the ticket asked\?\*\*/m);
});

test("the implementer takes a dependency from the registry unless the ticket names the source", () => {
  assert.match(read("implement.md"), /It comes from the project's registry, never a URL, a git ref or a local path, unless the ticket names that source\./);
});

test("the prompts name no package manager in the dependency wording", () => {
  const review = read("review.md");
  const item = review.slice(review.indexOf("3. **Dependencies the branch"), review.indexOf("4. **Does it contradict"));
  assert.ok(item.length > 100);
  assert.doesNotMatch(item, /\b(pnpm|npm|yarn|pip|cargo|bundler|composer)\b/i);
});
