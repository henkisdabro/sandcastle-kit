// The note of a ticket held behind another held ticket, after a stop: the ticket it waits for never
// starts, so it is no longer "landing this run" and its note says it did not land. A chain 6 -> 4 -> 3
// where #3 is stopped; #4 and #6 never start and end as `waiting`. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-held-chain-note.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedNote } from "../src/blockers.ts";
import type { Blocker } from "../src/blockers.ts";
import { createSchedule, type Change } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const blocker = (id: string): Blocker => ({ kind: "github", id }) as Blocker;

test("a ticket held behind another held ticket no longer reads lands this run once the run stops", async () => {
  const told: Change<G, string, Blocker>[] = [];
  const schedule = createSchedule<T, G, string, Blocker>({
    tickets: [{ id: "3" }],
    blockers: {
      held: [
        { ticket: { id: "4" }, on: [blocker("3")] },
        { ticket: { id: "6" }, on: [blocker("4")] },
      ],
      ticketOf: (b) => (b.kind === "github" ? b.id : undefined),
      open: async (ts) => ts.map(() => []),
    },
  });
  const { endings } = await schedule.run({
    workers: 1,
    attempt: async () => ({ kind: "stopped", cause: { kind: "usage limit", line: "usage 97% of the 5-hour window" } }),
    land: async () => ({ kind: "merged" }) as const,
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  assert.equal(endings.get("4")?.kind, "waiting");
  assert.equal(endings.get("6")?.kind, "waiting");
  // As the run's ledger words it: #3 was stopped, #4 never began.
  const word = new Map([["3", "stopped"], ["4", "did not land"]]);
  const last = (id: string) => {
    const c = told.filter((x): x is Extract<typeof x, { kind: "blocked" }> => x.kind === "blocked" && x.id === id).at(-1);
    assert.ok(c, `no note told for #${id}`);
    return blockedNote(c.on, new Set(c.inFlight), new Set(c.landed), new Map(c.ended.map((e) => [e, word.get(e) ?? "?"])));
  };
  assert.equal(last("4"), "waits for #3 (stopped)");
  assert.equal(last("6"), "waits for #4 (did not land)");
});
