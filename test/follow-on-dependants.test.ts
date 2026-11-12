// A late ticket held only by other late tickets joins the follow-on turn as their dependant, so
// `burndown` (which sees the named tickets only) can start it when its blocker lands.
// A fake tracker; no Docker, gh, model calls or network.
//
//   pnpm test:file test/follow-on-dependants.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { lateQueueLines, lateTickets } = await import("../src/autonomy.ts");
const { refOf } = await import("../src/tracker.ts");
type Tracker = import("../src/tracker.ts").Tracker;

const ticket = (id: string) => ({ id, title: `T${id}`, body: "", comments: [] });
const fake = (queue: string[]) => ({ ref: refOf, queued: () => queue.map(ticket) }) as unknown as Tracker;
const heldBy = (m: Record<string, string[]>) => async () => new Map(Object.entries(m));
const ids = async (queue: string[], m: Record<string, string[]>) => (await lateTickets(fake(queue), new Set(), heldBy(m))).map((t) => t.id);

test("late tickets blocked only by a late ticket join it, in queue order", async () => {
  assert.deepEqual(await ids(["3", "1", "4", "2"], { 3: ["1"], 4: ["1"] }), ["3", "1", "4", "2"]);
});

test("a late ticket with a blocker outside the late tickets stays out", async () => {
  assert.deepEqual(await ids(["3", "1", "4", "2"], { 3: ["1", "9"], 4: ["1"] }), ["1", "4", "2"]);
});

test("a chain of late tickets joins whole", async () => {
  assert.deepEqual(await ids(["1", "3", "4"], { 3: ["1"], 4: ["3"] }), ["1", "3", "4"]);
});

test("late tickets that hold each other give no turn", async () => {
  assert.deepEqual(await ids(["1", "2"], { 1: ["2"], 2: ["1"] }), []);
});

test("a held ticket with no blocker named stays out", async () => {
  assert.deepEqual(await ids(["1", "2"], { 2: [] }), ["1"]);
});

test("the closing lines name every late ticket the turn would take", async () => {
  const lines = await lateQueueLines(fake(["3", "1", "4", "2"]), new Set(), heldBy({ 3: ["1"], 4: ["1"] }));
  assert.deepEqual(lines, ["3", "1", "4", "2"].map((id) => `#${id} was queued after this run started: \`sandcastle run\` takes it`));
});
