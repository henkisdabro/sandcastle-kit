// The conflict resolver of a re-run (the land-only path in src/burndown.ts) is its own phase:
// a `resolve` ticket state, a `resolve-<id>` sandbox and log, and its own timings line, so its
// short pass neither shares the implementer's log nor pulls the typical implement time down. The
// pipeline running it is driven in test/pipeline.test.ts.
//
//   pnpm exec tsx --test test/resolve-phase.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GROUPS, TICKET_STATES } from "../mod/hooks/run-record.ts";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { agentLog, logOwner, typicalTimes } = await import("../src/run.ts");
type Project = Parameters<typeof typicalTimes>[0];

const MIN = 60_000;

test("resolve is a working ticket state of its own", () => {
  assert.ok((TICKET_STATES as readonly string[]).includes("resolve"));
  assert.equal(GROUPS.resolve, "working");
});

test("a resolve log is named for its own phase and read back to its ticket", () => {
  const file = agentLog({ root: "/r" } as Project, "12", "resolve-12");
  assert.ok(file.endsWith(join(".sandcastle", "logs", "agent-issue-12-resolve-12.log")), file);
  for (const name of ["agent-issue-12-resolve-12.log", "agent-issue-12-resolve-12.jsonl", "agent-issue-checkout-03-resolve-checkout-03.log"]) {
    assert.equal(logOwner(name), name.includes("checkout") ? "checkout-03" : "12", name);
  }
  assert.equal(logOwner("agent-issue-code-review-01-resolve-code-review-01.jsonl"), "code-review-01");
});

test("a resolve step stays out of the implement median and still counts in the issue's total", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-resolve-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const line = (issue: string, phase: string, minutes: number) => JSON.stringify({ project: "fixture", run: "2026-09-01T10:00:00.000Z", issue, phase, ms: minutes * MIN });
  writeFileSync(
    join(root, ".sandcastle/logs/timings.jsonl"),
    [line("1", "implement", 10), line("2", "implement", 10), line("2", "resolve", 1), line("3", "resolve", 1)].join("\n") + "\n",
  );
  const times = typicalTimes({ root, name: "fixture" } as Project);
  assert.equal(times.implement, 600);
  assert.equal(times.resolve, 60);
  // Tickets 1, 2 and 3 total 10m, 11m and 1m: the resolve minutes are in ticket 2's.
  assert.equal(times.issue, 600);
});
