// The ticket-writing guidance (audit.md step 10, the queue action in SKILL.md): Touches names
// files an agent may edit, existing ones as they are, a new file marked in prose; a run opens no PR.
//
//   pnpm exec tsx --test test/skill-ticket-writing.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseTouches } from "../src/touches.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(join(root, "skill", f), "utf8").replace(/\r\n/g, "\n").replace(/\s+/g, " ");
const audit = read("audit.md");
const skill = read("SKILL.md");

test("audit.md: Touches names only files an agent may edit under the project's rules", () => {
  for (const word of ["only files an agent may edit under the project's rules", "false overlap line", "existing file's path as it is"]) {
    assert.ok(audit.includes(word), `audit.md lacks "${word}"`);
  }
});

test("audit.md: a new file is marked new in the prose, never on the Touches line", () => {
  assert.ok(audit.includes("Mark a new file as new in the ticket's prose"));
  assert.ok(audit.includes('never on the `Touches:` line, where "(new)" would be read as part of the path'));
});

test("the claim holds: parseTouches reads a '(new)' marker as part of the path", () => {
  assert.deepEqual(parseTouches("Touches: src/a.ts, test/b.test.ts (new)"), ["src/a.ts", "test/b.test.ts (new)"]);
});

test("audit.md: a run opens no PR, so evidence goes in the final message or a ticket comment", () => {
  assert.ok(audit.includes("A run opens no pull request"));
  assert.ok(audit.includes("final message or a ticket comment"));
});

test("SKILL.md's queue action carries the same rules", () => {
  for (const word of ["names only files an agent may edit under the project's rules", "marked new in the prose, not on that line", "A run opens no pull request", "final message or a ticket comment"]) {
    assert.ok(skill.includes(word), `SKILL.md lacks "${word}"`);
  }
});
