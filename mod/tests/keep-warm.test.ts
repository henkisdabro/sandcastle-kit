// Run with `claude plugin test mod`: the cache refresh while a run this session started is live -
// a tick past 55 minutes of silence sends one `$.model.fork` and redraws the band's row; no live
// run, a run switched off, a 5-minute cache or a second miss send nothing. The clock, the process
// runner, the usage and the fork are answered by the test: no session, no model.

import { expect, mock, test, type TestBody } from "claude-code/testing";

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const RESULT = { stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
const START = { surface: "terminal", isInteractive: true, cwd: "/work" } as const;
const SKILL = { skill: "sandcastle", text: "the skill" };
const ENDED = { durationMs: 1000, isAborted: false, turnId: "turn-1", reason: "answer" } as const;
const BAND = {
  plugin: "sandcastle",
  component: "AbovePrompt",
  requestId: "band",
  viewport: { columns: 120, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const;
const HIT = { isAnswered: true, text: "ok", usage: { input_tokens: 16, output_tokens: 40, cache_read_input_tokens: 157725, cache_creation_input_tokens: 0 } };
const MISS = { isAnswered: true, text: "ok", usage: { input_tokens: 157000, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 157000 } };

/** A set-up project whose run, started by this session, is alive (or not), with the fork and the plan's windows the test sets. */
const world = (on: Parameters<TestBody>[1], opts: { alive?: boolean; keepWarm?: boolean } = {}) => {
  const w = {
    clock: mock.clock(on, { now: T0 }),
    forks: [] as string[],
    answers: [HIT] as unknown[],
    rateLimits: [{ kind: "five_hour", percentUsed: 30, resetsAt: "2026-10-10T12:00:00.000Z" }] as { kind: string; percentUsed: number; resetsAt: string }[],
    logs: [] as string[],
    store: new Map<string, unknown>(),
  };
  const record = JSON.stringify({
    orchestrator: "demo",
    pid: 42,
    session: "session-1",
    startedAt: new Date(T0).toISOString(),
    settings: opts.keepWarm === undefined ? {} : { keepWarm: opts.keepWarm },
    tickets: { 1: { state: "implementing" } },
  });
  on("session.start", () => ({ cwd: "/work" }));
  on("classic.SessionStart", () => ({}));
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "session-1" }));
  on("session.usage", () => ({ value: { context: { tokens: 157094, window: 1000000, percent: 15 }, rateLimits: w.rateLimits, cost: {} } }));
  on("model.fork", ($, e) => {
    w.forks.push(String(e.prompt));
    return { value: w.answers.length > 1 ? w.answers.shift() : w.answers[0] };
  });
  on("fs.exists", () => ({ value: true }));
  on("fs.stat", () => ({ value: { kind: "file", size: 1, mtimeMs: 0, isLink: false } }));
  on("fs.read", () => ({ value: record }));
  on("process.run", ($, e) => ({ value: { exitCode: e.argv[0] === "ps" && opts.alive === false ? 1 : 0, stdout: e.argv[0] === "ps" ? "node /kit/src/cli.ts run" : "", ...RESULT } }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("store.get", ($, e) => ({ value: w.store.get(e.key) }));
  on("store.set", ($, e) => (w.store.set(e.key, e.value), { value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.status", () => ({ value: undefined }));
  on("ui.log", ($, e) => (w.logs.push(String(e.text)), { value: undefined }));
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("skill.prompt", ($, e) => ({ text: e.text }));
  on("turn.complete", ($, e) => ({ text: e.answer }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
  return w;
};

/** The cache row the band draws now, or undefined. */
const rowNow = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  const row = (await ui.findAll({ type: "Text", text: /^cache / }))[0];
  await ui.unmount();
  return row?.text;
};

/** The session starts, uses the skill (so it closes the run) and lets the first look and tick pass. */
const begin = async ($: Parameters<TestBody>[0], w: ReturnType<typeof world>) => {
  await $.session.start(START);
  await $.skill.prompt(SKILL);
  await w.clock.advance(5000);
};

test("a tick past 55 minutes of silence refreshes the cache once and redraws the row", async ($, on) => {
  const w = world(on);
  await begin($, w);
  expect(w.forks).toEqual([]);
  expect(await rowNow($)).toMatch(/^cache warm · refresh in \d+m$/);
  await w.clock.advance(55 * MIN);
  expect(w.forks).toEqual(["Reply with the single word: ok"]);
  expect(await rowNow($)).toMatch(/^cache refreshed \d\d:\d\d · 158k read$/);
  // The next refresh is 55 minutes after this one, not at every tick.
  await w.clock.advance(30 * MIN);
  expect(w.forks.length).toBe(1);
});

test("a subagent's turn ending does not put the refresh off", async ($, on) => {
  const w = world(on);
  await begin($, w);
  await w.clock.advance(40 * MIN);
  await $.turn.complete({ ...ENDED, answer: "a subagent", agentId: "agent-1" });
  await w.clock.advance(16 * MIN);
  expect(w.forks.length).toBe(1);
});

test("a turn of the main thread restarts the 55 minutes", async ($, on) => {
  const w = world(on);
  await begin($, w);
  await w.clock.advance(40 * MIN);
  await $.turn.complete({ ...ENDED, answer: "checked in" });
  await w.clock.advance(30 * MIN);
  expect(w.forks.length).toBe(0);
  await w.clock.advance(30 * MIN);
  expect(w.forks.length).toBe(1);
});

test("no live run, no call", async ($, on) => {
  const w = world(on, { alive: false });
  await begin($, w);
  await w.clock.advance(3 * 60 * MIN);
  expect(w.forks).toEqual([]);
  expect(await rowNow($)).toBeUndefined();
});

test("a run recorded with keepWarm false is never refreshed", async ($, on) => {
  const w = world(on, { keepWarm: false });
  await begin($, w);
  await w.clock.advance(3 * 60 * MIN);
  expect(w.forks).toEqual([]);
  expect(await rowNow($)).toBeUndefined();
});

test("overage leaves the cache to lapse and the row says so", async ($, on) => {
  const w = world(on);
  w.rateLimits = [{ kind: "spend_limit", percentUsed: 100, resetsAt: "2026-10-10T12:00:00.000Z" }];
  await begin($, w);
  await w.clock.advance(3 * 60 * MIN);
  expect(w.forks).toEqual([]);
  expect(await rowNow($)).toBe("cache 5m · not warmed (a cold restart costs less)");
});

test("a refresh that finds the cache lapsed is not repeated; a turn earns one more try, and a second miss ends them", async ($, on) => {
  const w = world(on);
  w.answers = [MISS];
  await begin($, w);
  await w.clock.advance(56 * MIN);
  expect(w.forks.length).toBe(1);
  expect(await rowNow($)).toBe("cache 5m · not warmed (a cold restart costs less)");
  await w.clock.advance(2 * 60 * MIN);
  expect(w.forks.length).toBe(1);
  await $.turn.complete({ ...ENDED, answer: "back" });
  await w.clock.advance(56 * MIN);
  expect(w.forks.length).toBe(2);
  await $.turn.complete({ ...ENDED, answer: "back again" });
  await w.clock.advance(3 * 60 * MIN);
  expect(w.forks.length).toBe(2);
  expect(await rowNow($)).toBeUndefined();
});

test("a fork that is not answered is logged and counted as a miss", async ($, on) => {
  const w = world(on);
  w.answers = [{ isAnswered: false, reason: "api-error" }];
  await begin($, w);
  await w.clock.advance(56 * MIN);
  expect(w.forks.length).toBe(1);
  expect(w.logs.length).toBe(1);
  expect(w.logs[0]).toContain("api-error");
  await w.clock.advance(2 * 60 * MIN);
  expect(w.forks.length).toBe(1);
});
