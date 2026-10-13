// A GitHub 5xx while a prompt is expanded is GitHub's failure, not the user's setup: a 502 and a 504 count as
// one failure, the stop line names the status and githubstatus.com (a 401 still says `doctor --verify`), and the
// closing summary's next step lists the tickets the failure stopped.
//
//   pnpm test:file test/github-5xx-expansion.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { sameExpansionFailure } = await import("../src/errors.ts");
const { setupProblemWords } = await import("../src/ledger.ts");
const { render } = await import("../src/report.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Facts = import("../src/report.ts").Facts;

const line = (ticket: string, output: string) => `Command \`gh issue view ${ticket}\` exited with code 1: ${output}`;

test("a 502 and then a 504 are the same expansion failure, a 404 or a 500 beside a 404 is not", () => {
  assert.ok(sameExpansionFailure(line("1", "HTTP 502: Bad Gateway (https://api.example.com/graphql)"), line("2", "HTTP 504: Gateway Timeout (https://api.example.com/graphql)")));
  assert.ok(sameExpansionFailure(line("1", "HTTP 503"), line("2", "HTTP 500: Internal Server Error")));
  assert.ok(!sameExpansionFailure(line("1", "HTTP 404: Not Found"), line("2", "HTTP 500: Internal Server Error")));
  assert.ok(!sameExpansionFailure(line("1", "HTTP 401: Bad credentials"), line("2", "HTTP 403: Forbidden")));
});

test("a 502 then a 504 stop the run after the second ticket, as one failure", async () => {
  const started: string[] = [];
  const { stop } = await createSchedule<{ id: string }, { issue: string }, unknown, string>({ tickets: ["1", "2", "3"].map((id) => ({ id })) }).run({
    workers: 1,
    attempt: async (t: { id: string }) => {
      started.push(t.id);
      const output = t.id === "1" ? "HTTP 502: Bad Gateway" : "HTTP 504: Gateway Timeout";
      return { kind: "crashed" as const, error: Object.assign(new Error(line(t.id, output)), { name: "(FiberFailure) PromptError" }) };
    },
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  } as never);
  assert.deepEqual(started, ["1", "2"]);
  assert.equal(stop.headline?.kind, "setup problem");
});

test("a 5xx stop line names the status and githubstatus.com, a 401 still says doctor --verify", () => {
  const five = setupProblemWords(line("2", "HTTP 502: Bad Gateway"));
  assert.match(five, /HTTP 502/);
  assert.match(five, /githubstatus\.com/);
  assert.doesNotMatch(five, /doctor --verify|setup problem/);
  const four = setupProblemWords(line("2", "HTTP 401: Bad credentials"));
  assert.match(four, /sandcastle doctor --verify/);
  assert.doesNotMatch(four, /githubstatus/);
});

const facts = (setupProblem: string, notes: [string, string, string]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:41:00.000Z",
  finished: "2026-10-05T07:10:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  setupProblem,
  tickets: {
    "1": { state: "crashed", title: "one", started: 1, note: notes[0] },
    "2": { state: "crashed", title: "two", started: 1, note: notes[1] },
    "3": { state: "skipped", title: "three", note: notes[2] },
  },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
});

test("the closing summary's next step lists the tickets a GitHub 5xx stopped, without doctor --verify", () => {
  const out = render(facts(line("2", "HTTP 504: Gateway Timeout"), [line("1", "HTTP 502: Bad Gateway"), line("2", "HTTP 504: Gateway Timeout"), "not started: a setup problem"]), true);
  const next = out.split("## Next step")[1]?.split("\n## ")[0] ?? "";
  assert.match(next, /GitHub failed \(HTTP 504/);
  assert.match(next, /githubstatus\.com/);
  assert.match(next, /#1 #2 #3/);
  assert.doesNotMatch(next, /doctor --verify/);
  assert.doesNotMatch(out, /add a comment for the implementer/);
  assert.match(out, /Stopped starting tickets: GitHub failed \(HTTP 504\)/);
});
