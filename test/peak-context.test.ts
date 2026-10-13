// A pass's peak context per turn: the usage watch keeps the largest input + cache write + cache read of one
// assistant message, `settle` hands it to the run (the timings line's and the ticket record's `peakContext`),
// and the closing summary flags a ticket with a pass over the threshold. Temp directories only; no Docker, no model.
//
//   pnpm test:file test/peak-context.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-peak-context-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
after(() => rmSync(TMP, { recursive: true, force: true }));
const { agentLogging, logOwner, peakContexts } = await import("../src/run.ts");
const { PEAK_CONTEXT_WARN, watchUsage } = await import("../src/usage.ts");
const { render } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;

const project = () => {
  const root = mkdtempSync(join(TMP, "project-"));
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  return { root, name: "fixture" } as Project;
};

const message = (id: string, input: number, cacheWrite: number, cacheRead: number, blocks = 1) =>
  Array.from({ length: blocks }, () =>
    JSON.stringify({
      type: "assistant",
      message: { id, content: [{ type: "text", text: "x" }], usage: { input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: 9 } },
    }),
  );

const pass = (p: Project, id: string, name: string, run: string) => {
  const logging = agentLogging(p, id, name, run) as { onAgentStreamEvent: (e: unknown) => void };
  return {
    say(...lines: string[]) {
      for (const line of lines) logging.onAgentStreamEvent({ type: "raw", line, iteration: 1, timestamp: new Date() });
    },
  };
};

const watching = (p: Project) => {
  const watch = watchUsage({
    logs: join(p.root, ".sandcastle/logs"),
    run: "run-1",
    write: () => assert.fail("no plan usage in these logs"),
    tokens: { owner: logOwner, write: () => {} },
  });
  after(() => watch.stop());
  return watch;
};

test("a pass's peak context is the largest input + cache write + cache read of one message, not their sum over the pass", () => {
  const p = project();
  const watch = watching(p);
  const impl = pass(p, "7", "impl-7", "run-1");
  // By hand: 27,000 (a), 452,300 = 300 + 2,000 + 450,000 (b, on three lines), 120,000 (c, a later and smaller turn).
  impl.say(...message("msg_a", 1000, 6000, 20_000), ...message("msg_b", 300, 2000, 450_000, 3), ...message("msg_c", 10, 0, 119_990));
  assert.equal(watch.settle("7").peakContext, 452_300);
});

test("settle gives each pass its own peak, and none for a ticket whose pass showed no message", () => {
  const p = project();
  const watch = watching(p);
  pass(p, "7", "impl-7", "run-1").say(...message("msg_a", 0, 0, 90_000));
  assert.equal(watch.settle("7").peakContext, 90_000);
  pass(p, "7", "review-7", "run-1").say(...message("msg_b", 0, 0, 40_000));
  assert.equal(watch.settle("7").peakContext, 40_000, "the review pass does not inherit the implement pass's peak");
  assert.equal(watch.settle("7").peakContext, undefined, "nothing since");
  assert.equal(watch.settle("8").peakContext, undefined);
});

test("a message from another run's pass in the same log is not this run's peak", () => {
  const p = project();
  const watch = watching(p);
  pass(p, "7", "impl-7", "run-0").say(...message("msg_old", 0, 0, 300_000));
  pass(p, "7", "impl-7", "run-1").say(...message("msg_new", 0, 0, 50_000));
  assert.equal(watch.settle("7").peakContext, 50_000);
});

test("a ticket's record keeps the largest peak of each kind of pass", () => {
  const first = peakContexts(undefined, "implement", 452_000);
  assert.deepEqual(first, { implement: 452_000 });
  const second = peakContexts(first, "repair", 30_000);
  assert.deepEqual(peakContexts(second, "repair", 20_000), { implement: 452_000, repair: 30_000 });
  assert.deepEqual(peakContexts(second, "repair", 160_000), { implement: 452_000, repair: 160_000 });
});

// burndown() needs Docker, so no test drives it: the wiring is held by its source.
test("burndown writes the peak to the timings line and the ticket's record from the step that settles the pass", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const timed = src.slice(src.indexOf("const timed = "), src.indexOf("const image = await timed("));
  assert.match(timed, /const \{ peakContext, kept, note: tokensNote \} = count\.settled\(issue, counted\);/);
  assert.match(timed, /run\.ticket\(issue, \{ peakContext: peakContexts\(run\.tickets\(\)\[issue\]\?\.peakContext, phase, peakContext\) \}\)/);
  assert.match(timed, /\.\.\.\(peakContext \? \{ peakContext \} : \{\}\),/, "on the timings line");
  assert.ok(timed.lastIndexOf("finally {", timed.indexOf("count.settled(issue")) > 0, "in the `finally`, so a pass that threw has its peak too");
});

const facts = (tickets: Facts["tickets"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
});

test("the closing summary flags a ticket with a pass over the threshold, naming the pass and the peak", () => {
  assert.equal(PEAK_CONTEXT_WARN, 150_000);
  const text = render(facts({ "7": { state: "merged", title: "Big ticket", peakContext: { implement: 452_000, review: 90_000, repair: 160_000 } } }), true);
  const line = text.split("\n").find((l) => l.includes("Large context"));
  assert.ok(line, text);
  assert.match(line, /#7 Big ticket/);
  assert.match(line, /implement pass reached 452k tokens/);
  assert.match(line, /repair pass reached 160k tokens/);
  assert.doesNotMatch(line, /review/);
});

test("the closing summary does not flag a ticket whose passes stayed at or under the threshold", () => {
  const text = render(facts({ "7": { state: "merged", title: "Small", peakContext: { implement: 150_000, review: 20_000 } }, "8": { state: "merged", title: "Old record" } }), true);
  assert.doesNotMatch(text, /Large context/);
});
