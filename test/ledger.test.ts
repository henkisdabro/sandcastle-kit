// The ledger (src/ledger.ts): `describe` turns every ending into the ticket state the run ends
// on, the outcome, the view's word and the tracker's text, in the words a run used before the
// ledger existed. One row per ending, each said four ways side by side; the run record, outcomes.json,
// the view and the tracker read nothing else. Then the writer, over fake ports. Pure: no git, no
// Docker, no network.
//
//   pnpm exec tsx --test test/ledger.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import type { Context, Said, TicketEnding } from "../src/ledger.ts";

// sandbox.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { accountLanding, createLedger, describe } = await import("../src/ledger.ts");

const green = (status = "green") => ({ issue: "2", branch: "agent/issue-2", status, commits: 2, repairs: 1, head: "abc1234" });
const landing = (landed: Landed, status?: string): TicketEnding => ({ kind: "landing", green: green(status), landed, attempts: 1 });
const again = (landed: Extract<Landed, { kind: "conflict" | "red" }>, first: string[]): TicketEnding => ({
  kind: "landing",
  green: green(),
  landed,
  attempts: 2,
  again: { kind: landed.kind, with: first },
});
const pipeline = (o: Partial<Extract<TicketEnding, { kind: "pipeline" }>["outcome"]>): TicketEnding => ({
  kind: "pipeline",
  outcome: { issue: "2", branch: "agent/issue-2", status: "nochange", commits: 0, repairs: 0, gates: [], ...o },
  attempts: 1,
});

const BASE: Context = { base: "main", gateNames: "test, lint" };
const REPORT = "Did the thing.";
const CLOSE = "Merged locally, not yet pushed, by the Sandcastle loop from `agent/issue-2` (2 commit(s), 1 repair pass(es) after a red gate); test, lint all green before merge.";
const REPORTED = `Sandcastle ran this ticket and did not land it. What the agents reported:\n\n${REPORT}`;
const NEXT_RUN = "The next run merges `main` into the branch and tries again.";
// The writer's ports for a requeue, where a test tells none.
const NO_REQUEUE = { dropFirst: () => {}, ref: (id: string) => `#${id}`, say: () => {} };

/** One ending, said four ways: the record ("state - note"), the outcome ("kind [with] - text"), the view's word and the tracker's text. */
type Row = [name: string, ending: TicketEnding, context: Partial<Context>, record?: string, outcome?: string, view?: string, tracker?: string];

const ROWS: Row[] = [
  // At landing.
  ["merged", landing({ kind: "merged" }), {}, "merged - merged and closed", "merged - merged", "merged (landed)", `close: ${CLOSE}`],
  [
    "merged, generated files regenerated and an overrun",
    landing({ kind: "merged", regenerated: { files: ["out.css"], regen: ["make css"] }, overrun: ["src/x.ts"] }),
    { report: REPORT },
    "merged - merged and closed (generated files regenerated)",
    "merged - merged",
    "merged (landed)",
    `close: ${CLOSE} Conflicts in generated files (out.css) were resolved by running \`make css\`.\n\nchanged beyond its Touches line: src/x.ts\n\n${REPORT}`,
  ],
  ["merged, closing failed", landing({ kind: "close-failed", error: "gh: HTTP 502" }), {}, "merged - merged; closing the ticket failed", "merged - merged (ticket not closed)", "merged, not closed (landed)", `close: ${CLOSE}`],
  [
    "merged, a criterion left unmet",
    landing({ kind: "partly-done", unmet: "the export module does not use the new rule" }),
    { report: REPORT },
    "merged - merged; ticket left open (a criterion is unmet)",
    "merged - merged (partly done)",
    "merged, partly done (landed)",
    `comment: ${CLOSE} **Left open: an acceptance criterion is unmet.** the export module does not use the new rule\n\nThe next run picks up the remainder.\n\n${REPORT}`,
  ],
  [
    "merged by an earlier run",
    landing({ kind: "closed-earlier" }, "merged-earlier"),
    {},
    "merged - closed, merged earlier (abc1234)",
    "merged - merged-earlier",
    "closed (landed)",
    "close: Merged into `main` by an earlier Sandcastle run (abc1234); closing.",
  ],
  [
    "conflict",
    landing({ kind: "conflict", files: ["a.ts", "b.ts"], with: ["1"] }),
    {},
    "conflict - with #1: a.ts, b.ts",
    "conflict [1] - merge conflict: with #1: a.ts, b.ts",
    "merge conflict (a person acts)",
    `comment: Sandcastle ran this ticket and did not land it: merging \`agent/issue-2\` into \`main\` conflicted (with #1: a.ts, b.ts). ${NEXT_RUN}`,
  ],
  [
    "conflict again after a requeue",
    again({ kind: "conflict", files: ["a.ts"], with: ["1", "3"] }, ["1"]),
    { report: REPORT },
    "conflict - conflicted again with #1, #3 after a requeue: a.ts",
    "conflict [1,3] - merge conflict: conflicted again with #1, #3 after a requeue: a.ts",
    "merge conflict (a person acts)",
    `comment: Sandcastle ran this ticket and did not land it: merging \`agent/issue-2\` into \`main\` conflicted (with #1, #3: a.ts). ${NEXT_RUN}\n\nWhat the agents reported:\n\n${REPORT}`,
  ],
  [
    "red once merged",
    landing({ kind: "red", with: ["1"], gates: ["test"] }),
    {},
    "red - red with #1",
    "red [1] - red when merged with #1",
    "red when merged (a person acts)",
    `comment: Sandcastle ran this ticket and did not land it: \`agent/issue-2\` was green on its own, but merged into \`main\` the gates were red (test). Landed on \`main\` since this branch forked: #1. Nothing was merged. ${NEXT_RUN}`,
  ],
  [
    "red on the merged tree, with nothing landed since",
    landing({ kind: "red", with: [], gates: ["test"] }),
    {},
    "red - red on the merged tree",
    "red - red when merged",
    "red when merged (a person acts)",
    `comment: Sandcastle ran this ticket and did not land it: \`agent/issue-2\` was green on its own, but merged into \`main\` the gates were red (test). Nothing was merged. ${NEXT_RUN}`,
  ],
  [
    "red again after a requeue",
    again({ kind: "red", with: ["1", "3"], gates: ["test"] }, ["1"]),
    {},
    "red - red again with #1, #3 after a requeue",
    "red [1,3] - red again with #1, #3 after a requeue",
    "red when merged (a person acts)",
    `comment: Sandcastle ran this ticket and did not land it: \`agent/issue-2\` was green on its own, but merged into \`main\` the gates were red (test). Landed on \`main\` since this branch forked: #1, #3. Nothing was merged. ${NEXT_RUN}`,
  ],
  [
    "held: a protected path",
    landing({ kind: "held", paths: [".github/workflows/ci.yml"], reason: "human merge: .github/workflows/ci.yml", by: "protected" }),
    { report: REPORT },
    "held - human merge: .github/workflows/ci.yml",
    "held - needs a human merge",
    "needs a human (a person acts)",
    "hold: Gated green on `agent/issue-2` (test, lint), but not merged automatically: it changes how the repo executes (.github/workflows/ci.yml), " +
      `which its own gates cannot vouch for. Review and merge by hand.\n\n${REPORT}`,
  ],
  [
    "held: a large file",
    landing({ kind: "held", paths: ["data.bin"], reason: "human merge: data.bin", by: "large" }),
    {},
    "held - human merge: data.bin",
    "held - needs a human merge",
    "needs a human (a person acts)",
    "hold: Gated green on `agent/issue-2` (test, lint), but not merged automatically: it adds data.bin, over GitHub's 50 MB file warning (it refuses a push with a file over 100 MB), " +
      "and a file that size stays in the history for good. Merge it by hand if it belongs in git; otherwise keep it out (Git LFS, or a step that downloads it).",
  ],
  [
    "held: a repair no review passed",
    landing({ kind: "held", paths: [], reason: "human merge: repair commits not reviewed: the review after repair failed", by: "unreviewed" }),
    { report: REPORT },
    "held - human merge: repair commits not reviewed: the review after repair failed",
    "held - needs a human merge",
    "needs a human (a person acts)",
    "hold: Gated green on `agent/issue-2` after a repair, but not merged: repair commits not reviewed: the review after repair failed. Review the repair commits and merge by hand.",
  ],
  ["withdrawn at landing", landing({ kind: "withdrawn", reason: "ticket closed during the run" }), {}, "withdrawn - ticket closed during the run", "withdrawn - withdrawn: ticket closed during the run", "withdrawn (landed)"],
  [
    "taken back by a person",
    landing({ kind: "taken-back" }),
    { report: REPORT },
    "held - marked for a human during the run",
    "taken back - needs a human: marked for a human during the run",
    "needs a human (a person acts)",
    `comment: ${REPORTED}`,
  ],
  [
    "moved after its gates",
    landing({ kind: "skipped", reason: "agent/issue-2 moved after its gates passed" }),
    {},
    "not landed - agent/issue-2 moved after its gates passed",
    "not landed - not merged: agent/issue-2 moved after its gates passed",
    "not merged (a person acts)",
  ],
  ["failed to land", landing({ kind: "not-landed", reason: "No space left on device" }), { report: REPORT }, "not landed - No space left on device", "not landed - failed to land", "failed to land (a person acts)", `comment: ${REPORTED}`],
  ["a dry run's merge", landing({ kind: "dry-run" }), { dryRun: true }, "ready - dry run: would merge", "green - dry run: gated green, would merge"],
  ["a dry run's close", landing({ kind: "dry-run" }, "merged-earlier"), { dryRun: true }, "ready - dry run: would close", "merged - merged-earlier"],
  [
    "a dry run's hold: every green it gated reads as one it would merge",
    landing({ kind: "held", paths: ["data.bin"], reason: "dry run: would hold: data.bin", by: "large" }),
    { dryRun: true },
    "held - dry run: would hold: data.bin",
    "green - dry run: gated green, would merge",
    "needs a human (a person acts)",
    "hold: Gated green on `agent/issue-2` (test, lint), but not merged automatically: it adds data.bin, over GitHub's 50 MB file warning (it refuses a push with a file over 100 MB), " +
      "and a file that size stays in the history for good. Merge it by hand if it belongs in git; otherwise keep it out (Git LFS, or a step that downloads it).",
  ],

  // In its pipeline.
  [
    "gate red",
    pipeline({ status: "gate-failed", commits: 1, repairs: 1, gates: [{ name: "test", pass: false }, { name: "lint", pass: true }] }),
    { report: REPORT },
    "red - test red, 1 repair(s)",
    "gate red - gate red: test=FAIL",
    undefined,
    `comment: ${REPORTED}`,
  ],
  ["nothing to change", pipeline({}), {}, "nochange - nothing to change", "no change - nochange"],
  ["handed back with a hold note", pipeline({}), { hold: "note" }, "held - handed back - for a human", "no change - nochange", "needs a human (a person acts)"],
  ["handed back with the tracker's hold label", pipeline({ handedBack: true }), {}, "held - handed back - for a human", "held - needs a human: handed back", "needs a human (a person acts)"],
  [
    "handed back with the tracker's hold label, with a report",
    pipeline({ handedBack: true }),
    { report: REPORT },
    "held - handed back - for a human",
    "held - needs a human: handed back",
    "needs a human (a person acts)",
    `comment: ${REPORTED}`,
  ],
  ["handed back with a hold note, with a report: the note, never a second comment", pipeline({}), { hold: "note", report: REPORT }, "held - handed back - for a human", "no change - nochange", "needs a human (a person acts)"],
  ["crashed after a hold note: the note, never a second comment", { kind: "crashed", error: new Error("x"), attempts: 1 }, { hold: "note", report: REPORT }, "crashed - Error: x", "crashed - crashed"],
  ["work left uncommitted", pipeline({}), { kept: ".sandcastle/worktrees/agent-issue-2" }, "uncommitted - work left uncommitted in .sandcastle/worktrees/agent-issue-2", "uncommitted - uncommitted"],
  ["handed back, its work uncommitted", pipeline({}), { kept: ".sandcastle/worktrees/agent-issue-2", hold: "note" }, "uncommitted - work left uncommitted in .sandcastle/worktrees/agent-issue-2", "uncommitted - uncommitted"],
  [
    "handed back with commits and a kept worktree",
    pipeline({ commits: 1 }),
    { kept: ".sandcastle/worktrees/agent-issue-2", hold: "note" },
    "nochange - handed back - for a human",
    "no change - nochange",
  ],
  [
    "held by the kit",
    pipeline({ status: "held", heldNote: "resolution changed x.ts, which merged cleanly" }),
    { hold: "note" },
    "held - resolution changed x.ts, which merged cleanly",
    "held - needs a human: resolution changed x.ts, which merged cleanly",
    "needs a human (a person acts)",
  ],

  // Crashed, stopped, never begun, still waiting.
  ["crashed in its pipeline", { kind: "crashed", error: new Error("idle timeout\n    at x"), attempts: 1 }, { report: REPORT }, "crashed - Error: idle timeout", "crashed - crashed", undefined, `comment: ${REPORTED}`],
  ["crashed at landing", { kind: "crashed", error: new Error("ENOSPC: no space left"), attempts: 1, green: green() }, {}, "crashed - ENOSPC: no space left", "crashed - crashed"],
  [
    "stopped while it waited to land",
    { kind: "stopped", cause: { kind: "usage limit", line: "usage at 95%" }, finished: true, green: green() },
    {},
    "stopped - finished before the run stopped - lands on a later run",
    "stopped - stopped: the run stopped before landing",
  ],
  [
    "stopped by the .git check after its pipeline",
    { kind: "stopped", cause: { kind: "tampered", error: new Error("moved") }, finished: false },
    {},
    "stopped - finished before the run stopped - lands on a later run",
    "stopped - stopped: the run stopped before landing",
  ],
  ["withdrawn before it began", { kind: "not begun", why: { kind: "withdrawn", reason: "ticket closed during the run" } }, {}, "withdrawn - ticket closed - not started"],
  [
    "refused by its label",
    { kind: "not begun", why: { kind: "refused label", reason: "NOT STARTED: #2 carries the hold label" } },
    {},
    "skipped - not started: #2 carries the hold label",
  ],
  ["not started: the run stopped", { kind: "not begun", why: { kind: "usage limit", line: "usage at 95%" } }, { stopLine: "usage at 95%" }, "skipped - not started: usage at 95%"],
  ["still waiting for a file", { kind: "waiting", on: "file" }, {}],
];

const said = (s: Said) => [
  s.record && `${s.record.state} - ${s.record.note}`,
  s.outcome && `${s.outcome.kind}${s.outcome.with ? ` [${s.outcome.with.join(",")}]` : ""} - ${s.outcome.text}`,
  s.view && `${s.view.word} (${s.view.landed ? "landed" : "a person acts"})`,
  s.tracker && `${s.tracker.kind}: ${s.tracker.text}`,
];

for (const [name, ending, context, ...want] of ROWS) {
  test(`describe: ${name}`, () => {
    const got = said(describe(ending, { ...BASE, ...context }));
    assert.deepEqual(got, [0, 1, 2, 3].map((i) => want[i]));
  });
}

test("the table has a row for every ending kind, every landing and every pipeline that ends one", () => {
  const endings: Record<TicketEnding["kind"], true> = { landing: true, pipeline: true, crashed: true, stopped: true, "not begun": true, waiting: true };
  const landings: Record<Landed["kind"], true> = {
    merged: true,
    conflict: true,
    red: true,
    held: true,
    withdrawn: true,
    "taken-back": true,
    "closed-earlier": true,
    skipped: true,
    "not-landed": true,
    "close-failed": true,
    "partly-done": true,
    "dry-run": true,
  };
  const ended = ROWS.map(([, e]) => e);
  assert.deepEqual(Object.keys(endings).filter((k) => !ended.some((e) => e.kind === k)), []);
  assert.deepEqual(Object.keys(landings).filter((k) => !ended.some((e) => e.kind === "landing" && e.landed.kind === k)), []);
  // A green branch or an earlier merge goes on to landing; every other pipeline result ends there.
  const statuses = ["gate-failed", "nochange", "held"];
  assert.deepEqual(statuses.filter((s) => !ended.some((e) => e.kind === "pipeline" && e.outcome.status === s)), []);
});

// The writer's ports over memory: the states, outcomes and view words it wrote.
const memory = (context: (id: string) => Context = () => BASE) => {
  const states: [string, unknown][] = [];
  const outcomes: Record<string, unknown> = {};
  const views: [string, boolean, string][] = [];
  const ledger = createLedger({
    run: { ticket: (id, fields) => void states.push([id, fields]) },
    outcomes: (o) => Object.assign(outcomes, o),
    view: { landed: (id, ok, word) => void views.push([id, ok, word]) },
    context,
    bookkeep: (_id, fn) => fn(),
    ...NO_REQUEUE,
  });
  return { ledger, states, outcomes, views };
};

test("the writer records the state, the outcome and the view's word of every ending", () => {
  const { ledger, states, outcomes, views } = memory();
  ledger.record("1", landing({ kind: "merged" }));
  ledger.record("2", { kind: "not begun", why: { kind: "withdrawn", reason: "ticket closed during the run" } });
  ledger.record("3", pipeline({ handedBack: true }));
  ledger.record("4", { kind: "crashed", error: new Error("ENOSPC"), attempts: 1, green: green() });
  ledger.record("5", pipeline({ status: "gate-failed", gates: [{ name: "test", pass: false }] }));
  ledger.record("6", { kind: "crashed", error: new Error("idle timeout"), attempts: 1 });
  ledger.record("7", { kind: "stopped", cause: { kind: "tampered", error: new Error("moved") }, finished: false });
  // Nothing in the attempt, the scheduler's glue or after the schedule writes these: the ledger does, from the ending.
  assert.deepEqual(states, [
    ["1", { state: "merged", note: "merged and closed" }],
    ["2", { state: "withdrawn", note: "ticket closed - not started" }],
    ["3", { state: "held", note: "handed back - for a human" }],
    ["4", { state: "crashed", note: "ENOSPC" }],
    ["5", { state: "red", note: "test red" }],
    ["6", { state: "crashed", note: "Error: idle timeout" }],
    ["7", { state: "stopped", note: "finished before the run stopped - lands on a later run" }],
  ]);
  assert.deepEqual(Object.keys(outcomes), ["1", "3", "4", "5", "6", "7"]);
  assert.deepEqual(outcomes["3"], { kind: "held", text: "needs a human: handed back" });
  assert.deepEqual(views, [
    ["1", true, "merged"],
    ["3", false, "needs a human"],
  ]);
  assert.deepEqual([...ledger.entries.keys()], ["1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(accountLanding(ledger.entries.values()).needsHuman, 1);
});

test("a ticket the run's stop left unstarted is recorded once the schedule is over, in the run's last words", () => {
  const { ledger, states } = memory();
  const unstarted: TicketEnding = { kind: "not begun", why: { kind: "usage limit", line: "usage at 95%" } };
  ledger.tell({ kind: "ended", id: "8", ending: unstarted });
  // Told as it happened, the run's stop line could still change: nothing is written yet.
  assert.deepEqual(states, []);
  const refused: TicketEnding = { kind: "not begun", why: { kind: "refused label", reason: "NOT STARTED: #9 carries the hold label" } };
  ledger.close(
    new Map<string, TicketEnding>([
      ["8", unstarted],
      ["9", refused],
      ["10", { kind: "waiting", on: "file" }],
    ]),
    "#3 hit the plan's usage limit",
  );
  assert.deepEqual(states, [["8", { state: "skipped", note: "not started: #3 hit the plan's usage limit" }]]);
  assert.equal(ledger.entries.get("8")?.context.stopLine, "#3 hit the plan's usage limit");
});

test("with no stop line, a ticket left unstarted says the run stopped", () => {
  const { ledger, states } = memory();
  ledger.close(new Map<string, TicketEnding>([["8", { kind: "not begun", why: { kind: "usage limit", line: "x" } }]]), undefined);
  assert.deepEqual(states, [["8", { state: "skipped", note: "not started: the run stopped" }]]);
});

test("a green branch waiting to land is ready, with its outcome now, and says what will hold it", () => {
  const { ledger, states, outcomes, views } = memory();
  const finished = (o: Partial<Extract<TicketEnding, { kind: "pipeline" }>["outcome"]>) => ({ ...green(), gates: [], ...o }) as Extract<TicketEnding, { kind: "pipeline" }>["outcome"];
  ledger.ready("1", finished({}), []);
  ledger.ready("2", finished({}), [".github/workflows/ci.yml"]);
  ledger.ready("3", finished({ status: "merged-earlier" }), []);
  assert.deepEqual(states, [
    ["1", { state: "ready", note: "gates green, 1 repair(s)" }],
    ["2", { state: "ready", note: "human merge: .github/workflows/ci.yml" }],
    ["3", { state: "ready", note: "merged earlier (abc1234) - to close" }],
  ]);
  assert.deepEqual(outcomes, {
    "1": { kind: "green", text: "green - waiting to land" },
    "2": { kind: "green", text: "green - waiting to land" },
    "3": { kind: "merged", text: "merged-earlier" },
  });
  // Not an ending: the view's word, and the entry, wait for its landing.
  assert.deepEqual([views, ledger.entries.size], [[], 0]);
});

test("a write that throws costs the ticket that write only", () => {
  const outcomes: string[] = [];
  const failed: string[] = [];
  const ledger = createLedger({
    run: {
      ticket: () => {
        throw new Error("disk full");
      },
    },
    outcomes: (o) => void outcomes.push(...Object.keys(o)),
    view: { landed: () => {} },
    context: () => BASE,
    bookkeep: (id, fn) => {
      try {
        fn();
      } catch {
        failed.push(id);
      }
    },
    ...NO_REQUEUE,
  });
  ledger.record("5", { kind: "crashed", error: new Error("x"), attempts: 1, green: green() });
  assert.deepEqual([failed, outcomes], [["5"], ["5"]]);
});

test("the closing counts come from the ledger's entries", () => {
  const ledger = createLedger({ run: { ticket: () => {} }, outcomes: () => {}, view: { landed: () => {} }, context: () => BASE, bookkeep: (_id, fn) => fn(), ...NO_REQUEUE });
  const ends: [string, TicketEnding][] = [
    ["1", landing({ kind: "merged", regenerated: { files: ["out.css"], regen: ["make css"] } })],
    ["2", landing({ kind: "close-failed", error: "gh: HTTP 502" })],
    ["3", landing({ kind: "closed-earlier" }, "merged-earlier")],
    ["4", landing({ kind: "conflict", files: ["a"], with: [] })],
    ["5", landing({ kind: "red", with: [], gates: ["test"] })],
    ["6", landing({ kind: "not-landed", reason: "x" })],
    ["7", landing({ kind: "skipped", reason: "moved" })],
    ["8", landing({ kind: "held", paths: ["x"], reason: "human merge: x", by: "protected" })],
    ["9", landing({ kind: "taken-back" })],
    ["10", landing({ kind: "withdrawn", reason: "closed" })],
    ["11", pipeline({ status: "gate-failed" })],
  ];
  for (const [id, e] of ends) ledger.record(id, e);
  assert.deepEqual(accountLanding(ledger.entries.values()), { merged: ["1", "2"], regenerated: 1, notLanded: 4, needsHuman: 2, withdrawn: 1 });
});
