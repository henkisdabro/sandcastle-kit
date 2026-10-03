// The run record's reads and writes go through one schema (mod/hooks/run-record.ts): a state a
// record holds outside the set - an older kit's, or edited by hand - is in the "other" group,
// counted as neither needing the person nor cut short, and in no report section.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTickets, type RunRecord } from "../mod/hooks/run-record.ts";
import { runCounts } from "../src/herdr.ts";
import { liveRuns } from "../src/herdr-plugin.ts";
import { endSummary } from "../src/notify.ts";
import type { Project } from "../src/config.ts";
import { render } from "../src/report.ts";
import { everyPidIsTheKit } from "./kit-process.ts";

// Not a ticket state; typed loosely on purpose, as a file on disk is.
const STRANGE = "shipped";
const record = {
  pid: process.pid,
  tickets: { 1: { state: "merged", title: "a" }, 2: { state: STRANGE, title: "b", note: "from an older kit" }, 3: { title: "c" }, 4: { state: 7 }, 5: "junk" },
};

test("readTickets drops a state outside the set and keeps the rest of the ticket", () => {
  const t = readTickets(record);
  assert.equal(t["1"].state, "merged");
  assert.equal(t["2"].state, undefined);
  assert.equal(t["2"].note, "from an older kit");
  assert.equal(t["4"].state, undefined);
  assert.deepEqual(readTickets(undefined), {});
  assert.deepEqual(readTickets({ tickets: [1] }), {});
});

test("a state outside the set is in no needs-you or working count, only the total", () => {
  assert.deepEqual(runCounts(readTickets(record)), { working: 0, needsYou: 0, merged: 1, total: 5 });
});

test("the sidebar's run line reads each ticket's state through the guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-run-record-"));
  const root = join(dir, "project");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify(record));
  mkdirSync(join(dir, "runs"));
  writeFileSync(join(dir, "runs", "one"), root);
  const [run] = liveRuns(join(dir, "runs"), everyPidIsTheKit);
  assert.equal(run.tickets?.["2"].state, undefined);
  assert.equal(run.tickets?.["1"].state, "merged");
});

test("the report, gathered from a record on disk, puts a state outside the set in no section", async () => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const { gather } = await import("../src/report.ts");
  const { fakeTracker } = await import("./fixtures.ts");
  const root = mkdtempSync(join(tmpdir(), "sandcastle-run-record-report-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "t"], { cwd: root });
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  // Ended early (exit 1 at a stage other than "report"): a ticket in a phase is cut short, a stranger is not.
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({
      pid: 2 ** 22 + 1,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T01:00:00Z",
      exitCode: 1,
      stage: "implement",
      tickets: {
        "1": { state: "merged", title: "good" },
        "2": { state: STRANGE, title: "strange", started: 1 },
        "3": { state: "implement", title: "midway", started: 1 },
        "4": { state: "blocked", title: "waiting" },
      },
    }),
  );
  const project = {
    name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [],
    tracker: fakeTracker({ kind: "files" }),
  } as unknown as Project;
  const facts = await gather(project);
  assert.equal(facts.tickets["2"].state, undefined);
  const out = render(facts, true);
  assert.ok(!out.includes("strange"), out);
  assert.match(out, /Cut short when the run ended: .*3.*\(implement\)/);
  assert.ok(!/Cut short[^\n]*#2/.test(out), out);
});

test("the end-of-run notification never counts a state outside the set as needing a person", () => {
  const run = { exitCode: 0, tickets: readTickets({ tickets: { 1: { state: STRANGE }, 2: { state: "merged" } } }) } satisfies RunRecord;
  assert.match(endSummary(run), /1 merged, 0 need you, 0 need fixing, of 2/);
});
