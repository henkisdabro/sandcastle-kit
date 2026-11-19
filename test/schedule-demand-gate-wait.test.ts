// A run's demand (createSchedule in src/schedule.ts) counts only the tickets that hold or ask for a counted sandbox
// slot. A ticket off its worker on an uncounted lock (`at.gateWait`, #790) holds none and asks for none until it retakes
// one (`at.retake`): counted, its run's share would cover slots it cannot use, and another run with tickets queued would
// be held at its share while those slots sit free (#1014). Driven through the scheduler's ports with a fake counted pool
// and fake work. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-demand-gate-wait.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, type Slot } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const MERGED: Landed = { kind: "merged" };
const later = () => {
  let open!: () => void;
  const done = new Promise<void>((resolve) => (open = resolve));
  return { done, open };
};
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("demand counts only the tickets that hold or ask for a counted slot: a gates wait off the count adds nothing until it retakes one", async () => {
  const told: Change<G, string>[] = [];
  const lastDemand = () => told.filter((c) => c.kind === "demand").at(-1);
  let counted = 0;
  const off = new Set<string>();
  const repair = later();
  const repaired = new Set<string>();
  const gates = later();
  const done = createSchedule<T, G, string>({ tickets: [{ id: "A" }, { id: "B" }, { id: "C" }] }).run({
    workers: 3,
    concurrency: 3,
    gateWaiters: 2,
    slot: async (wanted): Promise<Slot | undefined> => {
      if (!wanted()) return undefined;
      counted++;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          counted--;
        },
      };
    },
    attempt: async (t, at) => {
      if (t.id === "C") {
        await gates.done;
        at.slot?.release();
        return green(t.id);
      }
      at.gates();
      assert.equal(at.gateWait(), true);
      // What burndown's `uncountSlot` does: the counted slot goes, the sandbox lives on off the count.
      at.slot?.release();
      off.add(t.id);
      if (t.id === "A") {
        await repair.done;
        // A red gate claimed a repair: the agent pass needs a counted slot again.
        const taken = await at.retake();
        repaired.add(t.id);
        taken?.slot?.release();
      }
      await gates.done;
      return green(t.id);
    },
    land: async () => MERGED,
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  await until(() => off.size === 2, "A and B to move off the count");
  await until(() => counted === 1, "only C to hold a counted slot");
  assert.deepEqual(lastDemand(), { kind: "demand", n: 1 }, `one counted slot held, none queued: ${counted} held`);
  repair.open();
  await until(() => repaired.has("A"), "A to retake a slot");
  assert.deepEqual(lastDemand(), { kind: "demand", n: 2 }, "A's repair asks for a counted slot: a demand again");
  gates.open();
  const { endings } = await done;
  for (const id of ["A", "B", "C"]) assert.equal(endings.get(id)?.kind, "landing");
});
