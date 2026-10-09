// Tickets that crash expanding their prompt the same way are a setup problem (a token that cannot see
// the repo, `gh` not signed in), not the tickets': after the second, no new ticket starts, the run says
// so once and points at `sandcastle doctor --verify`, and the closing summary's next step names it
// instead of asking for a comment for the implementer. The crash note drops the library's
// `(FiberFailure) PromptError:` prefix and ends at a word, and the ticket's agent log gets the error
// line. The real scheduler, ledger and report over fake attempts: no Docker, no model, no network.
//
//   pnpm test:file test/stop-on-setup-crash.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLedger } = await import("../src/ledger.ts");
const { render } = await import("../src/report.ts");
const { logExpansionFailure } = await import("../src/run.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Facts = import("../src/report.ts").Facts;
type Change = import("../src/schedule.ts").Change<unknown, unknown>;
type TicketRecord = import("../mod/hooks/run-record.ts").TicketRecord;

/** The error the library's `runPromise` throws for a failed shell expression of the prompt, as the run sees it. */
const promptError = (ticket: string, stderr = "HTTP 404: Not Found (https://api.example.com/repos/o/r/issues)") =>
  Object.assign(new Error(`Command \`gh issue view ${ticket}\` exited with code 1: ${stderr}`), { name: "(FiberFailure) PromptError" });

const play = async (tickets: string[], crash: (id: string) => Error, workers = 1) => {
  const records = new Map<string, TicketRecord>();
  const told: Change[] = [];
  const started: string[] = [];
  const ledger = createLedger({
    run: { ticket: (id, fields) => void records.set(id, fields) },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  const { endings, stop } = await createSchedule<{ id: string }, { issue: string }, unknown, string>({ tickets: tickets.map((id) => ({ id })) }).run({
    workers,
    attempt: async (t: { id: string }) => {
      started.push(t.id);
      return { kind: "crashed" as const, error: crash(t.id) };
    },
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: (c: unknown) => {
      told.push(c as Change);
      ledger.tell(c as never);
    },
  } as never);
  return { records, told, started, ledger, endings, stop };
};

test("a third ticket never starts when two crashed expanding their prompt the same way", async () => {
  const { started, records, told, ledger, endings, stop } = await play(["1", "2", "3", "4"], (id) => promptError(id));
  assert.deepEqual(started, ["1", "2"]);
  assert.equal(told.filter((c) => c.kind === "setup problem").length, 1);
  assert.deepEqual(stop.headline, { kind: "setup problem", line: "Command `gh issue view 2` exited with code 1: HTTP 404: Not Found (https://api.example.com/repos/o/r/issues)" });
  ledger.close(endings as never, "a setup problem");
  assert.equal(records.get("1")?.state, "crashed");
  assert.equal(records.get("2")?.state, "crashed");
  for (const id of ["3", "4"]) assert.deepEqual(records.get(id), { state: "skipped", note: "not started: a setup problem" });
});

test("two tickets that crash in different ways, or not expanding a prompt, do not stop the run", async () => {
  const differently = await play(["1", "2", "3"], (id) => promptError(id, id === "1" ? "HTTP 404" : "HTTP 500"));
  assert.deepEqual(differently.started, ["1", "2", "3"]);
  const elsewhere = await play(["1", "2", "3"], () => new Error("claude-code exited with code 1:"));
  assert.deepEqual(elsewhere.started, ["1", "2", "3"]);
  assert.equal(elsewhere.told.filter((c) => c.kind === "setup problem").length, 0);
});

test("tickets already running when the second crash lands finish; none after it starts", async () => {
  const { started, endings } = await play(["1", "2", "3", "4", "5"], (id) => promptError(id), 2);
  assert.ok(started.length >= 2 && started.length <= 4, started.join());
  assert.equal(new Set(started).size, started.length);
  assert.equal([...endings.values()].filter((e: { kind: string }) => e.kind === "crashed").length, started.length);
});

test("a crash note drops the FiberFailure prefix and ends at a word", async () => {
  const long = "HTTP 404: Not Found, the token cannot see the repository, and the organisation requires single sign-on for its API, so every request is refused";
  const { records, ledger, endings } = await play(["1"], (id) => promptError(id, long));
  ledger.close(endings as never, undefined);
  const note = records.get("1")!.note!;
  assert.ok(!/FiberFailure|PromptError/.test(note), note);
  assert.ok(note.startsWith("Command `gh issue view 1` exited with code 1: HTTP 404"), note);
  assert.ok(note.length <= 160, note);
  assert.ok(note.endsWith("…"), note);
  // Cut at a word: what precedes the ellipsis is a whole word of the original.
  assert.ok(long.split(/\s+/).includes(note.slice(0, -1).split(/\s+/).at(-1)!), note);
});

test("a crash note for a message that carries the prefix itself reads the same", async () => {
  const { records, ledger, endings } = await play(["1"], () => new Error("(FiberFailure) PromptError: Command `gh auth status` exited with code 1:\nYou are not logged in\nrun gh auth login"));
  ledger.close(endings as never, undefined);
  assert.equal(records.get("1")?.note, "Command `gh auth status` exited with code 1: You are not logged in");
});

test("the closing summary names the setup problem and doctor --verify, not a comment for the implementer", () => {
  const line = "Command `gh issue view 2` exited with code 1: HTTP 404";
  const facts: Facts = {
    base: "main",
    tracker: "github",
    started: "2026-10-05T06:41:00.000Z",
    finished: "2026-10-05T07:10:00.000Z",
    live: false,
    dryRun: false,
    gateCount: 2,
    setupProblem: line,
    tickets: {
      "1": { state: "crashed", title: "one", started: 1, note: "Command `gh issue view 1` exited with code 1: HTTP 404" },
      "2": { state: "crashed", title: "two", started: 1, note: line },
      "3": { state: "skipped", title: "three", note: "not started: a setup problem" },
    },
    runnable: [],
    blocked: [],
    standing: [],
    keptWorktrees: [],
    changed: {},
    stage: "report",
    exitCode: 0,
  };
  const out = render(facts, true);
  const next = out.split("## Next step")[1]?.split("\n## ")[0] ?? "";
  assert.match(next, /setup problem/);
  assert.match(next, /sandcastle doctor --verify/);
  assert.match(next, /#1 #2 #3/);
  assert.doesNotMatch(out, /add a comment for the implementer/);
  assert.match(out, /Stopped starting tickets: a setup problem/);
});

test("the ticket's agent log ends with the error line of a failed prompt expansion", () => {
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "agent-issue-1-impl-1.log");
  writeFileSync(log, "Expanding shell expressions\n");
  logExpansionFailure({ type: "file", path: log }, promptError("1"));
  assert.equal(readFileSync(log, "utf8"), "Expanding shell expressions\n! error: Command `gh issue view 1` exited with code 1: HTTP 404: Not Found (https://api.example.com/repos/o/r/issues)\n");
  // Any other error already ends its log with its cause.
  logExpansionFailure({ type: "file", path: log }, new Error("claude-code exited with code 1:"));
  assert.equal(readFileSync(log, "utf8").split("\n").length, 3);
});

test("burndown() logs the expansion failure of a pass and records and announces the setup problem", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /logExpansionFailure\(opts\.logging, error\)/);
  assert.match(src, /case "setup problem":\s*[^]*?run\.update\(\{ setupProblem: c\.line \}\)/);
});
