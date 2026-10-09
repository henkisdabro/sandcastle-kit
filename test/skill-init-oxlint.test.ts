// skill/init.md offers oxlint to a Node project with no linter, as a ticket or a separate change,
// and says an oxlint `lint` script needs `--deny-warnings`.
//
//   pnpm test:file test/skill-init-oxlint.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");
const init = flat(read("skill", "init.md"));

test("the init action offers oxlint to a Node project with no linter, outside init", () => {
  assert.match(init, /no linter/);
  assert.match(init, /pnpm add -D oxlint/);
  assert.match(init, /"lint": "oxlint --deny-warnings"/);
  assert.match(init, /as a ticket or a separate change, never as part of init/);
});

test("the init action says an oxlint lint script needs --deny-warnings", () => {
  assert.match(init, /plain `oxlint` exits 0 when it finds only warnings/);
});
