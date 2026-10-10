// A landing's sandbox slot is handed to the run's next queued landing instead of freed (`withSlot`'s
// `onward`, src/pool.ts): a freed slot goes to the longest wait across runs, and a landing queued behind the
// one in progress has not asked yet, so another run that had waited longer took the slot and the landing
// then waited behind it.
//
// This process is run A, run B is files (test/pool-sim.ts): B holds five of the six sandbox slots and has
// waited for a sixth for a minute, A's first landing holds the last.
//
//   pnpm test:file test/pool-landing-handoff.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, mine, other, pool, POLL, sleep, steady, until, waiting } from "./pool-sim.ts";

const { dropHandOff, handOffId, withSlot } = pool;

afterEach(async () => {
  dropHandOff(handOffId());
  await cleanup();
});

/** A landing of this run: holds its slot until `finish()`; `behind` says whether another landing is queued after it. */
const landing = (label: string, behind: () => boolean) => {
  let finish!: () => void;
  const hold = new Promise<void>((r) => (finish = r));
  const l = { taken: false, finish, done: undefined as unknown as Promise<void> };
  l.done = withSlot("sandboxes", label, async () => {
    l.taken = true;
    await hold;
  }, undefined, POLL, true, false, behind);
  l.done.catch(() => {});
  return l;
};

/** Run A's landing holds its slot; then run B holds the other five and has waited for a sixth longer than A's next landing will. */
const crowded = async (l: { taken: boolean }) => {
  await until(() => l.taken, "the landing's slot");
  other("run-b", { demand: 6, held: 5 });
  waiting("run-b", Date.now() - 60_000);
};

test("a landing queued behind the one in progress gets its slot though another run has waited longer", async () => {
  const first = landing("a-1 land", () => true);
  await crowded(first);
  first.finish();
  await first.done;
  assert.equal(mine(), 1, "the slot is still this run's, not in the pool");

  const second = landing("a-2 land", () => false);
  await until(() => second.taken, "the second landing's slot");
  assert.equal(mine(), 1);
  second.finish();
  await second.done;
  assert.equal(mine(), 0, "the last landing frees its slot");
});

test("a landing with none queued behind it frees its slot for the longest wait", async () => {
  const only = landing("a-1 land", () => false);
  await crowded(only);
  only.finish();
  await only.done;
  assert.equal(mine(), 0);
  assert.equal(handOffId(), undefined);
});

test("a slot handed on and not taken is freed when the next landing ends without one", async () => {
  const first = landing("a-1 land", () => true);
  await crowded(first);
  first.finish();
  await first.done;
  assert.equal(mine(), 1);
  dropHandOff(handOffId());
  assert.equal(mine(), 0);
});

test("a slot handed on is not taken by a ticket of the same run", async () => {
  const first = landing("a-1 land", () => true);
  await crowded(first);
  first.finish();
  await first.done;
  let ticketHolds = false;
  const ticket = withSlot("sandboxes", "a-3", async () => void (ticketHolds = true), undefined, POLL);
  ticket.catch(() => {});
  await steady(() => !ticketHolds && mine() === 1, "the handed-on slot stays with the landings");
  await sleep(POLL);
  dropHandOff(handOffId());
  await sleep(10);
});

// `burndown()` needs Docker and `landOne` a sandbox, so no test drives them: the wiring from the landing queue's size
// to the pool's `onward` is held at its call sites.
test("the landing queue's size reaches the pool's hand-on through every port", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(read("schedule.ts"), /ports\.land\(g, \(\) => queue\.size\)/);
  assert.match(read("burndown.ts"), /landingPorts\.land\(o, behind\)/);
  assert.match(read("landing.ts"), /landOne\(ctx, o, \{ slotWaited: [^}]*behind \}\)/);
  assert.match(read("landing.ts"), /true, false, \(\) => \(at\?\.behind\?\.\(\) \?\? 0\) > 0\)/);
});
