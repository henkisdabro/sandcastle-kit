// The tokens an agent pass spent when it threw, or when a review fell back to another model: the step timer keeps what the
// usage watch read of the pass's stream (marked incomplete, or unknown when the stream showed none), and counts a pass that
// ended normally by its result's figure only. Temp directories only; no Docker, no model.
//
//   pnpm test:file test/tokens-thrown-pass.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-thrown-tokens-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
after(() => rmSync(TMP, { recursive: true, force: true }));
const { agentLog, agentLogging, createTokenCount, liveTokenWriter, logOwner, rawLog, recordRun, runTokens, tokensNoteWords } = await import("../src/run.ts");
const { watchUsage } = await import("../src/usage.ts");
const { render, tokenNoteLines } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;

// Not under TMP: the record is finished by an exit handler, which writes it once more after the cleanup above.
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-thrown-tokens-record-"));
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  return { root, name: "fixture" } as Project;
};

const message = (id: string, usage: { input: number; cacheWrite: number; cacheRead: number; output: number }) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite, cache_read_input_tokens: usage.cacheRead, output_tokens: usage.output },
    },
  });

/** One agent pass writing its raw stream through the kit's own `agentLogging`. */
const pass = (p: Project, id: string, name: string) => {
  const logging = agentLogging(p, id, name, "run-1") as { onAgentStreamEvent: (e: unknown) => void };
  return {
    file: rawLog(agentLog(p, id, name)),
    say(...lines: string[]) {
      for (const line of lines) logging.onAgentStreamEvent({ type: "raw", line, iteration: 1, timestamp: new Date() });
    },
  };
};

/** What a library result carries of one iteration's usage: the figure `runTokens` reads. */
const result = (u: { input: number; cacheWrite: number; cacheRead: number; output: number }) => ({
  iterations: [{ usage: { inputTokens: u.input, cacheCreationInputTokens: u.cacheWrite, cacheReadInputTokens: u.cacheRead, outputTokens: u.output } }],
});

// By hand: A in = 100 + 4000 + 1,000,000 = 1,004,100 ("1.0M"), out 800; B in = 50 + 1,200,000 ("1.2M"), out 1500;
// A + B in = 2,204,150 ("2.2M"), out 2300 ("2k").
const A = { input: 100, cacheWrite: 4000, cacheRead: 1_000_000, output: 800 };
const B = { input: 50, cacheWrite: 0, cacheRead: 1_200_000, output: 1500 };

/**
 * A run record, a usage watch and the run's token count wired as `burndown()` wires them, and `step`: what its `timed` does
 * with a step's function (the result's figure, then the settle in the `finally`; a source test below holds the wiring).
 */
const running = (p: Project) => {
  const record = recordRun(p, {});
  const clock = { ms: 1_000_000 };
  let watch: ReturnType<typeof watchUsage> | undefined;
  const count = createTokenCount(record, (issue) => watch?.settle(issue));
  watch = watchUsage({
    logs: join(p.root, ".sandcastle/logs"),
    run: "run-1",
    now: () => clock.ms,
    write: () => assert.fail("no plan usage in these logs"),
    tokens: { owner: logOwner, write: liveTokenWriter(record, count.spent, count.noteOf) },
  });
  after(() => watch?.stop());
  const file = () => JSON.parse(readFileSync(join(p.root, ".sandcastle/logs/run.json"), "utf8"));
  const ticket = (id: string) => file().tickets?.[id] as { tokens?: string; tokensNote?: string } | undefined;
  const step = async <T>(issue: string, fn: () => Promise<T> | T) => {
    let counted = false;
    try {
      const res = await fn();
      const tokens = runTokens(res);
      if (tokens) {
        count.ended(issue, tokens);
        counted = true;
      }
      return res;
    } finally {
      lines.push(count.settled(issue, counted));
    }
  };
  const lines: ReturnType<typeof count.settled>[] = [];
  return { record, watch, clock, count, ticket, run: () => file() as { tokens?: string; tokensNote?: string }, step, lines };
};

test("a pass that threw after its stream showed usage keeps that usage, marked incomplete, in the ticket's and the run's tokens", async () => {
  const p = project();
  const { record, step, ticket, run, lines } = running(p);
  record.ticket("7", { state: "implement" });
  await assert.rejects(
    step("7", () => {
      pass(p, "7", "impl-7").say(message("msg_a", A));
      throw new Error("claude-code exited with code 1");
    }),
    /exited with code 1/,
  );
  assert.deepEqual([ticket("7")?.tokens, ticket("7")?.tokensNote], ["1.0M in / 800 out", "incomplete"]);
  assert.deepEqual([run().tokens, run().tokensNote], ["1.0M in / 800 out", "incomplete"]);
  assert.deepEqual(lines[0], { kept: A, note: "incomplete", peakContext: 1_004_100 }, "the timings line gets the figure too");
});

test("a pass that threw before its stream showed any usage is unknown, not zero", async () => {
  const p = project();
  const { record, step, ticket, run, lines } = running(p);
  record.ticket("7", { state: "implement" });
  await assert.rejects(
    step("7", () => {
      pass(p, "7", "impl-7").say("not a usage line");
      throw new Error("timed out");
    }),
    /timed out/,
  );
  assert.equal(ticket("7")?.tokens, undefined, "no figure, so no 0 in / 0 out");
  assert.equal(ticket("7")?.tokensNote, "unknown");
  assert.equal(run().tokens, undefined);
  assert.equal(run().tokensNote, "unknown");
  assert.deepEqual(lines[0], { note: "unknown" });
});

test("a review that threw and its fallback are two spends, each counted once", async () => {
  const p = project();
  const { record, step, ticket, run } = running(p);
  record.ticket("7", { state: "review" });
  await step("7", async () => {
    // The first model's review, which threw; `reviewWithFallback` then runs the same step again under the same log name.
    pass(p, "7", "review-7").say(message("msg_a", A));
    const fallback = pass(p, "7", "review-7");
    fallback.say(message("msg_b", B));
    return result(B);
  });
  assert.deepEqual([ticket("7")?.tokens, ticket("7")?.tokensNote], ["2.2M in / 2k out", "incomplete"]);
  assert.equal(run().tokens, "2.2M in / 2k out");
  assert.equal(run().tokensNote, "incomplete");
});

test("a failed pass's usage shows live beside the pass that retried it", async () => {
  const p = project();
  const { record, watch, clock, ticket } = running(p);
  record.ticket("7", { state: "review" });
  pass(p, "7", "review-7").say(message("msg_a", A));
  pass(p, "7", "review-7").say(message("msg_b", B));
  clock.ms += 60_000;
  watch.poll();
  assert.equal(ticket("7")?.tokens, "2.2M in / 2k out");
});

test("a cross-review that failed and was swallowed is one spend, unknown when its stream showed no usage", async () => {
  const p = project();
  const { record, step, ticket } = running(p);
  record.ticket("7", { state: "review" });
  // The implementer's and reviewer's tokens, counted by their results.
  await step("7", () => {
    pass(p, "7", "review-7").say(message("msg_a", A));
    return result(A);
  });
  assert.deepEqual([ticket("7")?.tokens, ticket("7")?.tokensNote], ["1.0M in / 800 out", undefined]);
  // `crossReview` catches the failure and returns undefined: the step ends normally with no figure.
  record.ticket("7", { state: "cross-review" });
  await step("7", () => {
    pass(p, "7", "review-codex-7").say("codex stream: no assistant lines");
    return undefined;
  });
  assert.deepEqual([ticket("7")?.tokens, ticket("7")?.tokensNote], ["1.0M in / 800 out", "incomplete"], "a floor now: the failed pass may have spent more");
});

test("a pass that ended normally is counted by its result's figure and not again from its log", async () => {
  const p = project();
  const { record, step, ticket, run, lines } = running(p);
  record.ticket("7", { state: "implement" });
  await step("7", () => {
    pass(p, "7", "impl-7").say(message("msg_a", A));
    return result(A);
  });
  assert.deepEqual([ticket("7")?.tokens, ticket("7")?.tokensNote], ["1.0M in / 800 out", undefined]);
  assert.deepEqual([run().tokens, run().tokensNote], ["1.0M in / 800 out", undefined]);
  assert.equal(lines[0].kept, undefined);
  assert.equal(lines[0].note, undefined);
  assert.equal(lines[0].peakContext, 1_004_100, "its largest context is still reported");
});

test("a step with no agent pass settles to nothing", async () => {
  const p = project();
  const { record, step, ticket } = running(p);
  record.ticket("7", { state: "gates" });
  await step("7", () => ({ ok: true }));
  assert.equal(ticket("7")?.tokens, undefined);
  assert.equal(ticket("7")?.tokensNote, undefined);
});

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

test("the closing summary words an incomplete figure and an unknown one", () => {
  const incomplete = render(facts({ tokens: "1.0M in / 800 out", tokensNote: "incomplete", tickets: { "7": { tokensNote: "incomplete", title: "Seven" }, "8": { tokensNote: "unknown" } } }));
  assert.match(incomplete, /tokens 1\.0M in \/ 800 out \(incomplete\)/);
  assert.match(incomplete, /Tokens: incomplete for #7 \(a pass that failed may have spent more than its log showed\); unknown for #8 \(a pass failed before its log showed any usage\)/);
  assert.match(render(facts({ tokensNote: "unknown" })), /tokens unknown/);
  assert.doesNotMatch(render(facts({ tokens: "1.0M in / 800 out" })), /incomplete|unknown/);
  assert.deepEqual(tokenNoteLines({ tickets: { "7": {} } }), []);
});

test("tokensNoteWords is empty for a figure without a note", () => {
  assert.equal(tokensNoteWords(undefined), "");
  assert.match(tokensNoteWords("incomplete"), /^incomplete/);
  assert.match(tokensNoteWords("unknown"), /^unknown/);
});

// burndown() needs Docker, so no test drives it: the wiring `step` above stands in for is held by its source.
test("burndown's step timer counts a result, then settles the ticket's passes against it, and keeps a failed pass's figure", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const timed = src.slice(src.indexOf("const timed = "), src.indexOf("const image = await timed("));
  assert.match(timed, /count\.ended\(issue, tokens\);\s+counted = true;/);
  assert.match(timed, /const \{ peakContext, kept, note: tokensNote \} = count\.settled\(issue, counted\);/);
  assert.match(timed, /\.\.\.\(tokens \|\| kept \? \{ tokens: addTokens\(tokens \?\? NO_TOKENS, kept \?\? NO_TOKENS\) \} : \{\}\),/, "the timings line carries the kept figure");
  assert.match(timed, /\.\.\.\(tokensNote \? \{ tokensNote \} : \{\}\),/);
  assert.match(src, /liveTokenWriter\(run, spent, count\.noteOf\)/);
});
