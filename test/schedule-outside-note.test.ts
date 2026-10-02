// The note of a held ticket that is not a candidate: it waits on a blocker in this run and on one
// outside it, so it never starts here and its blockers are never read again. As the in-run blocker
// ends, the scheduler tells its note again from the run's own endings - a landed blocker drops out,
// any other ending makes it "not in this run" - with no call to the blockers port. No git, no
// Docker, no network.
//
//   pnpm exec tsx --test test/schedule-outside-note.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attempted, Change } from "../src/schedule.ts";
import { createSchedule } from "../src/schedule.ts";
import { blockedNote, type Blocker } from "../src/blockers.ts";

type T = { id: string };
type G = { issue: string };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const blocker = (id: string): Blocker => ({ kind: "github", id }) as Blocker;

/** 1 is in the run; 2 waits on #1 (in the run) and #50 (outside it), so it is no candidate. */
const play = async (attempt: (id: string) => Attempted<G, string>) => {
  const told: Change<G, string, Blocker>[] = [];
  const asked: string[] = [];
  const schedule = createSchedule<T, G, string, Blocker>({
    tickets: [{ id: "1" }],
    blockers: {
      held: [{ ticket: { id: "2" }, on: [blocker("1"), blocker("50")] }],
      ticketOf: (b) => (b.kind === "github" ? b.id : undefined),
      open: async (ts) => {
        asked.push(ts.map((t) => t.id).join(","));
        return ts.map(() => []);
      },
    },
  });
  const { endings } = await schedule.run({
    workers: 1,
    attempt: async (t) => {
      await tick();
      return attempt(t.id);
    },
    land: async () => ({ kind: "merged" }) as const,
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  const notes = told.flatMap((c) => (c.kind === "blocked" && c.id === "2" ? [blockedNote(c.on, new Set(c.inFlight), new Set(c.landed))] : []));
  return { notes, asked, endings, schedule };
};

test("a blocker that landed drops out of the note of a ticket that also waits outside the run", async () => {
  const { notes, asked, endings } = await play((id) => green(id));
  assert.equal(endings.get("1")?.kind, "landing");
  assert.deepEqual(notes.at(-1), "waits for #50 (not in this run)");
  assert.ok(!notes.some((n) => n.includes("#1")), notes.join(" | "));
  // No lookup for a ticket that cannot start here.
  assert.deepEqual(asked, []);
});

test("a blocker that ended red reads not in this run, not lands this run", async () => {
  const { notes, asked } = await play(() => ({ kind: "pipeline", outcome: "gate red" }));
  assert.deepEqual(notes.at(-1), "waits for #1, #50 (not in this run)");
  assert.deepEqual(asked, []);
});

test("blockedNote leaves a landed blocker out rather than relabelling it", () => {
  const on = [blocker("1"), blocker("50")];
  assert.equal(blockedNote(on, new Set(["1"])), "waits for #1 (lands this run), #50 (not in this run)");
  assert.equal(blockedNote(on, new Set(), new Set(["1"])), "waits for #50 (not in this run)");
  assert.equal(blockedNote([blocker("1")], new Set(), new Set(["1"])), "waits for the next landing");
});
