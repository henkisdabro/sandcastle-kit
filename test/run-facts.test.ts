// Where the last run stands (src/view-facts.ts `runFacts`), printed as `run` beside the table and the frame by
// `sandcastle status --json --frame` for the Herdr app mod's status line, pause and resume, notifications and closing
// report (#961).
//
//   pnpm test:file test/run-facts.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runFacts } from "../src/view-facts.ts";
import { buildFixture } from "./status-fixture.ts";
import { spawnStatus, viewEnv } from "./status-run.ts";

const base = { root: "/work/shop", hasRecord: true, live: true, tickets: {} };
const tickets = { "1": { state: "merged" as const }, "2": { state: "implement" as const }, "3": { state: "conflict" as const } };

test("runFacts: none, running, paused, finished and ended, with the tab bar's line", () => {
  assert.equal(runFacts({ ...base, hasRecord: false, live: false, record: {} }).state, "none");
  const running = runFacts({ ...base, record: { startedAt: "2026-11-13T01:00:00Z", share: 3, orchestrator: "shop" }, tickets });
  assert.equal(running.state, "running");
  assert.equal(running.startedAt, "2026-11-13T01:00:00Z");
  assert.equal(running.line, "shop 1/3 · 1 working · 1 needs you · share 3");
  const paused = runFacts({ ...base, record: { paused: { at: "2026-11-13T02:00:00Z" } } as never, tickets });
  assert.equal(paused.state, "paused");
  assert.equal(paused.line, "shop 1/3 · paused · 1 needs you");
  const finished = runFacts({ ...base, live: false, record: { finishedAt: "2026-11-13T03:00:00Z" }, tickets });
  assert.deepEqual([finished.state, finished.finishedAt], ["finished", "2026-11-13T03:00:00Z"]);
  // A run that is not live has no share to speak of, and a pause it left behind is not a paused run.
  const ended = runFacts({ ...base, live: false, record: { share: 2, paused: { at: "x" } } as never, tickets });
  assert.equal(ended.state, "ended");
  assert.equal(ended.line, "shop 1/3 · 1 working · 1 needs you");
});

test("runFacts with the view's counts: a stalled ticket the record has implementing needs you in the line too", () => {
  const facts = runFacts({ ...base, record: { orchestrator: "shop" }, tickets }, { working: 0, "needs you": 2 });
  assert.equal(facts.line, "shop 1/3 · 2 needs you");
  assert.deepEqual([facts.counts.working, facts.counts.needsYou, facts.counts.merged, facts.counts.total], [0, 2, 1, 3]);
});

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-run-facts-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

test("status --json --frame carries the run's facts beside the table and the frame", () => {
  for (const [kind, state] of [["live", "running"], ["ended", "finished"]] as const) {
    const fixture = buildFixture(kind, mkdtempSync(join(TMP, `${kind}-`)));
    try {
      const r = spawnStatus(["--json", "--frame"], { encoding: "utf8", env: viewEnv(fixture), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      const doc = JSON.parse(r.stdout);
      assert.ok(doc.table && doc.frame, "the table and the frame stay");
      assert.equal(doc.run.state, state, kind);
      assert.match(doc.run.line, /\d+\/\d+/);
      assert.equal(doc.run.counts.needsYou, doc.table.counts["needs you"], `${kind}: the line agrees with the legend`);
    } finally {
      fixture.stop();
    }
  }
});
