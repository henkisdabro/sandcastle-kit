// A ticket's gates log (agent-issue-N-gates-N.log) holds every gate run of the ticket, and each section
// says which kind of run it is, that it waited for a gates slot, and stamps its gate lines in the same
// local time as its header (`markLog` in src/run.ts, `runGates` in src/gates.ts, the landing gates' call
// in src/burndown.ts, `landTicket` in src/land.ts).
//
//   pnpm test:file test/gates-log-sections.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, slots } from "./pool-sim.ts";

const { runGates } = await import("../src/gates.ts");
const { markLog } = await import("../src/run.ts");

afterEach(cleanup);

const project = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }] } as Parameters<typeof runGates>[0];
const green = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
const logFile = () => join(mkdtempSync(join(tmpdir(), "sandcastle-gates-log-")), "agent-issue-7-gates-7.log");

test("a gates log names the kind of each run, ticket gates and landing gates alike", async () => {
  const log = logFile();
  markLog(log, "run-1", "ticket gates");
  await runGates(project, green, "fixture #7 gates", false, { log });
  markLog(log, "run-1", "landing gates on the merged tree");
  await runGates(project, green, "fixture #7 landing gate", false, { log }, true);
  const headers = readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("# ticket") || line.startsWith("# landing"));
  assert.equal(headers.length, 2);
  assert.match(headers[0], /^# ticket gates - run run-1, \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
  assert.match(headers[1], /^# landing gates on the merged tree - run run-1, \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
});

test("a header with no run names only the kind", () => {
  const log = logFile();
  markLog(log, undefined, "sandcastle land gates on the merged tree");
  assert.match(readFileSync(log, "utf8"), /^\n# sandcastle land gates on the merged tree, \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d\n$/);
});

test("a gate line is stamped in the header's local time, not UTC", async () => {
  const log = logFile();
  await runGates(project, green, "fixture #7 gates", false, { log });
  const line = readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("$ run-lint"))!;
  assert.match(line, /# gate 1\/1: lint, \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
  assert.ok(!line.includes("Z"), line);
});

test("a wait for a gates slot is said in the log, and a run with no wait says nothing", async (t) => {
  const quiet = logFile();
  await runGates(project, green, "fixture #7 gates", false, { log: quiet });
  assert.ok(!readFileSync(quiet, "utf8").includes("waited"));

  // The one gates slot is held by another run, as the pool writes its lock; the clock is the boundary,
  // moved 171 s when the wait starts, and the slot is freed then.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const lock = join(slots, "gates-0.lock");
  writeFileSync(lock, `1000100 token-y run=run-y a ticket gate\n`);
  const log = logFile();
  await runGates(project, green, "fixture #7 gates", false, {
    log,
    wait: () => {
      t.mock.timers.tick(171_000);
      rmSync(lock);
    },
  });
  const text = readFileSync(log, "utf8");
  assert.match(text, /^# waited 171s for a gates slot$/m);
  assert.ok(text.indexOf("# waited") < text.indexOf("$ run-lint"), "the wait is said before the section's first gate");
});

test("the landing gates' header and a hand landing's header are written where the gates run", () => {
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(burndown, /markLog\(gatesLog\(project, id\), runId, priority \? "landing gates on the merged tree" : "ticket gates"\)/);
  const land = readFileSync(new URL("../src/land.ts", import.meta.url), "utf8");
  assert.match(land, /markLog\(log, undefined, "sandcastle land gates on the merged tree"\)/);
});
