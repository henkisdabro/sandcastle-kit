// The `.git` check after a pipeline's sandbox closed (burndown's `settleAfter`, in the pipeline's
// `finally`) can fail: the run stops. The ticket keeps its own ending all the same. Thrown from the
// `finally`, the check's error replaced a red or no-change pipeline's result, and the attempt
// recorded it as a finished branch that "lands on a later run" - the next run then found a red
// branch, or none. Each test runs a pipeline shaped as burndown's (its result, then the check in
// its `finally`), reports it as burndown's attempt does (`attempted`), and drives `createSchedule`
// with the real ledger over an in-memory run record. No Docker, no git, no network.
//
//   pnpm test:file test/settle-throw.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Outcome as Said, TicketRecord } from "../mod/hooks/run-record.ts";

// sandbox.ts and pool.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { attempted, settleAfter } = await import("../src/burndown.ts");
const { createLedger } = await import("../src/ledger.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Outcome = Parameters<typeof attempted>[1] extends PromiseSettledResult<infer O> ? O : never;

const result = (id: string, o: Partial<Outcome>): Outcome => ({
  issue: id,
  branch: `agent/issue-${id}`,
  status: "green",
  commits: 1,
  reviewCommits: 0,
  repairs: 0,
  gates: [{ name: "test", pass: true }],
  head: "abc1234",
  ...o,
});
const RED: Partial<Outcome> = { status: "gate-failed", gates: [{ name: "test", pass: false }] };
const MOVED = new Error("the shared .git changed after #1: main moved");

/** One ticket's run: its pipeline returns `ends` (or throws it), then the `.git` check after it fails. */
const run = async (ends: Outcome | Error) => {
  const records: Record<string, TicketRecord> = {};
  const outcomes: Record<string, Said> = {};
  const tampered = new Map<string, unknown>();
  // A pipeline as burndown ends one: what it did, then the check after its sandbox closed.
  const pipeline = async (id: string): Promise<Outcome> => {
    try {
      if (ends instanceof Error) throw ends;
      return ends;
    } finally {
      await settleAfter(
        () => Promise.reject(MOVED),
        (error) => tampered.set(id, error),
      );
    }
  };
  const ledger = createLedger({
    run: { ticket: (id, fields) => void (records[id] = { ...records[id], ...fields }) },
    outcomes: (o) => Object.assign(outcomes, o),
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  const landed: string[] = [];
  const { endings, stop } = await createSchedule<{ id: string }, Outcome, Outcome>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    // As burndown's attempt reports its pipeline: the result, and the check's failure kept for it.
    attempt: async (t) => {
      const r = await pipeline(t.id).then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const,
      );
      return attempted(t.id, r, tampered.has(t.id) ? { error: tampered.get(t.id) } : undefined);
    },
    land: async (g) => {
      landed.push(g.issue);
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => ledger.tell(c),
  });
  return { ending: endings.get("1"), record: records["1"], outcome: outcomes["1"], stop, landed };
};

test("a red pipeline whose .git check fails after it is recorded red, and the run stops", async () => {
  const r = await run(result("1", RED));
  assert.equal(r.ending?.kind, "pipeline");
  assert.deepEqual([r.record.state, r.record.note], ["red", "test red"]);
  assert.deepEqual(r.outcome, { kind: "gate red", text: "gate red: test=FAIL" });
  assert.equal(r.stop.landsNothing, true);
  assert.equal(r.stop.headline?.kind, "tampered");
});

test("a no-change pipeline whose .git check fails after it is recorded as nothing to change, and the run stops", async () => {
  const r = await run(result("1", { status: "nochange", commits: 0, gates: [] }));
  assert.deepEqual([r.record.state, r.record.note], ["nochange", "nothing to change"]);
  assert.deepEqual(r.outcome, { kind: "no change", text: "nochange" });
  assert.equal(r.stop.headline?.kind, "tampered");
});

test("a green pipeline whose .git check fails after it is finished, lands on a later run, and lands nothing now", async () => {
  const r = await run(result("1", {}));
  assert.equal(r.ending?.kind, "stopped");
  assert.deepEqual([r.record.state, r.record.note], ["stopped", "finished before the run stopped - lands on a later run"]);
  assert.equal(r.outcome?.kind, "stopped");
  assert.deepEqual(r.landed, []);
  assert.equal(r.stop.headline?.kind, "tampered");
});

test("a pipeline that crashed keeps its own error when the check after it fails too", async () => {
  const r = await run(new Error("idle timeout"));
  assert.equal(r.ending?.kind, "crashed");
  assert.deepEqual([r.record.state, r.record.note], ["crashed", "Error: idle timeout"]);
  assert.equal(r.stop.headline?.kind, "tampered");
});
