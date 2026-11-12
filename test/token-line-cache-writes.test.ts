// The tokens line shows cache writes apart from uncached input and cache reads, with their TTL when Claude's `result`
// line gave the split (#852): the closing summary's headline and `Tokens by model:`, and the run's per-ticket and
// `all agents:` lines, all through `tokenLine`. A total that mixes a figure with no split (an older kit's
// timings.jsonl line) never claims one; a figure that wrote nothing (a Codex pass, NO_TOKENS) leaves the split intact.
//
//   pnpm test:file test/token-line-cache-writes.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { implAgent } from "../src/agents.ts";
import { type Facts, render, tokensFromTimings } from "../src/report.ts";
import { addTokens, NO_TOKENS, runTokens, type Tokens, tokenLine } from "../src/run.ts";

const t = (input: number, cacheWrite: number, cacheRead: number, output: number, split: { h1?: number; m5?: number } = {}): Tokens => ({
  input,
  cacheWrite,
  cacheRead,
  output,
  ...(split.h1 === undefined ? {} : { cacheWrite1h: split.h1 }),
  ...(split.m5 === undefined ? {} : { cacheWrite5m: split.m5 }),
});

// 42.52M in all: 20k uncached, 2.2M written, 40.3M read.
const allHour = t(20_000, 2_200_000, 40_300_000, 1_200_000, { h1: 2_200_000, m5: 0 });

test("writes all 1-hour: read, then written 1h", () => {
  assert.equal(tokenLine(allHour), "42.5M in (40.3M read, 2.2M written 1h) / 1.2M out");
});

test("writes all 5-minute: written 5m", () => {
  assert.equal(tokenLine(t(20_000, 2_200_000, 40_300_000, 1_200_000, { h1: 0, m5: 2_200_000 })), "42.5M in (40.3M read, 2.2M written 5m) / 1.2M out");
});

test("writes of both kinds: how much of it is 1h", () => {
  const mixed = t(20_000, 2_200_000, 40_300_000, 1_200_000, { h1: 1_600_000, m5: 600_000 });
  assert.equal(tokenLine(mixed), "42.5M in (40.3M read, 2.2M written, 1.6M of it 1h) / 1.2M out");
});

test("no split known, or one that does not add up to the writes: plain written", () => {
  assert.equal(tokenLine(t(20_000, 2_200_000, 40_300_000, 1_200_000)), "42.5M in (40.3M read, 2.2M written) / 1.2M out");
  assert.equal(tokenLine(t(20_000, 2_200_000, 40_300_000, 1_200_000, { h1: 1_000_000, m5: 0 })), "42.5M in (40.3M read, 2.2M written) / 1.2M out");
});

test("no writes (a Codex pass): only what was read", () => {
  assert.equal(tokenLine(t(500, 0, 9_000, 40)), "10k in (9k read) / 40 out");
});

test("a sum of a split figure and an unsplit one prints plain written", () => {
  const sum = addTokens(allHour, t(0, 100_000, 0, 0));
  assert.equal(tokenLine(sum), "42.6M in (40.3M read, 2.3M written) / 1.2M out");
});

test("a figure that wrote nothing keeps the split: NO_TOKENS and a Codex pass are neutral", () => {
  const sum = addTokens(addTokens(NO_TOKENS, allHour), t(1_000, 0, 9_000, 10));
  assert.equal(tokenLine(sum), "42.5M in (40.3M read, 2.2M written 1h) / 1.2M out");
});

test("a figure that carries only one count treats the other as 0", () => {
  const sum = addTokens(t(0, 1_000_000, 0, 0, { h1: 1_000_000 }), t(0, 500_000, 0, 0, { m5: 500_000 }));
  assert.equal(tokenLine(sum), "1.5M in (0 read, 1.5M written, 1.0M of it 1h) / 0 out");
});

const RUN = "2026-11-11T06:41:00.000Z";
const line = (o: object) => JSON.stringify({ ts: "2026-11-11T07:00:00.000Z", project: "demo", issue: "1", ms: 1000, ok: true, run: RUN, ...o });

test("tokensFromTimings: two split lines keep the split, a new line and an old one give a total with no split", () => {
  const split = [
    line({ phase: "implement", model: "model-one", tokens: t(10_000, 1_000_000, 20_000_000, 600_000, { h1: 1_000_000, m5: 0 }) }),
    line({ phase: "review", model: "model-two", tokens: t(10_000, 1_200_000, 20_300_000, 600_000, { h1: 0, m5: 1_200_000 }) }),
  ];
  const both = tokensFromTimings(split.join("\n"), RUN);
  assert.equal(tokenLine(both!.total), "42.5M in (40.3M read, 2.2M written, 1.0M of it 1h) / 1.2M out");
  assert.equal(tokenLine(both!.byModel["model-one"]), "21.0M in (20.0M read, 1.0M written 1h) / 600k out");

  const hours = [split[0], line({ phase: "review", model: "model-one", tokens: t(0, 1_200_000, 20_300_000, 600_000, { h1: 1_200_000 }) })];
  assert.equal(tokenLine(tokensFromTimings(hours.join("\n"), RUN)!.total), "42.5M in (40.3M read, 2.2M written 1h) / 1.2M out");

  // An older kit's line: the four counts only.
  const old = line({ phase: "review", model: "model-one", tokens: t(10_000, 1_200_000, 20_300_000, 600_000) });
  const mixed = tokensFromTimings([split[0], old].join("\n"), RUN)!;
  assert.equal(tokenLine(mixed.total), "42.5M in (40.3M read, 2.2M written) / 1.2M out");
  assert.equal(mixed.total.cacheWrite1h, undefined);
  assert.equal(mixed.total.cacheWrite5m, undefined);
});

test("tokensFromTimings reads a split count that is not a number as no split", () => {
  const odd = line({ phase: "review", tokens: { ...t(0, 2_000, 0, 0), cacheWrite1h: "2000", cacheWrite5m: null } });
  assert.equal(tokenLine(tokensFromTimings(odd, RUN)!.total), "2k in (0 read, 2k written) / 0 out");
});

const facts = (over: Partial<Facts>): Facts => ({
  base: "main",
  tracker: "github",
  started: RUN,
  finished: "2026-11-11T08:29:00.000Z",
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

test("the closing summary's headline and Tokens by model show the writes with their TTL", () => {
  const small = t(1_000, 10_000, 89_000, 5_000, { h1: 0, m5: 10_000 });
  const text = render(facts({ tokenTotal: addTokens(allHour, small), byModel: { "model-one": allHour, "model-two": small } }));
  assert.match(text, /tokens 42\.6M in \(40\.4M read, 2\.2M written, 2\.2M of it 1h\) \/ 1\.2M out/);
  const byModel = text.split("\n").find((l) => l.startsWith("Tokens by model:"));
  assert.equal(byModel, "Tokens by model: model-one 42.5M in (40.3M read, 2.2M written 1h) / 1.2M out · model-two 100k in (89k read, 10k written 5m) / 5k out");
});

/** The usage a Claude agent reads from its stream's closing `result` line, as Sandcastle hands it to `runTokens`. */
const usageOf = (result: object) => {
  const events = implAgent().parseStreamLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", ...result }));
  const usage = events.find((e) => e.type === "usage");
  assert.ok(usage && usage.type === "usage", "a usage event");
  return runTokens({ iterations: [{ usage: usage.usage }] })!;
};

test("a result line's modelUsage split carries into the pass's tokens, subagents' models summed", () => {
  const tokens = usageOf({
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 9_000,
        cacheCreationInputTokens: 3_000,
        cacheCreationEphemeral1hInputTokens: 2_000,
        cacheCreationEphemeral5mInputTokens: 1_000,
      },
      "claude-haiku-5-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 500, cacheCreationEphemeral1hInputTokens: 500, cacheCreationEphemeral5mInputTokens: 0 },
    },
  });
  assert.deepEqual(tokens, { input: 110, cacheWrite: 3_500, cacheRead: 9_000, output: 55, cacheWrite1h: 2_500, cacheWrite5m: 1_000 });
  assert.equal(tokenLine(tokens), "13k in (9k read, 4k written, 3k of it 1h) / 55 out");
});

test("a result line with only cacheCreationEphemeral1hInputTokens reads as all 1h", () => {
  const tokens = usageOf({ modelUsage: { m: { inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 4_000, cacheCreationEphemeral1hInputTokens: 4_000 } } });
  assert.equal(tokenLine(tokens), "4k in (0 read, 4k written 1h) / 1 out");
});

test("a result line with only usage.cache_creation carries its split", () => {
  const tokens = usageOf({
    usage: {
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 6_000,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 6_000 },
    },
  });
  assert.deepEqual(tokens, { input: 7, cacheWrite: 6_000, cacheRead: 2_000, output: 3, cacheWrite1h: 0, cacheWrite5m: 6_000 });
  assert.equal(tokenLine(tokens), "8k in (2k read, 6k written 5m) / 3 out");
});

test("a result line with no split gives tokens with none, printed as plain written", () => {
  const tokens = usageOf({ usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 6_000 } });
  assert.deepEqual(tokens, { input: 7, cacheWrite: 6_000, cacheRead: 2_000, output: 3 });
  assert.equal(tokenLine(tokens), "8k in (2k read, 6k written) / 3 out");
});
