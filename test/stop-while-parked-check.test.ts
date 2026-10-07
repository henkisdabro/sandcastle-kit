// A ticket parked by a pause when the run stops ends as parked, and the `.git` check after its sandbox
// closed (burndown's `settleAfter`, in the pipeline's `finally`) still runs. A failed check stops the
// run as after any other attempt. Dropped on the way to the scheduler, a `.git` change found after a
// stop that is not a safety stop (a usage limit) went unreported: the run kept landing, and no check
// closes it. The port is shaped as burndown's (its result, the check, `attempted`), the scheduler is
// `createSchedule`. No Docker, no git, no network.
//
//   node --test test/stop-while-parked-check.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { attempted, settleAfter } = await import("../src/burndown.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Outcome = Parameters<typeof attempted>[1] extends PromiseSettledResult<infer O> ? O : never;

const MOVED = new Error("the shared .git changed after #1: main moved");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("a parked ticket woken by a usage stop whose .git check fails after it stops the run's landing", async () => {
  let since: number | undefined;
  const log: string[] = [];
  let limit!: () => void;
  const limited = new Promise<void>((resolve) => (limit = resolve));
  let implement!: () => void;
  const implemented = new Promise<void>((resolve) => (implement = resolve));
  const tampered = new Map<string, unknown>();
  const done = createSchedule<{ id: string }, Outcome, Outcome>({ tickets: [{ id: "1" }, { id: "2" }] }).run({
    workers: 2,
    pause: { read: () => (since === undefined ? undefined : { since }), pollMs: 5 },
    attempt: async (t, at) => {
      log.push(`start ${t.id}`);
      // Ticket 2's check before its pass finds the plan's limit: a stop that lands on.
      if (t.id === "2") {
        await limited;
        return { kind: "not begun", why: { kind: "usage limit", line: "usage at 95%" } };
      }
      // As burndown's attempt reports its pipeline: the result, then the check after its sandbox closed.
      const r = await (async (): Promise<Outcome> => {
        try {
          await implemented;
          await at.juncture("review", { suspend: async () => void log.push("parked"), resume: async () => void log.push("resumed") });
          throw new Error("the parked ticket resumed");
        } finally {
          await settleAfter(
            () => Promise.reject(MOVED),
            (error) => tampered.set(t.id, error),
          );
        }
      })().then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const,
      );
      return attempted(t.id, r, tampered.has(t.id) ? { error: tampered.get(t.id) } : undefined);
    },
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  await until(() => log.includes("start 1") && log.includes("start 2"), "both tickets to start");
  since = 1_790_000_000;
  implement();
  await until(() => log.includes("parked"), "ticket 1 to park");
  limit();
  const { endings, stop } = await Promise.race([done, sleep(2000).then(() => assert.fail("the run stayed paused after the stop"))]);

  assert.equal(endings.get("1")?.kind, "parked");
  assert.deepEqual(log.filter((l) => !l.startsWith("start")), ["parked"], "no sandbox reopened");
  assert.equal(stop.landsNothing, true, "the .git change found after the parked ticket stops the landing");
  assert.equal(stop.headline?.kind, "tampered");
});
