// A ticket sent back twice whose third attempt never begins (#398's exception allows the third): the
// scheduler's ending counts the two attempts that began and says the last one never did (`unstarted`),
// and the ledger (createLedger in src/ledger.ts) reads it as it reads a second attempt that never began -
// withdrawn since, it is recorded as withdrawn before it started, its first pipeline's line dropped, and
// either way the record no longer promises another attempt. Driven through `createSchedule(plan).run(work)`
// with fake attempts and landings and the real ledger over a run record in a temp dir. No Docker, no
// model, no network.
//
//   node --test test/ledger-third-attempt-unstarted.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLedger } = await import("../src/ledger.ts");
const { recordRun } = await import("../src/run.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Project = import("../src/config.ts").Project;
type Landed = import("../src/landing.ts").Landed;
type Waiting = import("../src/landing.ts").Waiting;
type Finished = import("../src/ledger.ts").Finished;
type Attempted = import("../src/schedule.ts").Attempted<Waiting, Finished>;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-third-attempt-"));
// recordRun finishes its record in an exit handler: the temp directory goes after it.
let n = 0;
let cleanup = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};
const waiting = (id: string): Waiting => ({ issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0 });

/** 2 meets 1, then on its second try meets 3, which landed after its resolve began: its third attempt ends as `third`. */
const sentBackTwice = async (third: Attempted) => {
  const project = { root: join(TMP, `record${n++}`), name: "fixture" } as unknown as Project;
  const run = recordRun(project);
  if (!cleanup) {
    cleanup = true;
    process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
  }
  const written = () => JSON.parse(readFileSync(join(project.root, ".sandcastle/logs/run.json"), "utf8")).tickets ?? {};
  const dropped: string[] = [];
  const ledger = createLedger({
    run,
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: (id) => void dropped.push(id),
    ref: (id) => `#${id}`,
    say: () => {},
  });
  const log: string[] = [];
  const landed = new Set<string>();
  const lands: Record<string, number> = {};
  const { endings } = await createSchedule<{ id: string }, Waiting, Finished>({ tickets: [{ id: "1" }, { id: "2" }, { id: "3" }] }).run({
    workers: 3,
    attempt: async (t, at) => {
      log.push(`attempt ${t.id}#${at.n}`);
      if (t.id === "2" && at.n === 1) await until(() => landed.has("1"), "1 to land");
      if (t.id === "2" && at.n === 2) await until(() => landed.has("3"), "3 to land");
      if (t.id === "2" && at.n === 3) return third;
      if (t.id === "3") await until(() => log.includes("attempt 2#2"), "2's second attempt to begin");
      return { kind: "green", green: waiting(t.id) };
    },
    land: async (g): Promise<Landed> => {
      lands[g.issue] = (lands[g.issue] ?? 0) + 1;
      if (g.issue === "2" && lands["2"] === 1) return { kind: "conflict", files: ["a.txt"], with: ["1"] };
      if (g.issue === "2" && lands["2"] === 2) return { kind: "conflict", files: ["b.txt"], with: ["3"] };
      landed.add(g.issue);
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => ledger.tell(c),
  });
  assert.ok(log.includes("attempt 2#3"), "a third attempt was asked for");
  return { ending: endings.get("2"), record: written()["2"], dropped };
};

test("withdrawn before a third attempt begins: recorded as withdrawn, not started, and its first pipeline's line dropped", async () => {
  const r = await sentBackTwice({ kind: "not begun", why: { kind: "withdrawn", reason: "closed during the run" } });
  assert.equal(r.ending?.kind === "landing" && r.ending.attempts, 2);
  assert.equal(r.ending?.kind === "landing" && r.ending.landed.kind, "withdrawn");
  assert.equal(r.record.state, "withdrawn");
  assert.equal(r.record.note, "closed - not started");
  assert.equal(r.record.requeued, null);
  assert.deepEqual(r.dropped, ["2"]);
});

test("a third attempt the run's stop keeps from beginning: the second landing stands, and the record promises no other attempt", async () => {
  const r = await sentBackTwice({ kind: "not begun", why: { kind: "usage limit", line: "usage 97% of the 5-hour window" } });
  assert.equal(r.ending?.kind === "landing" && r.ending.landed.kind, "conflict");
  assert.equal(r.record.state, "conflict");
  assert.equal(r.record.requeued, null);
  assert.deepEqual(r.dropped, []);
});
