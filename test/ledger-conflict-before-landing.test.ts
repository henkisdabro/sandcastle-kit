// A conflict found before landing (the pipeline's check on the host, before review or the gates) as the
// scheduler ends it and the ledger records it: sent back once, then final; sent back and never begun
// again, it keeps its conflict - or, withdrawn since, is withdrawn - and the record no longer promises a
// second attempt; the closing counts read it as not landed. Driven through `createSchedule(plan).run(work)`
// with fake attempts and the real ledger (createLedger in src/ledger.ts) over a run record in a temp dir.
// No Docker, no model, no network.
//
//   node --test test/ledger-conflict-before-landing.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { accountLanding, createLedger, describe } = await import("../src/ledger.ts");
const { recordRun } = await import("../src/run.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Project = import("../src/config.ts").Project;
type Landed = import("../src/landing.ts").Landed;
type Waiting = import("../src/landing.ts").Waiting;
type Finished = import("../src/ledger.ts").Finished;
type Attempted = import("../src/schedule.ts").Attempted<Waiting, Finished>;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-conflict-ledger-"));
// recordRun finishes its record in an exit handler: the temp directory goes after it.
let n = 0;
let cleanup = false;

const CONFLICT = { files: ["a.txt"], with: ["1"] };
const conflicted: Finished = { issue: "2", branch: "agent/issue-2", status: "conflict", conflict: CONFLICT, commits: 1, repairs: 0, gates: [] };
const conflict: Attempted = { kind: "conflict", outcome: conflicted, conflict: CONFLICT };

/** Ticket 2's attempts, in order, under the scheduler and the real ledger: its ending, its record, the lines said and the first pipelines dropped. */
const ticket2 = async (attempts: Attempted[]) => {
  const project = { root: join(TMP, `record${n++}`), name: "fixture" } as unknown as Project;
  const run = recordRun(project);
  if (!cleanup) {
    cleanup = true;
    process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
  }
  const said: string[] = [];
  const dropped: string[] = [];
  const ledger = createLedger({
    run,
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: (id) => void dropped.push(id),
    ref: (id) => `#${id}`,
    say: (line) => void said.push(line),
  });
  const tried: number[] = [];
  const { endings } = await createSchedule<{ id: string }, Waiting, Finished>({ tickets: [{ id: "2" }] }).run({
    workers: 1,
    attempt: async (_t, at) => {
      tried.push(at.n);
      return attempts[at.n - 1];
    },
    land: async (): Promise<Landed> => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: (c) => ledger.tell(c),
  });
  const record = JSON.parse(readFileSync(join(project.root, ".sandcastle/logs/run.json"), "utf8")).tickets?.["2"];
  return { ending: endings.get("2"), record, said, dropped, tried, counts: accountLanding(ledger.entries.values()) };
};

test("a conflict before landing is sent back once; the second ends the ticket as a conflict, said as one at landing is", async () => {
  const r = await ticket2([conflict, conflict]);
  assert.deepEqual(r.tried, [1, 2]);
  assert.equal(r.ending?.kind, "conflict");
  assert.deepEqual(r.ending?.kind === "conflict" && r.ending.again, { kind: "conflict", with: ["1"] });
  assert.equal(r.record.state, "conflict");
  assert.equal(r.record.note, "conflicted again with #1 after a requeue: a.txt");
  assert.deepEqual(r.record.files, ["a.txt"]);
  assert.deepEqual(r.said, ["#2: requeued after conflict with #1; it is tried again in this run.", "#2: merge conflict."]);
  assert.equal(r.counts.notLanded, 1);
});

test("sent back, and the run's stop keeps the second attempt from beginning: the conflict stands, and no other attempt is promised", async () => {
  const r = await ticket2([conflict, { kind: "not begun", why: { kind: "usage limit", line: "usage 97% of the 5-hour window" } }]);
  assert.equal(r.ending?.kind === "conflict" && r.ending.unstarted, true);
  assert.equal(r.ending?.kind === "conflict" && r.ending.attempts, 1);
  assert.equal(r.record.state, "conflict");
  assert.equal(r.record.note, "no longer merges onto main: with #1: a.txt");
  assert.equal(r.record.requeued, null);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.counts.notLanded, 1);
});

test("sent back, and withdrawn before the second attempt begins: recorded as withdrawn, its first pipeline's line dropped", async () => {
  const r = await ticket2([conflict, { kind: "not begun", why: { kind: "withdrawn", reason: "closed during the run" } }]);
  assert.equal(r.ending?.kind === "conflict" && r.ending.withdrawn, "closed during the run");
  assert.equal(r.record.state, "withdrawn");
  assert.equal(r.record.note, "closed - not started");
  assert.equal(r.record.requeued, null);
  assert.deepEqual(r.dropped, ["2"]);
  assert.equal(r.counts.withdrawn, 1);
  assert.equal(r.counts.notLanded, 0);
});

test("a conflict before landing names no ticket when none landed over its files", () => {
  const s = describe({ kind: "conflict", outcome: conflicted, conflict: { files: ["a.txt", "b.txt"], with: [] }, attempts: 1 }, { base: "main", gateNames: "test" });
  assert.deepEqual(s.record, { state: "conflict", note: "no longer merges onto main: a.txt, b.txt", files: ["a.txt", "b.txt"] });
  assert.deepEqual(s.outcome, { kind: "conflict", text: "merge conflict before landing: a.txt, b.txt" });
});
