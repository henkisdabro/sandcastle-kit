// The skill's portable frontmatter limits, and the queue step's triage brief: it must be complete
// as written, read-only, and carry a `Tickets:` line the assistant fills in before sending (a
// literal placeholder prompt once sent a whole fan-out to be killed and rerun).
//
//   pnpm test:file test/skill.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Normalise line endings so the test reads the same checked out on either platform.
const read = (name: string) => readFileSync(join(root, "skill", name), "utf8").replace(/\r\n/g, "\n");
const skill = read("SKILL.md");

const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
const queue = read("queue.md");
// The fence sits inside a numbered list item, so its lines are indented; strip that.
const brief = (queue.match(/```[a-z]*\n\s*(Brief for each subagent[\s\S]*?)```/)?.[1] ?? "")
  .replace(/^ +/gm, "");

test("the frontmatter name is sandcastle and the description fits OpenCode's limit", () => {
  assert.match(frontmatter, /^name: sandcastle$/m);
  const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? "";
  assert.ok(description.length > 0);
  assert.ok(description.length < 1024, `description is ${description.length} characters`);
});

test("queue.md holds a triage brief in a fenced block", () => {
  assert.ok(queue.length > 0, "queue.md is empty");
  assert.ok(brief.length > 0, "brief not found");
  const lines = brief.trim().split("\n").length;
  assert.ok(lines >= 12 && lines <= 18, `brief is ${lines} lines`);
});

test("the brief has a Tickets: line", () => {
  assert.match(brief, /^\s*Tickets: /m);
});

test("the brief names each of the seven categories", () => {
  // A category name can wrap across two lines.
  const flat = brief.replace(/\s+/g, " ");
  for (const name of [
    "ready",
    "needs a decision",
    "human-only",
    "blocked by another ticket",
    "already fixed or false",
    "epic or too big",
    "parked",
  ]) {
    assert.ok(flat.includes(name), `brief lacks the category "${name}"`);
  }
});

test("the brief is read-only and forbids tracker writes", () => {
  assert.match(brief, /Read-only/);
  assert.ok(brief.includes("gh issue comment") || brief.includes("no tracker writes"));
  assert.match(brief, /sandcastle run/);
});

test("the assistant is told to write the ticket numbers in before sending", () => {
  const flat = queue.replace(/\s+/g, " ");
  assert.match(flat, /Write the batch's ticket numbers into the `Tickets:` line before sending/);
  assert.match(flat, /never send a brief with a placeholder left in it/);
});
