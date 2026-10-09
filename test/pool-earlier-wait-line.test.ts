// A wait that leaves the slot to an earlier wait of its own run says why only when the pool is full: with a free
// slot the earlier wait is about to take, the line "an earlier wait of this run goes first" named the queueing
// order and hid what held the first wait, so it is not printed.
//
//   pnpm test:file test/pool-earlier-wait-line.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { cleanup, pool, said, setHeld, sleep, ticket, until } from "./pool-sim.ts";

const { inject, joinPool } = pool;

inject({ probe: everyPidIsTheKit, now: () => Date.now() });
afterEach(cleanup);

const lines = () => said.filter((l) => l.includes("waiting for a machine-wide sandboxes slot"));

test("the second of two waits names the full pool, not the queue order", async () => {
  joinPool("alpha", 6, 6);
  setHeld("beta", 6);
  const first = ticket("first");
  await until(() => first.why.length === 1, "the first wait");
  const second = ticket("second");
  await until(() => second.why.length === 1, "the second wait");
  await sleep(30);
  assert.equal(lines().length, 2);
  assert.match(lines()[0]!, /first: .*\(6 in use\)/);
  assert.match(lines()[1]!, /second: .*\(6 in use\)/);
  assert.ok(lines().every((l) => !l.includes("earlier wait")));
});

test("a wait behind its own run's earlier wait prints nothing while a slot is free, then the full pool's reason", async () => {
  joinPool("alpha", 6, 6);
  setHeld("beta", 6);
  const first = ticket("first");
  await until(() => first.why.length === 1, "the first wait");
  // A slot frees and, in the same tick, a second wait begins: the first has not looked yet, so the slot is the first's.
  setHeld("beta", 5);
  const second = ticket("second");
  assert.ok(!first.taken);
  await until(() => first.taken, "the first wait to take the free slot");
  assert.ok(lines().every((l) => !l.includes("second:") || !l.includes("earlier wait")), "the queue order is never the reason");
  await until(() => lines().some((l) => l.includes("second:")), "the second wait's line");
  assert.match(lines().filter((l) => l.includes("second:"))[0]!, /second: .*\(6 in use\)/, "said once the pool is full");
  assert.ok(second.why.length >= 1);
});
