// A ticket whose Touches line names a path the kit always holds for a person (#441): the start plan
// says so before the ticket costs a pipeline, and the live line of its hold carries the reason. The
// plan lines (`protectedPlanLines`) are read over tickets against a temp git repo, and their place
// in burndown()'s start output from its source (burndown() needs Docker, as start-output-order.test.ts
// says); the live line is the real ledger's `say`, over a run record in a temp dir. No Docker, model
// or network.
//
//   node --test test/protected-plan.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { protectedPlanLines } = await import("../src/guard.ts");
const { createLedger } = await import("../src/ledger.ts");
const { recordRun } = await import("../src/run.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;
type Landed = import("../src/landing.ts").Landed;
type Finished = import("../src/ledger.ts").Finished;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-protected-plan-"));
const GIT = ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const git = (root: string, ...a: string[]) => execFileSync("git", [...GIT, ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("the start plan names each ticket whose Touches line names a held path, and only those", () => {
  const root = join(TMP, "plan");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/check.yml"), "on: push\n");
  writeFileSync(join(root, "app.ts"), "export {};\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "t");
  const project = { root, name: "t", baseBranch: "main", protectedPaths: ["app.ts"], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const queued = [
    { id: "7", body: "Fix CI.\n\nTouches: .github/workflows/check.yml, docs/x.md" },
    { id: "8", body: "Touches: docs/x.md" },
    { id: "9" },
    { id: "10", body: "Touches: app.ts" },
  ];
  assert.deepEqual(protectedPlanLines(project, queued, (id) => `#${id}`), [
    "#7 will be held for a person to merge (.github/workflows/check.yml)",
    "#10 will be held for a person to merge (app.ts)",
  ]);
});

test("burndown() says the plan lines under the run header, before the wait lines", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const body = src.indexOf("export const burndown = ");
  const header = src.indexOf("ticket(s)${dependants.length", body);
  const plan = src.indexOf("protectedPlanLines(project, candidates, ref)", body);
  const waits = src.indexOf("sayWaits(new Set(dependants.map((d) => d.id)));\n  holds.start(schedule.start);", header);
  assert.ok(header > body && plan > header && waits > plan, "the plan lines print after the header and before the wait lines");
});

test("the live line of a ticket held at landing carries the paths it is held for", () => {
  const project = { root: join(TMP, "ledger"), name: "fixture" } as unknown as Project;
  const run = recordRun(project);
  // recordRun finishes its record in an exit handler: the temp directory goes after it.
  process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
  const said: string[] = [];
  const ledger = createLedger({
    run,
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: (line) => void said.push(line),
  });
  const green: Finished = { issue: "7", branch: "agent/issue-7", status: "green", commits: 1, repairs: 0, gates: [] };
  const landed: Landed = { kind: "held", paths: [".github/workflows/check.yml"], reason: "human merge: .github/workflows/check.yml", by: "protected" };
  ledger.record("7", { kind: "landing", green, landed, attempts: 1 } as never);
  assert.deepEqual(said, ["#7: needs a human: human merge: .github/workflows/check.yml."]);
});
