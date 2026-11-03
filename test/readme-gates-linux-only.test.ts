// The docs say a run's gates prove Linux only, in the README's "How it works" (where gates and
// landing are described) and in docs/setup.md's "Set up a project" (where gates are configured).
//
//   pnpm test:file test/readme-gates-linux-only.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const kit = join(dirname(fileURLToPath(import.meta.url)), "..");
const section = (file: string, heading: RegExp) => {
  const readme = readFileSync(join(kit, file), "utf8");
  const start = readme.search(heading);
  assert.notEqual(start, -1, `${file} has no heading matching ${heading}`);
  const rest = readme.slice(start + 1);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
};

for (const [name, file, heading] of [
  ["How it works", "README.md", /^## .*How it works/m],
  ["Set up a project", "docs/setup.md", /^## .*Set up a project/m],
] as const) {
  test(`${file} ${name} says green gates prove Linux only`, () => {
    const text = section(file, heading).replace(/\s+/g, " ");
    assert.match(text, /prove[s]? Linux only/);
    assert.match(text, /macOS or Windows/);
    assert.match(text, /CI job on that OS/);
    assert.match(text, /gates on the host/);
  });
}
