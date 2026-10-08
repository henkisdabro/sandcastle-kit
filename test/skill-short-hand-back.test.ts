// A person's request for a short hand-back wins over the seven-section closing summary: the
// skill's step 4 must say so, keep what the short form may never drop, and offer the full
// sections. The seven sections stay the default (test/skill-split.test.ts holds their headings).
//
//   pnpm test:file test/skill-short-hand-back.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
// Normalise line endings and wrapping so the test reads the same on either platform.
const read = (name: string) => readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");

const run = read("run.md");
const step4 = flat(run.slice(run.indexOf("4. **Close the run"), run.indexOf("## How landing reads")));
const shortForm = step4.slice(step4.indexOf("A shorter hand-back"), step4.indexOf("Otherwise write your closing message"));

test("step 4 lets a user's request in the conversation or a standing preference win", () => {
  assert.ok(shortForm.length > 0, "run.md step 4 has no short hand-back paragraph before the seven sections");
  assert.match(shortForm, /in this conversation/);
  assert.match(shortForm, /standing preference in their own memory or instructions/);
  assert.match(shortForm, /request wins/);
});

test("the short form always keeps what a person must not miss", () => {
  assert.match(shortForm, /RED TOGETHER/);
  assert.match(shortForm, /do not push/);
  assert.match(shortForm, /ended early, was stopped or was killed/);
  assert.match(shortForm, /one line for each item that needs the person/);
  assert.match(shortForm, /nothing was pushed/);
  assert.match(shortForm, /one recommended next step and the one question/);
});

test("the short form offers the full sections and the seven stay the default", () => {
  assert.match(shortForm, /one line offering the full seven sections/);
  assert.match(shortForm, /seven sections stay the default when nothing was asked/);
  assert.match(step4, /Otherwise write your closing message with \*\*all seven sections, in this order/);
});

test("the short form names no harness's memory file, so the skill stays portable", () => {
  assert.doesNotMatch(shortForm, /CLAUDE\.md|AGENTS\.md|MEMORY\.md|memory file|\.claude|\.codex|opencode/i);
});

test("SKILL.md's run row no longer requires the seven sections unconditionally", () => {
  const row = read("SKILL.md").split("\n").find((line) => line.startsWith("| `run` |")) ?? "";
  assert.ok(row.length > 0, "SKILL.md has no run row");
  assert.match(row, /seven sections, unless they asked for a short hand-back/);
  assert.doesNotMatch(row, /the user has the seven-section closing summary/);
});
