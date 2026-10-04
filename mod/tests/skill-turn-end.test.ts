// Run with `claude plugin test mod`: the idle mark's ready count is read when the sandcastle skill
// is used and again when that turn ends, since triaging labels tickets between the two. The clock,
// the process runner and the store are answered by the test: no session, no model, no tracker.

import { expect, mock, test, type TestBody } from "claude-code/testing";

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const queue = (...ids: string[]) => JSON.stringify(ids.map((id) => ({ id, title: `Ticket ${id}`, updated: null, blockedOn: [] })));
const RESULT = { stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
const START = { surface: "terminal", isInteractive: true, cwd: "/work" } as const;
const SKILL = { skill: "sandcastle", text: "the skill" };
const KEY = "ready:/work";

/** A set-up project with no run alive, a fresh entry, and a queue the test changes between reads. */
const world = (on: Parameters<TestBody>[1]) => {
  const w = {
    clock: mock.clock(on, { now: T0 }),
    out: queue("1"),
    reads: 0,
    store: new Map<string, unknown>([[KEY, { at: T0 - MIN, ids: ["1"], ok: true, tried: T0 - MIN }]]),
  };
  on("session.start", () => ({ cwd: "/work" }));
  on("classic.SessionStart", () => ({}));
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "session-1" }));
  on("fs.exists", () => ({ value: true }));
  on("fs.stat", ($, e) => ({ value: { kind: "file", size: 1, mtimeMs: 0, isLink: false, realPath: String(e.path) === "/kit/mod" ? "/kit/mod" : undefined } }));
  on("fs.read", () => ({ value: JSON.stringify({ orchestrator: "demo", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", tickets: { 1: { state: "merged" } }, finishedAt: "2026-01-01T01:00:00.000Z", exitCode: 0 }) }));
  on("process.run", async ($, e) => {
    if (e.argv.includes("queue")) {
      w.reads += 1;
      return { value: { exitCode: 0, stdout: w.out, ...RESULT } };
    }
    return { value: { exitCode: e.argv[0] === "ps" ? 1 : 0, stdout: "", ...RESULT } };
  });
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("store.get", ($, e) => ({ value: w.store.get(e.key) }));
  on("store.set", ($, e) => (w.store.set(e.key, e.value), { value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.status", () => ({ value: undefined }));
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("skill.prompt", ($, e) => ({ text: e.text }));
  on("turn.complete", ($, e) => ({ text: e.answer }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
  return w;
};

test("the skill's turn ending reads the count again, after the labelling the turn did", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  await $.skill.prompt(SKILL);
  // The look after the skill's start reads before the skill has labelled anything.
  await w.clock.advance(15000);
  expect(w.reads).toBe(1);
  expect(w.store.get(KEY)).toMatchObject({ ids: ["1"] });
  // The skill labels a ticket during its turn; the turn ends, and the next look reads it.
  w.out = queue("1", "2");
  await $.turn.complete({ answer: "labelled" });
  await w.clock.advance(15000);
  expect(w.reads).toBe(2);
  expect(w.store.get(KEY)).toMatchObject({ ids: ["1", "2"] });
});

test("a turn that did not use the skill reads nothing, and the skill's end is read once", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  await $.turn.complete({ answer: "an ordinary turn" });
  await w.clock.advance(15000);
  expect(w.reads).toBe(0);
  await $.skill.prompt(SKILL);
  await w.clock.advance(15000);
  await $.turn.complete({ answer: "done" });
  await w.clock.advance(15000);
  expect(w.reads).toBe(2);
  // Later turns of the session are not the skill's: the age rule alone decides again.
  await $.turn.complete({ answer: "another" });
  await w.clock.advance(15000);
  expect(w.reads).toBe(2);
});

test("a subagent's turn ending inside the skill's turn reads nothing; the skill's own end does", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  await $.skill.prompt(SKILL);
  await w.clock.advance(15000);
  expect(w.reads).toBe(1);
  // Triage reads tickets through subagents before it labels: their ends are not the skill's.
  await $.turn.complete({ answer: "read the tickets", agentId: "agent-1" });
  await w.clock.advance(15000);
  expect(w.reads).toBe(1);
  w.out = queue("1", "2");
  await $.turn.complete({ answer: "labelled" });
  await w.clock.advance(15000);
  expect(w.reads).toBe(2);
  expect(w.store.get(KEY)).toMatchObject({ ids: ["1", "2"] });
});
