// An end-of-run verify whose sandbox would not open (Sandcastle's worktree timeout behind a hung fetch, a slow
// container start) used to escape burndown() and end the run with a stack trace and no closing summary. Now it
// is recorded as `verify.notRun`: the summary says the merged base is ungated and not to push, the run exits 1,
// and a drain stops there. burndown() needs Docker, so its catch is held by a source match.
//
//   pnpm test:file test/verify-not-run.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");
const { noRerunCause, redBaseExit } = await import("../src/autonomy.ts");
type Facts = Parameters<typeof render>[0];

const TIMEOUT = "Worktree creation timed out after 30000ms";

const facts: Facts = {
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: { "1": { state: "merged", title: "a" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 1,
  verify: { green: false, line: "not run", notRun: TIMEOUT },
};

test("the summary says the merged base is ungated, why, and not to push", () => {
  const out = render(facts, true);
  assert.ok(out.includes(`Merged main NOT re-gated: the verify could not open its sandbox (${TIMEOUT}) - do not push main until \`sandcastle gates\` is green.`), out);
  assert.ok(!out.includes("RED TOGETHER"), out);
  assert.match(out, /Gate main: the end-of-run verify could not open its sandbox/);
});

test("a verify that could not run exits 1 and stops a drain with its own cause", () => {
  assert.equal(redBaseExit(facts), 1);
  assert.equal(noRerunCause(facts), "the merged base could not be re-gated");
});

test("burndown catches a verify that will not open, past a guard's refusal", () => {
  const src = readFileSync(join(KIT, "src/burndown.ts"), "utf8");
  assert.match(src, /if \(error instanceof OperatorError && !\(error instanceof SlowStartError\)\) throw error;\n\s+verifyNotRun = errorLine\(error\);/);
  assert.match(src, /verify: verifyNotRun \? \{ green: false, line: "not run", image, notRun: verifyNotRun \}/);
});
