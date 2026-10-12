// The estimate sizes a ticket by its `Touches:` path count and its body's length (src/run.ts `sizeOf`), in three classes, and a
// ticket with no `Touches:` line is sized by its body alone instead of counting as large. The timings lines record both
// (`touches`, `bodyChars`); an older line without `bodyChars` is sized by its path count alone. Made-up timings and a temp
// directory; no tracker, Docker or network.
//
//   pnpm test:file test/estimate-size-body.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate, sizeOf } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tok = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output });

/** A ticket's implement step: `paths` Touches paths and a body of `body` characters (either undefined: a line from before the field). */
const ticket = (issue: number, paths: number | undefined, body: number | undefined, minutes: number, input: number) =>
  JSON.stringify({
    project: "fixture", run: "r1", issue: String(issue), phase: "implement", ms: minutes * MIN, tokens: tok(input, input / 100),
    ...(paths === undefined ? {} : { touches: paths }), ...(body === undefined ? {} : { bodyChars: body }),
  });

const project = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-size-body-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

const SMALL = "small tickets (body under 1,000 characters and at most 2 Touches paths)";
const LARGE = "large tickets (body of 2,500 characters or more, or 6 or more Touches paths)";

test("a body under 1,000 characters with at most 2 paths is small, 2,500 or more or 6 paths is large, the rest medium", () => {
  assert.equal(sizeOf(1, 500), "small");
  assert.equal(sizeOf(2, 999), "small");
  assert.equal(sizeOf(3, 500), "medium");
  assert.equal(sizeOf(2, 1000), "medium");
  assert.equal(sizeOf(1, 2499), "medium");
  assert.equal(sizeOf(1, 2500), "large");
  assert.equal(sizeOf(6, 100), "large");
  assert.equal(sizeOf(5, 2000), "medium");
});

test("a ticket with no Touches line is sized by its body alone", () => {
  assert.equal(sizeOf(0, 400), "small");
  assert.equal(sizeOf(0, 1500), "medium");
  assert.equal(sizeOf(0, 3000), "large");
});

test("a line from before bodyChars is sized by its path count alone, and one with no paths either way is unsized", () => {
  assert.equal(sizeOf(1), "small");
  assert.equal(sizeOf(4), "medium");
  assert.equal(sizeOf(6), "large");
  assert.equal(sizeOf(0), undefined);
});

/** The window: three large tickets (no Touches line, a 3,000-character body) and three small ones (400 characters). */
const window = () => [
  ...[1, 2, 3].map((n) => ticket(n, 0, 3000, 30, 10_000_000)),
  ...[4, 5, 6].map((n) => ticket(n, 0, 400, 5, 800_000)),
];

test("tickets with no Touches line are priced by body length: large ones from the large, small ones from the small", () => {
  const p = project(window());
  const large = estimate(p, 2, 1, 0, undefined, { touches: [0, 0], bodyChars: [3200, 2600] })!;
  assert.match(large, /about 20\.0M tokens in \/ 200k out /, large);
  assert.ok(large.includes(`2 ticket(s) priced by size from the window's ${LARGE}.`), large);
  const small = estimate(p, 2, 1, 0, undefined, { touches: [0, 0], bodyChars: [300, 900] })!;
  assert.match(small, /about 1\.6M tokens in \/ 16k out /, small);
  assert.ok(small.includes(`2 ticket(s) priced by size from the window's ${SMALL}.`), small);
});

test("a window of lines with paths only still prices by path count", () => {
  const lines = [
    ...[1, 2, 3].map((n) => ticket(n, 8, undefined, 30, 10_000_000)),
    ...[4, 5, 6].map((n) => ticket(n, 1, undefined, 5, 800_000)),
  ];
  const text = estimate(project(lines), 1, 1, 0, undefined, { touches: [1], bodyChars: [200] })!;
  assert.match(text, /about 800k tokens in /, text);
  assert.ok(text.includes(`1 ticket(s) priced by size from the window's ${SMALL}.`), text);
});

test("a medium ticket against a window of small ones with no medium history says it may be low", () => {
  const lines = [1, 2, 3, 4, 5].map((n) => ticket(n, 1, 300, 5, 800_000));
  const text = estimate(project(lines), 1, 1, 0, undefined, { touches: [0], bodyChars: [1800] })!;
  assert.match(text, /1 ticket\(s\) are larger \(by body length and Touches paths\) than most of the window's, with too little history of their size, so it may be low\./, text);
});
