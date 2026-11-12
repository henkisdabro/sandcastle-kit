// A ticket gives up its place among the run's off-count gates waiters once it holds its gates slot (#845, a follow-up to #790):
// `GateProgress.onSlot` (src/gates.ts) fires as the slot is granted, burndown() hands it to the scheduler as `at.gateSlot()`
// (src/schedule.ts), and the cap `gateWaiters` then counts only tickets still waiting. A ticket that waits for a gates slot
// again while still off (a `regate`) counts again, past the cap. Driven through the scheduler's ports with a fake counted pool
// and a made-up sandbox. No git, no Docker, no network.
//
//   pnpm test:file test/gate-slot-uncounted.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGateSeat } from "../src/burndown.ts";
import type { Landed } from "../src/landing.ts";
import { type Attempted, createSchedule, type Slot } from "../src/schedule.ts";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { runGates } = await import("../src/gates.ts");

type T = { id: string };
type G = { issue: string };
type Seat = ReturnType<typeof createGateSeat>;

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const MERGED: Landed = { kind: "merged" };
const later = () => {
  let open!: () => void;
  const done = new Promise<void>((resolve) => (open = resolve));
  return { done, open };
};
const within = <R>(ms: number, what: string, p: Promise<R>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms).unref())]);

/** Plenty of counted slots: the cap, not the pool, is what these tests probe. */
const pool = () => ({
  slot: async (wanted: () => boolean): Promise<Slot | undefined> => (wanted() ? { release: () => {} } : undefined),
});

/** What burndown's attempt wires: a gate seat over the scheduler's ports, and the gates callbacks `wait` and `onSlot`. */
const wire = (at: { gateWait(): boolean; gateSlot(): void; retake(): Promise<{ slot?: Slot } | undefined>; slot?: Slot }) => {
  let lease = at.slot;
  const seat: Seat = createGateSeat({ gateWait: at.gateWait, retake: at.retake, uncount: (l) => (l.release(), { release: () => {} }) });
  return {
    seat,
    // The heartbeat's `wait` callback in burndown(): the first wait moves the slot off the count, a later one while off tells again.
    wait: () => {
      if (lease && seat.move(lease)) lease = undefined;
      else seat.waitAgain();
    },
    onSlot: () => at.gateSlot(),
  };
};

const run = (tickets: string[], attempt: Parameters<ReturnType<typeof createSchedule<T, G, string>>["run"]>[0]["attempt"]) =>
  createSchedule<T, G, string>({ tickets: tickets.map((id) => ({ id })) }).run({
    workers: 1,
    concurrency: 2,
    gateWaiters: 1,
    slot: pool().slot,
    land: async () => MERGED,
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
    attempt,
  });

test("with one off-count place, a second ticket moves off the count while the first runs its gates on its granted slot", async () => {
  const aGates = later();
  const answers: Record<string, boolean> = {};
  const { endings } = await within(
    3000,
    "the run",
    run(["A", "B"], async (t, at) => {
      const w = wire(at);
      if (t.id === "A") {
        w.wait();
        assert.equal(w.seat.off, true);
        w.onSlot();
        await aGates.done;
        return green(t.id);
      }
      // B starts on the worker A freed, while A's gates run.
      answers.B = at.gateWait();
      aGates.open();
      return green(t.id);
    }),
  );
  assert.equal(answers.B, true, "A holds its gates slot: the one off-count place is B's");
  assert.equal(endings.get("A")?.kind, "landing");
  assert.equal(endings.get("B")?.kind, "landing");
});

test("a ticket that waits for a gates slot again while off counts again: the second ticket's wait is refused", async () => {
  const bAsked = later();
  const aWaitsAgain = later();
  const answers: Record<string, boolean> = {};
  const { endings } = await within(
    3000,
    "the run",
    run(["A", "B"], async (t, at) => {
      const w = wire(at);
      if (t.id === "A") {
        w.wait();
        w.onSlot();
        // Red: the re-run (`regate`) waits for a gates slot again without a retake in between.
        w.wait();
        aWaitsAgain.open();
        await bAsked.done;
        return green(t.id);
      }
      await aWaitsAgain.done;
      answers.B = at.gateWait();
      bAsked.open();
      return green(t.id);
    }),
  );
  assert.equal(answers.B, false, "A's id is back in the count: the cap of one is spent");
  assert.equal(endings.get("B")?.kind, "landing");
});

test("a ticket that was refused its off-count place is not changed by its gates slot being granted", async () => {
  const hold = later();
  const answers: boolean[] = [];
  await within(
    3000,
    "the run",
    run(["A", "B", "C"], async (t, at) => {
      const w = wire(at);
      if (t.id === "A") {
        w.wait();
        await hold.done;
      } else if (t.id === "B") {
        w.wait();
        answers.push(w.seat.off);
        w.onSlot();
        // C's wait while B was refused: B never counted, A still does.
        answers.push(at.gateWait());
        hold.open();
      }
      return green(t.id);
    }),
  );
  assert.deepEqual(answers, [false, false]);
});

const twoGates = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }, { name: "unit", command: "run-unit" }] } as Parameters<typeof runGates>[0];
const box = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

test("runGates calls onSlot once, with the slot granted, before the first gate", async () => {
  const seen: string[] = [];
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "progress.log");
  await runGates(twoGates, box, "fixture gates", false, { log, onSlot: () => seen.push("slot"), gate: (_i, name) => seen.push(`gate ${name}`) });
  assert.deepEqual(seen, ["slot", "gate lint", "gate unit"]);
});

test("runGates calls onSlot before the first gate of a run that starts from a later gate", async () => {
  const seen: string[] = [];
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "progress.log");
  await runGates(twoGates, box, "fixture gates", false, { log, onSlot: () => seen.push("slot"), gate: (i, name) => seen.push(`gate ${i} ${name}`) }, false, "unit");
  assert.equal(seen[0], "slot");
  assert.equal(seen.filter((s) => s === "slot").length, 1);
  assert.ok(!seen.includes("gate 0 lint"), "the re-run starts at the later gate, so gate(0) never fires");
  assert.ok(seen.some((s) => s.endsWith("unit")));
});

test("source: burndown's ticket gates tell the scheduler at the slot grant, and a wait while off tells it again", () => {
  // burndown() needs Docker, so no test drives it: its wiring is held by its source.
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /onSlot: \(\) => \{\s*if \(!priority\) gateSlots\.get\(id\)\?\.\(\);/);
  assert.match(src, /gateSlots\.set\(issue\.id, gateSlot\);/);
  assert.match(src, /gateSlots\.delete\(issue\.id\);/);
  assert.match(src, /if \(lease && seat\.move\(lease\)\) lease = undefined;[\s\S]*?else seat\.waitAgain\(\);/);
});
