// audit.md defines the Touches: line that src/touches.ts reads.
//
//   pnpm exec tsx --test test/skill-audit-touches.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const audit = readFileSync(join(root, "skill", "audit.md"), "utf8").replace(/\r\n/g, "\n").replace(/\s+/g, " ");

test("audit.md defines the Touches: format, with an example", () => {
  assert.ok(audit.includes("Touches: <path or glob>, <path or glob>, ..."));
  for (const word of ["repo-relative", "`*`", "`**`", "second `Touches:` line is merged into the first", "Example:"]) {
    assert.ok(audit.includes(word), `audit.md lacks "${word}"`);
  }
});
