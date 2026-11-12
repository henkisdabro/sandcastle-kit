// A resolve wait's log line is said on its first telling and again whenever a ticket joins its list - compared
// with the list last said, so one that leaves and comes back is not said twice - never when one only leaves
// it; and the heartbeat names what each waiting resolve waits for, and none once its wait is over (createSchedule in src/schedule.ts, the hold
// record and heartbeatLine in src/burndown.ts). The clock is the test's own (`now` of the plan's work); the
// scheduler's one-second wake-up is real time. No git, no Docker, no network.
//
//   pnpm test:file test/resolve-wait-line.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, RESOLVE_SETTLE_MS, type TicketFiles } from "../src/schedule.ts";

// src/burndown.ts reads the config and cache directories when it loads.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createHoldRecord, heartbeatLine } = await import("../src/burndown.ts");

type T = { id: string };
type G = { issue: string };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const later = () => {
  let open!: () => void;
  const done = new Promise<void>((resolve) => (open = resolve));
  return { done, open };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await sleep(20);
  assert.ok(ok(), what);
};

test("a resolve wait's line is said again when a ticket joins its list, not when one leaves it or comes back", async () => {
  let clock = 0;
  const said: string[] = [];
  const waits: Extract<Change<G, string>, { kind: "resolve waits" }>[] = [];
  const holds = createHoldRecord({ waiting: [], ref: (id) => `#${id}`, say: (line) => void said.push(line) });
  const record = { ticket: () => {}, update: () => {} };
  const requeued = later();
  const thirtyStarted = later();
  const twentyInGates = later();
  // 30's steps, each let through by the test: into its gates, out to a repair, into its gates again.
  const steps = [later(), later(), later()];
  const run20 = later();
  const run30 = later();
  let conflicted = false;
  const running = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }, { id: "30" }],
    files: { of: (): TicketFiles => ({ all: ["src/a.ts"], unmergeable: [] }) },
  }).run({
    workers: 3,
    now: () => clock,
    attempt: async (t, at) => {
      if (t.id === "20") {
        at.gates();
        twentyInGates.open();
        await run20.done;
      }
      if (t.id === "30") {
        // Implementing when 10 is sent back: it may join 10's list from its gates (a fresh start could not).
        thirtyStarted.open();
        await steps[0].done;
        at.gates();
        await steps[1].done;
        await at.juncture("repair");
        await steps[2].done;
        at.gates();
        await run30.done;
      }
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && !conflicted) {
        conflicted = true;
        await twentyInGates.done;
        await thirtyStarted.done;
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      if (c.kind === "requeued") requeued.open();
      if (c.kind === "resolve waits") {
        waits.push(c);
        holds.tell(record, c);
      }
    },
  });
  // Each list is seen at the scheduler's next one-second tick, then holds for the settling on the test's clock.
  const settle = async (n: number) => {
    await sleep(1200);
    clock += RESOLVE_SETTLE_MS;
    await until(`telling ${n}`, () => waits.length === n);
  };
  await requeued.done;
  await settle(1);
  steps[0].open();
  await settle(2);
  steps[1].open();
  await settle(3);
  steps[2].open();
  await settle(4);
  assert.deepEqual(
    waits.map((w) => w.for),
    [["20"], ["20", "30"], ["20"], ["20", "30"]],
  );
  // {20} said; {20, 30} gained 30, said again; {20} lost one; {20, 30} is the list last said: not again.
  assert.deepEqual(said, [
    "  #10 waits to resolve its conflict until #20 lands or leaves the run: a resolve made now would conflict again with the landing of a ticket that shares its files",
    "  #10 waits to resolve its conflict until #20, #30 land or leave the run: a resolve made now would conflict again with the landing of a ticket that shares its files",
  ]);
  run20.open();
  run30.open();
  const { endings } = await running;
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
});

test("the heartbeat names what each waiting resolve waits for", () => {
  const now = 10 * 60 * 60_000;
  const line = heartbeatLine({
    now,
    clock: "17:57",
    working: [],
    resolving: [
      { ref: "#10", since: now - 12 * 60_000, for: ["#20", "#30"] },
      { ref: "#11", since: now - 3 * 60_000, for: ["#10"] },
    ],
  });
  assert.equal(line, "[17:57] waiting to resolve a conflict: #10 12m (for #20, #30), #11 3m (for #10)");
});

test("a resolve whose wait is over, queued for a free slot, names on the heartbeat no ticket it waited for", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  // burndown() needs Docker: its tell is held by its source. Its list goes at `resolve queued`, its time stays.
  assert.match(source, /if \(c\.kind === "resolve queued" && resolving\.has\(c\.id\)\) resolving\.set\(c\.id, \{ since: resolving\.get\(c\.id\)!\.since, for: \[\] \}\);\n\s+switch \(c\.kind\)/);
  const now = 10 * 60 * 60_000;
  assert.equal(heartbeatLine({ now, clock: "17:57", working: [], resolving: [{ ref: "#10", since: now - 12 * 60_000, for: [] }] }), "[17:57] waiting to resolve a conflict: #10 12m");
});
