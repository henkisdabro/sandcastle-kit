// The ticket-writing guidance, kept once in queue.md's "Writing a ticket body" and pointed at by
// audit.md: Touches names files an agent may edit, existing ones as they are, a new file marked
// in prose; a run opens no PR.
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
const queue = read("queue.md");
const audit = read("audit.md");

test("queue.md: Touches names only files an agent may edit under the project's rules", () => {
  for (const word of ["only files an agent may edit under the project's rules", "false overlap line", "existing file's path as it is"]) {
    assert.ok(queue.includes(word), `queue.md lacks "${word}"`);
  }
});

test("queue.md: a new file is marked new in the prose, never on the Touches line", () => {
  assert.ok(queue.includes("Mark a new file as new in the ticket's prose"));
  assert.ok(queue.includes('never on the `Touches:` line, where "(new)" would be read as part of the path'));
});

test("the claim holds: parseTouches reads a '(new)' marker as part of the path", () => {
  assert.deepEqual(parseTouches("Touches: src/a.ts, test/b.test.ts (new)"), ["src/a.ts", "test/b.test.ts (new)"]);
});

test("queue.md: a run opens no PR, so evidence goes in the final message or a ticket comment", () => {
  assert.ok(queue.includes("A run opens no pull request"));
  assert.ok(queue.includes("final message or a ticket comment"));
});

test("audit.md writes its tickets by queue.md's rules rather than a copy of them", () => {
  assert.ok(audit.includes(`queue.md's "Writing a ticket body"`));
  assert.ok(!audit.includes("Touches: <path or glob>"), "audit.md still carries its own Touches format");
});
