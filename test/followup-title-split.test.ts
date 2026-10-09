// A `<followup>title - evidence</followup>` line splits at its first " - " that lies outside double
// quotes ("...", “...”) and backticks, so a title that quotes UI text or a command holding " - " keeps
// it. With none outside them (an unclosed quote, say) the first " - " splits, as before; the first and
// not the last, because the evidence is often a command and its output, which may hold " - " itself.
//
//   pnpm test:file test/followup-title-split.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// burndown.ts pulls in modules that derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { followUpsOf } = await import("../src/burndown.ts");

const split = (line: string) => followUpsOf(`Done.\n<followup>${line}</followup>\n`);

test("a title with a dash inside double quotes keeps it", () => {
  assert.deepEqual(split('Remove the unreachable "A - B" banner text - src/x.ts:4 renders it'), [
    { title: 'Remove the unreachable "A - B" banner text', evidence: "src/x.ts:4 renders it" },
  ]);
});

test("a title with a dash inside backticks keeps it", () => {
  assert.deepEqual(split("Remove the unreachable `A - B` banner text - src/x.ts:4 renders it"), [
    { title: "Remove the unreachable `A - B` banner text", evidence: "src/x.ts:4 renders it" },
  ]);
});

test("a title with a dash inside curly double quotes keeps it", () => {
  assert.deepEqual(split("Remove the unreachable “A - B” banner text - src/x.ts:4 renders it"), [
    { title: "Remove the unreachable “A - B” banner text", evidence: "src/x.ts:4 renders it" },
  ]);
});

test("the evidence keeps every dash after the first one outside quotes", () => {
  assert.deepEqual(split("title - evidence - more evidence"), [{ title: "title", evidence: "evidence - more evidence" }]);
});

test("an unclosed quote falls back to the first dash", () => {
  assert.deepEqual(split('Odd "quote - evidence'), [{ title: 'Odd "quote', evidence: "evidence" }]);
});

test("a single quote is an apostrophe, not a quote", () => {
  assert.deepEqual(split("Don't crash on it's input - evidence"), [{ title: "Don't crash on it's input", evidence: "evidence" }]);
});

test("a line with no dash is all title", () => {
  assert.deepEqual(split("Just a title"), [{ title: "Just a title", evidence: "" }]);
});
