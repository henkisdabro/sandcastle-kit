// The closing summary's "Landed on a second attempt" line says where the conflict that sent a ticket
// back was found: before its review, before its gates (the pipeline's merge check on the host) or at
// landing. The scheduler tells the requeue with the place, the ledger writes it into the ticket's
// `requeued` line, and the report words it from that line. A run record from before the place was kept
// says only "after a conflict". Fake attempt and land ports, the real scheduler, ledger and report.
//
//   pnpm test:file test/requeue-where.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLedger } = await import("../src/ledger.ts");
const { createSchedule } = await import("../src/schedule.ts");
const { render } = await import("../src/report.ts");
type Facts = Parameters<typeof render>[0];
type Landed = import("../src/landing.ts").Landed;
type Work = import("../src/schedule.ts").Work<Issue, Green, Done>;
type Found = import("../src/schedule.ts").Conflict["found"] | "landing";

type Issue = { id: string };
type Green = import("../src/landing.ts").Landable;
type Done = import("../src/ledger.ts").Finished;

/** One ticket whose first attempt conflicts where `found` says, and whose second attempt merges. Returns the closing summary's Done lines. */
const doneLines = async (found: Found) => {
  const landedOnce = new Set<string>();
  const tickets: Record<string, Record<string, unknown>> = {};
  const ledger = createLedger({
    run: { ticket: (id, fields) => void (tickets[id] = { ...tickets[id], ...fields }) },
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: (id) => `#${id}`,
    say: () => {},
  });
  const green = (id: string): Green => ({ issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0 });
  const finished = (id: string): Done => ({ ...green(id), status: "conflict", gates: [] });
  const work = {
    workers: 1,
    attempt: async (t, { n }) => {
      if (n === 2) return { kind: "green", green: green(t.id) };
      return found === "landing"
        ? { kind: "green", green: green(t.id) }
        : { kind: "conflict", outcome: finished(t.id), conflict: { files: ["shared.txt"], with: ["1"], found } };
    },
    land: async (g): Promise<Landed> => {
      // The first landing of a ticket that conflicts at landing collides; every other lands.
      const first = !landedOnce.has(g.issue);
      landedOnce.add(g.issue);
      return found === "landing" && first ? { kind: "conflict", files: ["shared.txt"], with: ["1"] } : { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => ledger.tell(c),
  } satisfies Partial<Work>;
  await createSchedule<Issue, Green, Done>({ tickets: [{ id: "2" }] }).run(work as Work);
  const out = render(facts(tickets as Facts["tickets"]), true);
  return out.split("\n").filter((l) => l.startsWith("Landed on a second attempt"));
};
const facts = (tickets: Facts["tickets"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 1,
  tickets,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  verify: { green: true, line: "test=pass" },
});

test("a conflict found before review says so on the second-attempt line", async () => {
  assert.deepEqual(await doneLines("review"), ["Landed on a second attempt: #2 (sent back after a conflict found before its review)"]);
});

test("a conflict found before gates says so on the second-attempt line", async () => {
  assert.deepEqual(await doneLines("gates"), ["Landed on a second attempt: #2 (sent back after a conflict found before its gates)"]);
});

test("a conflict found at landing says so on the second-attempt line", async () => {
  assert.deepEqual(await doneLines("landing"), ["Landed on a second attempt: #2 (sent back after a conflict at landing)"]);
});

test("an older run record, whose requeue line names no place, says none", () => {
  const out = render(facts({ "2": { state: "merged", requeued: "requeued after conflict with #1" } }), true);
  assert.ok(out.includes("Landed on a second attempt: #2 (sent back after a conflict)"), out);
});

test("tickets sent back from different places are named apart", () => {
  const out = render(
    facts({
      "2": { state: "merged", requeued: "requeued after conflict before review with #1" },
      "3": { state: "merged", requeued: "requeued after conflict at landing with #1" },
    }),
    true,
  );
  assert.ok(out.includes("Landed on a second attempt: #2 (sent back after a conflict found before its review); #3 (sent back after a conflict at landing)"), out);
});
