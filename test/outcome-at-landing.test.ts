// A landing's outcome is recorded as the landing ends (burndown's `ended`, through the ledger),
// not only after the schedule: a report printed before then - the run stopped at landing, or
// `sandcastle report` mid-run - reads red together and taken back from the outcome's kind, and
// without it told a branch red together as a red gate and gave a taken-back ticket merge commands.
//
//   node --test test/outcome-at-landing.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLedger, describe } = await import("../src/ledger.ts");
const { pipelineOutcome } = await import("../src/burndown.ts");
const { recordOutcomes } = await import("../src/run.ts");
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = Parameters<typeof recordOutcomes>[0];

// A landing ending as the scheduler tells it.
const landing = (id: string, landed: Landed, status = "green") => ({ kind: "landing" as const, green: { issue: id, branch: `agent/issue-${id}`, status, commits: 1, repairs: 0, head: "abc1234" }, landed, attempts: 1 as const });
const CONTEXT = { base: "main", gateNames: "test" };

test("the ledger records each landing's outcome as its ending is told, in describe's words", () => {
  const written: Record<string, unknown> = {};
  const ledger = createLedger({
    run: { ticket: () => {} },
    outcomes: (o) => Object.assign(written, o),
    view: { landed: () => {} },
    context: () => CONTEXT,
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  const cases = [
    ["11", { kind: "merged" }],
    ["12", { kind: "conflict", files: ["a.ts"], with: ["11"] }],
    ["13", { kind: "red", with: ["11", "12"], gates: ["pytest"] }],
    ["14", { kind: "taken-back" }],
    ["15", { kind: "held", paths: [".github/x.yml"], reason: "protected", by: "protected" }],
    ["16", { kind: "withdrawn", reason: "closed" }],
    ["17", { kind: "not-landed", reason: "moved" }],
  ] satisfies [string, Landed][];
  for (const [id, landed] of cases) ledger.record(id, landing(id, landed));
  assert.deepEqual(
    Object.fromEntries(Object.entries(written).map(([id, o]) => [id, (o as { kind: string }).kind])),
    { 11: "merged", 12: "conflict", 13: "red", 14: "taken back", 15: "held", 16: "withdrawn", 17: "not landed" },
  );
  for (const [id, landed] of cases) assert.deepEqual(written[id], describe(landing(id, landed), CONTEXT).outcome, id);
});

// burndown() needs Docker, so no test drives it: its `tell` is held to handing every ending to the ledger by its source.
test("burndown hands each ending to the ledger as the scheduler tells it, and records no outcome of its own there", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const tell = src.slice(src.indexOf("const tell = "));
  const ended = tell.slice(tell.indexOf('case "ended":'), tell.indexOf("case \"blocked\":"));
  assert.match(ended, /return ledger\.tell\(c\);/);
  assert.doesNotMatch(ended, /recordOutcomes|view\.landed|run\.ticket/);
  assert.doesNotMatch(src, /landingLines|view\.landed\(/);
});

test("a branch merged by an earlier run reads as merged, as its line did before the kind, not as ready", () => {
  const o = pipelineOutcome({ status: "merged-earlier", gates: [] }, false);
  assert.deepEqual(o, { kind: "merged", text: "merged-earlier" });
});

test("a report printed before the schedule ends tells red together and taken back from the outcomes landing wrote", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-outcome-landing-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "t"], { cwd: root });
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const started = "2026-01-01T00:00:00Z";
  // Stopped at landing: no finish, and the end-of-run outcome write never came.
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({
      pid: 2 ** 22 + 1,
      startedAt: started,
      stage: "landing 2/3",
      stopped: "the .git directory changed",
      tickets: {
        "11": { state: "merged", title: "first" },
        "13": { state: "red", title: "together", note: "red with #11" },
        "14": { state: "held", title: "taken", note: "marked for a human during the run" },
      },
    }),
  );
  const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  // What each pipeline wrote as it ended, then what each landing writes as it ends.
  recordOutcomes(project, started, { 13: { kind: "green", text: "green - waiting to land" }, 14: { kind: "green", text: "green - waiting to land" } });
  const landings: [string, Landed][] = [["13", { kind: "red", with: ["11"], gates: ["pytest"] }], ["14", { kind: "taken-back" }]];
  for (const [id, landed] of landings) {
    const o = describe(landing(id, landed), CONTEXT).outcome;
    if (o) recordOutcomes(project, started, { [id]: o });
  }
  const out = render(await gather(project), true);
  assert.match(out, /#13 together - red together with #11 \(green on its own branch\)/);
  assert.match(out, /#14 taken - marked for a human during the run - branch agent\/issue-14 has the agents' work/);
});
