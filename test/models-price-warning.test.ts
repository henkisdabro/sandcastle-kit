// The models guidance warns that Claude Haiku 5.5 is billed at five times its price for a prompt
// over 100K tokens, and that the kit's `high` effort default applies to any model: the skill's
// "Models and effort" and the README's effort note say it in the same terms.
//
//   pnpm test:file test/models-price-warning.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");

const skillSection = flat(
  read("skill", "run.md").match(/^## Models and effort\b[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0] ?? "",
);
const readmeNote = flat(read("README.md").match(/A project that always wants different models[\s\S]*?<\/details>/)?.[0] ?? "");

for (const [where, text] of [
  ["skill/run.md's Models and effort", skillSection],
  ["the README's effort note", readmeNote],
] as const) {
  test(`${where} warns about Haiku 5.5's long-prompt price`, () => {
    assert.match(text, /Haiku 5\.5/);
    assert.match(text, /100K tokens/);
    assert.match(text, /five times/);
    assert.match(text, /`medium` or below/);
    assert.match(text, /`IMPL_EFFORT`/);
    assert.match(text, /`high`/);
  });

  test(`${where} names no dollar figure`, () => {
    assert.doesNotMatch(text, /\$\d/);
  });
}

test("the skill points at the token lines to compare runs on", () => {
  assert.match(skillSection, /TOKENS column/);
});
