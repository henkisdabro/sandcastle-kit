// A landing's outcome is recorded as the landing ends (burndown's `ended`, through `landingOutcome`),
// not only after the schedule: a report printed before then - the run stopped at landing, or
// `sandcastle report` mid-run - reads red together and taken back from the outcome's kind, and
// without it told a branch red together as a red gate and gave a taken-back ticket merge commands.
//
//   pnpm exec tsx --test test/outcome-at-landing.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { landingLines, landingOutcome, newLandings, accountLanding } = await import("../src/landing.ts");
const { pipelineOutcome } = await import("../src/burndown.ts");
const { recordOutcomes } = await import("../src/run.ts");
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = Parameters<typeof recordOutcomes>[0];

test("landingOutcome gives one landing's outcome as landingLines does at the end of the run", () => {
  const green = (issue: string) => ({ issue, branch: `agent/issue-${issue}` });
  const again = new Map([["13", "red again with #11, #12 after a requeue"]]);
  const cases = [
    ["11", { kind: "merged" }],
    ["12", { kind: "conflict", files: ["a.ts"], with: ["11"] }],
    ["13", { kind: "red", with: ["11", "12"], gates: ["pytest"] }],
    ["14", { kind: "taken-back" }],
    ["15", { kind: "held", paths: [".github/x.yml"], reason: "protected" }],
    ["16", { kind: "withdrawn", reason: "closed" }],
    ["17", { kind: "not-landed", reason: "moved" }],
  ] satisfies [string, Landed][];
  const all = newLandings();
  for (const [id, landed] of cases) accountLanding(all, green(id), landed);
  const end = landingLines(all, again);
  for (const [id, landed] of cases) assert.deepEqual(landingOutcome(green(id), landed, again), end.get(id), id);
  assert.equal(landingOutcome(green("13"), cases[2][1], again)?.kind, "red");
  assert.equal(landingOutcome(green("14"), { kind: "taken-back" }, again)?.kind, "taken back");
  // Nothing to say: the pipeline's own outcome stands.
  assert.equal(landingOutcome(green("18"), { kind: "dry-run" }, again), undefined);
});

// burndown() needs Docker, so no test drives it: its `ended` is held to recording the landing's outcome by its source.
test("burndown records each landing's outcome as the scheduler tells its ending", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const ended = src.slice(src.indexOf("const ended = "), src.indexOf("const tell = "));
  const landing = ended.slice(ended.indexOf('e.kind === "landing"'), ended.indexOf("} else if"));
  assert.match(landing, /landingOutcome\(e\.green, e\.landed, againNote\)/);
  assert.match(landing, /recordOutcomes\(project, runId, /);
});

test("a branch merged by an earlier run reads as merged, as its line did before the kind, not as ready", () => {
  const o = pipelineOutcome({ issue: "9", branch: "agent/issue-9", status: "merged-earlier", commits: 0, reviewCommits: 0, repairs: 0, gates: [], head: "abc1234" }, false);
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
    const o = landingOutcome({ issue: id, branch: `agent/issue-${id}` }, landed, new Map());
    if (o) recordOutcomes(project, started, { [id]: o });
  }
  const out = render(await gather(project), true);
  assert.match(out, /#13 together - red together with #11 \(green on its own branch\)/);
  assert.match(out, /#14 taken - marked for a human during the run - branch agent\/issue-14 has the agents' work/);
});
