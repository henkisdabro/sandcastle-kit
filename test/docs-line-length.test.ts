// A paragraph kept on one line made docs/architecture.md 194 KB with lines over 10,000 characters:
// agents' greps and diffs of it overflowed their tool's output limit (a 2 KB preview came back), and
// tickets that appended to the same paragraph conflicted on the same line. The file is wrapped at
// about 100 columns, a sentence to start a line, and this holds every top-level docs/*.md to a cap
// no wrapped paragraph reaches. Tables and fenced code cannot be wrapped and are left out; a
// sub-directory is not checked (docs/agents/ has list lines of its own). No model calls.
//
//   pnpm test:file test/docs-line-length.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const DOCS = join(import.meta.dirname, "..", "docs");
const MAX = 400;

/** The lines of a markdown text over `max` characters, outside fenced code and tables, as `line N (length)`. */
function longLines(text: string, max: number): string[] {
  const found: string[] = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && !/^\s*\|/.test(line) && line.length > max) found.push(`line ${i + 1} (${line.length})`);
  });
  return found;
}

test("the checker finds a paragraph kept on one line and leaves a table row and fenced code alone", () => {
  const long = "word ".repeat(100);
  assert.deepEqual(longLines(`short\n${long}\n`, MAX), ["line 2 (500)"]);
  assert.deepEqual(longLines(`| a | ${long} |\n`, MAX), []);
  assert.deepEqual(longLines("```\n" + long + "\n```\n" + long, MAX), ["line 4 (500)"]);
});

for (const name of readdirSync(DOCS).filter((f) => f.endsWith(".md"))) {
  test(`docs/${name} keeps every line of prose under ${MAX} characters`, () => {
    const over = longLines(readFileSync(join(DOCS, name), "utf8"), MAX);
    assert.deepEqual(over, [], `wrap these at about 100 columns, one sentence to start a line: ${over.join(", ")}`);
  });
}
