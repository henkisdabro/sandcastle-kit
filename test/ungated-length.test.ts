// The reviewer's <ungated> note is kept whole up to a generous cap, cut at a word with "…" past
// it, and the closing report then points at the review log. No repo, Docker, model or network.
//
//   pnpm exec tsx --test test/ungated-length.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { ungatedOf, cutAtWord, UNGATED_MAX } = await import("../src/burndown.ts");
const { render } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `step${i}`).join(" ");

test("a 600-character note is kept whole, and a short one is unchanged", () => {
  const long = words(100).slice(0, 600).trimEnd();
  assert.equal(ungatedOf(`<ungated>${long}</ungated>`), long);
  assert.equal(ungatedOf("<ungated>open the page</ungated>"), "open the page");
});

test("a note over the cap is cut at a word boundary and ends with …", () => {
  const out = ungatedOf(`<ungated>${words(1000)}</ungated>`) ?? "";
  assert.ok(out.length <= UNGATED_MAX, String(out.length));
  assert.ok(out.endsWith("…"));
  assert.match(out.slice(0, -1).split(" ").at(-1) ?? "", /^step\d+$/);
});

test("cutAtWord cuts an unbroken run where it stands", () => {
  assert.equal(cutAtWord("x".repeat(50), 10), `${"x".repeat(9)}…`);
  assert.equal(cutAtWord("abc", 3), "abc");
});

test("the report shows a whole note as is, and a cut one with the review log's path", () => {
  const whole = words(100).slice(0, 600).trimEnd();
  const cut = cutAtWord(words(1000), UNGATED_MAX);
  const out = render(
    facts({
      tickets: {
        "3": { state: "merged", title: "a", ungated: whole },
        "4": { state: "merged", title: "b", ungated: cut },
      },
    }),
  );
  const lines = out.split("\n");
  assert.ok(lines.includes(`- #3 a - merged - check by hand: ${whole}`));
  assert.ok(lines.includes(`- #4 b - merged - check by hand: ${cut} (cut short - full text in .sandcastle/logs/agent-issue-4-review-4.log)`));
});
