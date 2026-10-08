// The closing summary's token figures (src/report.ts): a run's tokens summed
// from timings.jsonl with the cached share, and the per-model line.
//
//   pnpm test:file test/tokens.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render, tokensFromTimings } from "../src/report.ts";

const t = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({ input, cacheWrite, cacheRead, output });
const line = (o: object) => JSON.stringify({ ts: "2026-09-30T07:00:00.000Z", project: "demo", issue: "1", ms: 1000, ok: true, ...o });

const A = "2026-09-30T06:41:00.000Z";
const B = "2026-09-29T06:41:00.000Z";

const timings = [
  line({ run: A, phase: "implement", model: "model-one", tokens: t(1, 2, 3, 4) }),
  line({ run: A, phase: "review", model: "model-two", tokens: t(10, 20, 30, 40) }),
  line({ run: A, phase: "repair", model: "model-one", tokens: t(100, 200, 300, 400) }),
  line({ run: A, phase: "review", tokens: t(1000, 2000, 3000, 4000) }),
  line({ run: A, phase: "gates" }),
  "not json at all",
  "",
  line({ run: B, phase: "implement", model: "model-one", tokens: t(5, 5, 5, 5) }),
].join("\n");

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: A,
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

test("tokensFromTimings sums one run, in total and per model", () => {
  const got = tokensFromTimings(timings, A);
  assert.deepEqual(got?.total, t(1111, 2222, 3333, 4444));
  assert.deepEqual(got?.byModel, {
    "model-one": t(101, 202, 303, 404),
    "model-two": t(10, 20, 30, 40),
    "model not recorded": t(1000, 2000, 3000, 4000),
  });
});

test("tokensFromTimings is undefined when no line of the run has tokens", () => {
  assert.equal(tokensFromTimings(timings, "2020-01-01T00:00:00.000Z"), undefined);
  assert.equal(tokensFromTimings("", A), undefined);
});

test("the headline shows the cached share", () => {
  const text = render(facts({ tokens: "1 in / 1 out", tokenTotal: t(1000, 2000, 3_000_000, 4000) }));
  assert.match(text, /tokens 3\.0M in \(3\.0M cached\) \/ 4k out/);
  assert.doesNotMatch(text, /1 in \/ 1 out/);
});

test("the headline falls back to run.json's tokens without timings", () => {
  assert.match(render(facts({ tokens: "9k in / 1k out" })), /tokens 9k in \/ 1k out/);
});

test("Tokens by model lists the larger model first", () => {
  const byModel = { small: t(1, 0, 0, 1), large: t(1000, 0, 5000, 100) };
  const text = render(facts({ tokenTotal: t(1001, 0, 5000, 101), byModel }));
  const at = text.split("\n").find((l) => l.startsWith("Tokens by model:"));
  assert.ok(at, text);
  assert.ok(at.indexOf("large") < at.indexOf("small"), at);
  assert.match(at, /large 6k in \(5k cached\) \/ 100 out · small 1 in \(0 cached\) \/ 1 out/);
});

test("with only unrecorded models there is no per-model line", () => {
  const text = render(facts({ tokenTotal: t(1, 0, 0, 1), byModel: { "model not recorded": t(1, 0, 0, 1) } }));
  assert.doesNotMatch(text, /Tokens by model:/);
});
