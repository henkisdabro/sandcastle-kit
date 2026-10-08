// The README explains why a conflict resolution that edits a cleanly merged file is held for a
// person, in "How it works" (Re-runs) and in Troubleshooting, and the hold note it quotes is the one
// the kit writes.
//
//   pnpm test:file test/readme-held-resolution.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.XDG_CONFIG_HOME ??= join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache", "xdg");
const { strayNote } = await import("../src/resolution.ts");

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8").replace(/\s+/g, " ");

test("README explains the hold on a resolution that edits cleanly merged files", () => {
  assert.match(readme, /resolution may change only the files git could not merge itself/);
  assert.match(readme, /held for a person/);
  assert.match(readme, /drop another ticket's lines while every gate stays green/);
});

test("README's troubleshooting row starts with the note the kit writes", () => {
  const note = strayNote(["a.ts"]);
  const quoted = note.replace("a.ts", "<files>").replace(/ - check.*$/, "");
  assert.ok(readme.includes(`\`${quoted}\``), `troubleshooting should quote "${quoted}"`);
  assert.match(readme, /sandcastle requeue <n>` with a note to try again/);
});
