// Whether a landing is near, as the scheduler (createSchedule in src/schedule.ts) tells it for the machine pool's kept
// slot: on from a ticket's `at.gates()` and from a green branch's push, on while a green is queued or landing, off when the
// last landing settles with no ticket in its gates, and off for a ticket that goes back to a repair or review. Told when it
// changes. Fake work, no git, no Docker, no network.
//
//   pnpm test:file test/schedule-landing-near.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Attempted, type Change, createSchedule, type Plan, type Work } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };
type B = string;

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !ok(); i++) await tick();
  assert.ok(ok(), `timed out waiting for ${what}`);
};
const later = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

const nears = (told: Change<G, string, B>[]) => told.flatMap((c) => (c.kind === "landing near" ? [c.near] : []));

const start = (ids: string[], o: { attempt: Work<T, G, string, B>["attempt"]; land?: Work<T, G, string, B>["land"] }) => {
  const told: Change<G, string, B>[] = [];
  const plan: Plan<T, B> = { tickets: ids.map((id) => ({ id })), blockers: { held: [], ticketOf: (b) => b, open: async () => [] } };
  const done = createSchedule<T, G, string, B>(plan).run({
    workers: 4,
    attempt: o.attempt,
    land: o.land ?? (async () => ({ kind: "merged" }) as const),
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  return { told, done };
};

test("no landing is near for a ticket still implementing, and one is from its gates until it ends", async () => {
  const implementing = later();
  const gates = later();
  const { told, done } = start(["1"], {
    attempt: async (t, at) => {
      await implementing.opened;
      at.gates();
      await gates.opened;
      return { kind: "pipeline", outcome: "red", attempts: 1 } as unknown as Attempted<G, string>;
    },
  });
  await tick();
  assert.deepEqual(nears(told), []);
  implementing.open();
  await until(() => nears(told).length === 1, "the signal at the gates");
  assert.deepEqual(nears(told), [true]);
  gates.open();
  await done;
  assert.deepEqual(nears(told), [true, false]);
});

test("a ticket that leaves its gates for a repair is no landing near until its next gate run", async () => {
  const repairing = later();
  const second = later();
  const { told, done } = start(["1"], {
    attempt: async (t, at) => {
      at.gates();
      await at.juncture("repair", { suspend: async () => {}, resume: async () => {} });
      await repairing.opened;
      at.gates();
      await second.opened;
      return green(t.id);
    },
  });
  await until(() => nears(told).length === 2, "the signal to go off at the repair");
  assert.deepEqual(nears(told), [true, false]);
  repairing.open();
  await until(() => nears(told).length === 3, "the signal to come back at the second gate run");
  assert.deepEqual(nears(told), [true, false, true]);
  second.open();
  await done;
  assert.equal(nears(told).at(-1), false);
});

test("a landing is near from a green's push, stays on while a green is queued, and goes off when the last landing settles", async () => {
  const landings = { "1": later(), "2": later() };
  const { told, done } = start(["1", "2"], {
    attempt: async (t) => green(t.id),
    land: async (g) => (await landings[g.issue as "1" | "2"].opened, { kind: "merged" } as const),
  });
  await until(() => nears(told).length === 1, "the signal at the first push");
  assert.deepEqual(nears(told), [true]);
  // The first landing ends with the second green still queued: still near, nothing told.
  landings["1"].open();
  await until(() => told.some((c) => c.kind === "ended" && c.id === "1"), "the first landing to settle");
  assert.deepEqual(nears(told), [true]);
  landings["2"].open();
  await done;
  assert.deepEqual(nears(told), [true, false]);
});
