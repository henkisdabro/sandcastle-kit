// The estimate prices a ticket by the size its `Touches:` line names (1-2 paths against more or none), from the
// window's tickets of that size, and falls back to the whole window's pricing with too little history of the size
// (src/run.ts `estimate`). The first test is the run that was quoted four times its tokens: four small tickets
// against a window of feature work. Made-up timings and a temp directory; no tracker, Docker or network.
//
//   pnpm test:file test/estimate-size.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tok = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output });
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

/** A ticket of `paths` Touches paths (undefined: a line from before the field), one implement step. */
const ticket = (issue: number, paths: number | undefined, minutes: number, input: number, output: number) => [
  line({ issue: String(issue), phase: "implement", ms: minutes * MIN, tokens: tok(input, output), ...(paths === undefined ? {} : { touches: paths }) }),
];

const project = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-size-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

/** The window: three tickets of feature work (6 paths, 10M tokens in) and three single-file ones (0.8M). */
const window = () => [
  ...ticket(1, 6, 30, 10_000_000, 80_000), ...ticket(2, 7, 30, 10_000_000, 80_000), ...ticket(3, 5, 30, 10_000_000, 80_000),
  ...ticket(4, 1, 5, 800_000, 6_000), ...ticket(5, 1, 5, 800_000, 6_000), ...ticket(6, 2, 5, 800_000, 6_000),
];

test("four single-file tickets are priced from the small tickets of the window, not its median", () => {
  const text = estimate(project(window()), 4, 1, 0, undefined, { touches: [1, 1, 1, 1] })!;
  // 4 x 0.8M tokens in and 4 x 6k out; the large tickets' 10M each would have made it 40M.
  assert.match(text, /about 3\.2M tokens in \/ 24k out /, text);
  assert.match(text, /4 ticket\(s\) priced from the window's tickets of 1-2 Touches paths\./, text);
  assert.match(text, /from 3 ticket\(s\) in the last 3 runs/, text);
});

test("a run of large tickets is priced from the large ones, and a ticket with no Touches line counts as large", () => {
  const text = estimate(project(window()), 2, 1, 0, undefined, { touches: [6, 0] })!;
  assert.match(text, /about 20\.0M tokens in \/ 160k out /, text);
  assert.match(text, /2 ticket\(s\) priced from the window's tickets of 3 or more Touches paths or none\./, text);
});

test("with fewer than three tickets of the size in the window, the pricing is the whole window's and says it may be high", () => {
  // Two small tickets only: too little to price by; the window's median is the large ones' 10M.
  const lines = [
    ...ticket(1, 6, 30, 10_000_000, 80_000), ...ticket(2, 7, 30, 10_000_000, 80_000), ...ticket(3, 5, 30, 10_000_000, 80_000),
    ...ticket(4, 8, 30, 10_000_000, 80_000), ...ticket(5, 1, 5, 800_000, 6_000), ...ticket(6, 2, 5, 800_000, 6_000),
  ];
  const text = estimate(project(lines), 2, 1, 0, undefined, { touches: [1, 1] })!;
  assert.match(text, /about 20\.0M tokens in /, text);
  assert.doesNotMatch(text, /priced from the window's tickets of/, text);
  assert.match(text, /2 ticket\(s\) are smaller \(1-2 Touches paths\) than most of the window's, with too little history of their size, so it may be high\./, text);
});

test("a run of large tickets against a window of small ones with too little large history says it may be low", () => {
  const lines = [
    ...ticket(1, 1, 5, 800_000, 6_000), ...ticket(2, 1, 5, 800_000, 6_000), ...ticket(3, 2, 5, 800_000, 6_000),
    ...ticket(4, 1, 5, 800_000, 6_000), ...ticket(5, 6, 30, 10_000_000, 80_000),
  ];
  const text = estimate(project(lines), 1, 1, 0, undefined, { touches: [9] })!;
  assert.match(text, /1 ticket\(s\) are larger \(3 or more Touches paths or none\) than most of the window's, with too little history of their size, so it may be low\./, text);
});

test("lines from before the field are of unknown size: the estimate is the old one, with nothing said about size", () => {
  const lines = [1, 2, 3, 4, 5].flatMap((n) => ticket(n, undefined, 10, 2_000_000, 20_000));
  const text = estimate(project(lines), 2, 1, 0, undefined, { touches: [1, 1] })!;
  assert.match(text, /about 4\.0M tokens in \/ 40k out /, text);
  assert.doesNotMatch(text, /Touches/, text);
});

test("without the run's path counts the estimate is the old one", () => {
  const text = estimate(project(window()), 4, 1)!;
  assert.doesNotMatch(text, /Touches/, text);
});

test("a ticket's path count is recorded on its timings line, and the estimate is given each ticket's", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /touchPaths = new Map\(candidates\.map\(\(i\) => \[i\.id, parseTouches\(i\.body \?\? ""\)\.length\]\)\)/);
  assert.match(src, /\.\.\.\(touchPaths\.has\(issue\) \? \{ touches: touchPaths\.get\(issue\) \} : \{\}\)/);
  assert.match(src, /touches: candidates\.map\(\(i\) => touchPaths\.get\(i\.id\) \?\? 0\)/);
});
