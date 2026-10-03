// The README says a run's gates prove Linux only, in "How it works" (where gates and
// landing are described) and in "Set up a project" (where gates are configured).
//
//   pnpm exec tsx --test test/readme-gates-linux-only.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
const section = (heading: RegExp) => {
  const start = readme.search(heading);
  assert.notEqual(start, -1, `README has no heading matching ${heading}`);
  const rest = readme.slice(start + 1);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
};

for (const [name, heading] of [
  ["How it works", /^## .*How it works/m],
  ["Set up a project", /^## .*Set up a project/m],
] as const) {
  test(`README ${name} says green gates prove Linux only`, () => {
    const text = section(heading).replace(/\s+/g, " ");
    assert.match(text, /prove[s]? Linux only/);
    assert.match(text, /macOS or Windows/);
    assert.match(text, /CI job on that OS/);
    assert.match(text, /gates on the host/);
  });
}
