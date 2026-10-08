// A ticket's tokens in run.json while its pass runs: the usage watch reads the assistant messages of the
// pass's agent log and the run adds them to what the ticket's finished passes spent, on the usage row's tick,
// so the status view's TOKENS column only reads the record. Temp directories only; no Docker, no model.
//
//   pnpm test:file test/ticket-live-tokens.test.ts

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";
import type { Tokens } from "../src/run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-live-tokens-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
after(() => rmSync(TMP, { recursive: true, force: true }));
const { agentLog, agentLogging, liveTokenWriter, logOwner, rawLog, recordRun, tokenBrief, addTokens, NO_TOKENS } = await import("../src/run.ts");
const { watchUsage } = await import("../src/usage.ts");

// Not under TMP: the record is finished by an exit handler, which writes it once more after the cleanup above.
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-live-tokens-record-"));
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  return { root, name: "fixture" } as Project;
};

/** What Claude Code's stream carries for one assistant message: a line for each content block, each with the message's usage. */
const message = (id: string, usage: { input: number; cacheWrite: number; cacheRead: number; output: number }, blocks = 1) =>
  Array.from({ length: blocks }, () =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite, cache_read_input_tokens: usage.cacheRead, output_tokens: usage.output },
      },
    }),
  );

/** One agent pass writing its raw stream through the kit's own `agentLogging`. */
const pass = (p: Project, id: string, name: string, run: string) => {
  const logging = agentLogging(p, id, name, run) as { onAgentStreamEvent: (e: unknown) => void };
  const file = rawLog(agentLog(p, id, name));
  return {
    file,
    say(...lines: string[]) {
      for (const line of lines) logging.onAgentStreamEvent({ type: "raw", line, iteration: 1, timestamp: new Date() });
    },
  };
};

/** A run record, the figures the run counts itself, and a watch wired as the run wires it, on a clock the test moves. */
const running = (p: Project, run = "run-1") => {
  const record = recordRun(p, {});
  const spent = new Map<string, Tokens>();
  const clock = { ms: 1_000_000 };
  const watch = watchUsage({
    logs: join(p.root, ".sandcastle/logs"),
    run,
    now: () => clock.ms,
    write: () => assert.fail("no plan usage in these logs"),
    tokens: { owner: logOwner, write: liveTokenWriter(record, spent) },
  });
  after(() => watch.stop());
  const tokens = (id: string) => (JSON.parse(readFileSync(join(p.root, ".sandcastle/logs/run.json"), "utf8")).tickets?.[id] as { tokens?: string } | undefined)?.tokens;
  /** What `timed` does when a pass returns with its result's own figure. */
  const finish = (id: string, result: Tokens) => {
    watch.settle(id);
    spent.set(id, addTokens(spent.get(id) ?? NO_TOKENS, result));
    record.ticket(id, { tokens: tokenBrief(spent.get(id)!) });
  };
  return { record, watch, clock, tokens, finish };
};

// By hand: in = 100 + 4000 + 1,000,000 (message a) + 50 + 0 + 1,200,000 (message b) = 2,204,150; out = 800 + 1500 = 2300.
const A = { input: 100, cacheWrite: 4000, cacheRead: 1_000_000, output: 800 };
const B = { input: 50, cacheWrite: 0, cacheRead: 1_200_000, output: 1500 };

test("a running pass's tokens are in the ticket's record within one tick, a message counted once however many lines it has", () => {
  const p = project();
  const { record, watch, tokens } = running(p);
  record.ticket("7", { state: "implement" });
  const impl = pass(p, "7", "impl-7", "run-1");
  watch.poll();
  assert.equal(tokens("7"), undefined, "nothing to show before the first message");
  // Message a is written as three lines (a text block and two tool calls), each with its usage.
  impl.say(...message("msg_a", A, 3), ...message("msg_b", B));
  watch.poll();
  assert.equal(tokens("7"), "2.2M in / 2k out");
  assert.equal(JSON.parse(readFileSync(join(p.root, ".sandcastle/logs/run.json"), "utf8")).tickets["7"].state, "implement", "the ticket's state is as it was");
});

test("the figure is rewritten no more often than the interval, and carries what the pass spent since", () => {
  const p = project();
  const { record, watch, clock, tokens } = running(p);
  record.ticket("7", { state: "implement" });
  const impl = pass(p, "7", "impl-7", "run-1");
  impl.say(...message("msg_a", A));
  watch.poll();
  assert.equal(tokens("7"), "1.0M in / 800 out");
  clock.ms += 5_000;
  impl.say(...message("msg_b", B));
  watch.poll();
  assert.equal(tokens("7"), "1.0M in / 800 out", "5 s on: too soon to write");
  clock.ms += 15_000;
  watch.poll();
  assert.equal(tokens("7"), "2.2M in / 2k out", "the tick after it");
});

test("a pass that has ended is counted by its result's figure and not again from its log", () => {
  const p = project();
  const { record, watch, clock, tokens, finish } = running(p);
  record.ticket("7", { state: "implement" });
  const impl = pass(p, "7", "impl-7", "run-1");
  impl.say(...message("msg_a", A));
  watch.poll();
  // The pass writes its last message, and returns before the watch has looked at it.
  impl.say(...message("msg_b", B));
  finish("7", { input: 100 + 50, cacheWrite: 4000, cacheRead: 2_200_000, output: 2300 });
  assert.equal(tokens("7"), "2.2M in / 2k out");
  clock.ms += 60_000;
  watch.poll();
  watch.poll(true);
  assert.equal(tokens("7"), "2.2M in / 2k out", "not 4.4M: the ended pass's lines no longer count");
  // The next pass, in another log, starts from what the first one cost.
  record.ticket("7", { state: "review" });
  const review = pass(p, "7", "review-7", "run-1");
  review.say(...message("msg_c", { input: 10, cacheWrite: 0, cacheRead: 300_000, output: 500 }));
  clock.ms += 60_000;
  watch.poll();
  assert.equal(tokens("7"), "2.5M in / 3k out");
  // When it ends, its figure replaces what the log showed.
  finish("7", { input: 10, cacheWrite: 0, cacheRead: 300_000, output: 500 });
  clock.ms += 60_000;
  watch.poll(true);
  assert.equal(tokens("7"), "2.5M in / 3k out");
});

test("a second pass in the same log starts from nothing, and an earlier run's lines are not this run's", () => {
  const p = project();
  const old = pass(p, "7", "impl-7", "run-0");
  old.say(...message("msg_old", { input: 1, cacheWrite: 0, cacheRead: 9_000_000, output: 9 }));
  const { record, watch, clock, tokens, finish } = running(p);
  record.ticket("7", { state: "implement" });
  const first = pass(p, "7", "impl-7", "run-1");
  first.say(...message("msg_a", A));
  watch.poll();
  assert.equal(tokens("7"), "1.0M in / 800 out", "the earlier run's 9M is not counted");
  finish("7", A);
  // A requeued ticket's second attempt writes the same file again, under a new marker.
  const again = pass(p, "7", "impl-7", "run-1");
  again.say(...message("msg_b", B));
  clock.ms += 60_000;
  watch.poll();
  assert.equal(tokens("7"), "2.2M in / 2k out", "the first attempt once, the second as it runs");
});

test("each ticket has its own figure, and a log that belongs to no ticket has none", () => {
  const p = project();
  const { record, watch, tokens } = running(p);
  record.ticket("7", { state: "implement" });
  record.ticket("helpers-01", { state: "implement" });
  pass(p, "7", "impl-7", "run-1").say(...message("msg_a", A));
  pass(p, "helpers-01", "impl-helpers-01", "run-1").say(...message("msg_b", B));
  appendFileSync(join(p.root, ".sandcastle/logs/agent-issue-notes.jsonl"), JSON.stringify({ sandcastle: "run", run: "run-1" }) + "\n" + message("msg_z", A)[0] + "\n");
  watch.poll();
  assert.equal(tokens("7"), "1.0M in / 800 out");
  assert.equal(tokens("helpers-01"), "1.2M in / 2k out");
  assert.equal(tokens("notes"), undefined);
});

test("a record the run has finished is not written to", () => {
  const p = project();
  const { record, watch, tokens } = running(p);
  record.ticket("7", { state: "implement" });
  pass(p, "7", "impl-7", "run-1").say(...message("msg_a", A));
  // The next turn's record finishes this one and replaces run.json.
  recordRun(p, {});
  watch.poll();
  assert.equal(tokens("7"), undefined);
});

// burndown() needs Docker, so no test drives it: the wiring the tests above stand in for (`running`, `finish`) is held by its source.
test("burndown starts the watch with or without a plan to show, and settles a ticket in the step that counts its pass's result", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const start = src.slice(src.indexOf("usageWatch = watchUsage({"));
  assert.match(start.slice(0, start.indexOf("});")), /tokens: \{ owner: logOwner, write: liveTokenWriter\(run, spent\) \}/);
  assert.match(src, /\n {2}usageWatch = watchUsage\(\{/, "at the run's own level");
  assert.doesNotMatch(src, /if \(planUsage\.length\) \{/, "not inside the plan usage row's `if`");
  const timed = src.slice(src.indexOf("const timed = "), src.indexOf("const image = await timed("));
  const counted = timed.indexOf("spent.set(issue, ");
  const settled = timed.indexOf("usageWatch?.settle(issue)");
  assert.ok(counted > 0 && settled > counted, "settled after the result's figure is in `spent`");
  assert.ok(timed.lastIndexOf("finally {", settled) > counted, "in the `finally`, so a pass that threw is settled too");
  assert.doesNotMatch(timed.slice(counted, settled), /\bawait\b/, "nothing a tick could interleave with between them");
});
