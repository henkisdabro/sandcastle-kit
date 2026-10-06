// The pipeline queue (src/schedule.ts): items pushed while workers run are processed, `run`
// resolves only once the queue is closed and empty, and the worker count is respected. The
// scheduler that runs the queues is test/schedule-run.test.ts.
//
//   node --test test/schedule.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueue } from "../src/schedule.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("an item pushed while workers run is processed", async () => {
  const queue = createQueue<number>();
  const seen: number[] = [];
  queue.push(1);
  const done = queue.run(2, async (n) => {
    seen.push(n);
  });
  await tick();
  assert.deepEqual(seen, [1]);
  queue.push(2);
  queue.push(3);
  await tick();
  assert.deepEqual(seen.sort(), [1, 2, 3]);
  queue.close();
  await done;
});

test("run resolves only after close() and an empty queue", async () => {
  const queue = createQueue<string>();
  let resolved = false;
  const done = queue.run(3, async () => {}).then(() => (resolved = true));
  queue.push("a");
  await tick();
  assert.equal(resolved, false, "open and empty: workers wait");
  queue.close();
  await done;
  assert.equal(resolved, true);

  // Closed with items still queued: they are all taken first.
  const full = createQueue<number>();
  const seen: number[] = [];
  for (const n of [1, 2, 3, 4]) full.push(n);
  full.close();
  await full.run(1, async (n) => {
    await tick();
    seen.push(n);
  });
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(full.size, 0);
});

test("never more than the given number of workers at once", async () => {
  const queue = createQueue<number>();
  let active = 0;
  let most = 0;
  for (let n = 0; n < 8; n++) queue.push(n);
  queue.close();
  await queue.run(3, async () => {
    most = Math.max(most, ++active);
    await tick();
    await tick();
    active--;
  });
  assert.equal(most, 3);
});

test("falsy items are items, and a push after close is refused", async () => {
  const queue = createQueue<number>();
  const seen: number[] = [];
  queue.push(0);
  assert.equal(queue.closed, false);
  queue.close();
  // Read before a push, so a caller never has to undo what it wrote for an item the queue refused.
  assert.equal(queue.closed, true);
  assert.throws(() => queue.push(1), /closed/);
  await queue.run(2, async (n) => void seen.push(n));
  assert.deepEqual(seen, [0]);
});

test("a failing worker rejects run", async () => {
  const queue = createQueue<number>();
  queue.push(1);
  queue.close();
  await assert.rejects(queue.run(1, async () => Promise.reject(new Error("boom"))), /boom/);
});
