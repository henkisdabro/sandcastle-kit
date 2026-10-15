// A held ticket whose blocker read failed (it timed out, or its native blocker links could not be
// read) is read again after each later landing of the run, side by side with the ticket that
// waited for the landing, instead of staying held until the next run. Driven through
// `createSchedule` with fake ports: no tracker, no `gh`.
//
//   pnpm test:file test/release-unreadable-blockers.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Attempted, type Change, createSchedule, type Plan, type Work } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };
// A blocker names a ticket by id (a number is a ticket of the run, anything else is outside it);
// `unread` is a blocker whose read failed.
type B = { id: string; unread?: true };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const usage = { kind: "usage limit", line: "usage 97% of the 5-hour window" } as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const unreadable: B = { id: "X", unread: true };

type Open = NonNullable<NonNullable<Plan<T, B>["blockers"]>["open"]>;

/**
 * `held`: id -> what it waits for at the start. `delays`: how long each ticket's attempt takes, so
 * the landing order is the order of the delays. `answer` is asked for every `open` call, with the
 * ids it carries and the landed set; `asked` records the calls.
 */
const play = async (
  ids: string[],
  held: Record<string, B[]>,
  delays: Record<string, number>,
  answer: (ids: string[], landed: ReadonlySet<string>, call: number) => B[][] | Error,
  o: { attempt?: Work<T, G, string, B>["attempt"]; unread?: boolean } = {},
) => {
  const told: Change<G, string, B>[] = [];
  const order: string[] = [];
  const asked: string[] = [];
  const open: Open = async (ts, landed) => {
    const names = ts.map((t) => t.id);
    asked.push(`${names.join(",")} after ${[...landed].join(",")}`);
    const r = answer(names, landed, asked.length);
    if (r instanceof Error) throw r;
    return r;
  };
  const schedule = createSchedule<T, G, string, B>({
    tickets: ids.map((id) => ({ id })),
    blockers: {
      held: Object.entries(held).map(([id, on]) => ({ ticket: { id }, on })),
      ticketOf: (b) => (/^\d+$/.test(b.id) ? b.id : undefined),
      ...(o.unread === false ? {} : { unread: (b: B) => b.unread === true }),
      open,
    },
  });
  const { endings } = await schedule.run({
    workers: 8,
    attempt: async (t, at) => {
      order.push(`attempt ${t.id}`);
      await sleep(delays[t.id] ?? 1);
      return (o.attempt ?? (async () => green(t.id)))(t, at);
    },
    land: async (g) => {
      order.push(`land ${g.issue}`);
      return { kind: "merged" } as const;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  const lines = told.flatMap((c) => (c.kind === "unreleased" ? [`unreleased ${c.id}`] : c.kind === "ended" ? [`ended ${c.id}`] : []));
  return { endings, order, asked, lines };
};

// 1 and 2 are in the run; 4 is held on 1. The first landing's read of 4 times out.
test("a dependant whose blocker read timed out starts at the next landing whose read answers", async () => {
  const { order, endings, asked } = await play(["1", "2"], { 4: [{ id: "1" }] }, { 1: 5, 2: 60 }, (_ids, _landed, call) => (call === 1 ? [[unreadable]] : [[]]));
  assert.deepEqual(asked, ["4 after 1", "4 after 1,2"]);
  assert.ok(order.indexOf("attempt 4") > order.indexOf("land 2"), order.join(" | "));
  assert.ok(order.includes("land 4"), order.join(" | "));
  assert.equal(endings.get("4")?.kind, "landing");
});

test("a dependant still unreadable at every landing never begins, and waits for the next run as before", async () => {
  const { order, endings, asked } = await play(["1", "2"], { 4: [{ id: "1" }] }, { 1: 5, 2: 60 }, () => [[unreadable]]);
  assert.deepEqual(asked, ["4 after 1", "4 after 1,2"]);
  assert.ok(!order.includes("attempt 4"), order.join(" | "));
  assert.deepEqual(endings.get("4"), { kind: "waiting", on: "blockers" });
});

test("a ticket held from the start behind an unreadable blocker is never read again", async () => {
  // 5 also waits outside the run (its blocker could not be read at the start): it is the next run's.
  const { order, asked } = await play(["1", "2"], { 5: [{ id: "1" }, unreadable] }, { 1: 5, 2: 40 }, () => []);
  assert.deepEqual(asked, []);
  assert.ok(!order.includes("attempt 5"), order.join(" | "));
});

test("one landing makes one read, of the tickets that waited for it and the unread ones together", async () => {
  // 4 waits for 1, 6 waits for 2; 4 is read unreadable after 1's landing.
  const { asked, order } = await play(["1", "2"], { 4: [{ id: "1" }], 6: [{ id: "2" }] }, { 1: 5, 2: 60 }, (ids, _landed, call) => ids.map((id) => (id === "4" && call === 1 ? [unreadable] : [])));
  assert.deepEqual(asked, ["4 after 1", "4,6 after 1,2"]);
  assert.ok(order.includes("land 4") && order.includes("land 6"), order.join(" | "));
});

test("a run that starts nothing asks nothing after a landing", async () => {
  // 9 finds a usage limit after 1 has landed and 4 was read unreadable; 2 then lands.
  const { asked, order } = await play(
    ["1", "2", "9"],
    { 4: [{ id: "1" }] },
    { 1: 5, 2: 120, 9: 60 },
    () => [[unreadable]],
    { attempt: async (t) => (t.id === "9" ? { kind: "not begun", why: usage } : green(t.id)) },
  );
  assert.deepEqual(asked, ["4 after 1"]);
  assert.ok(order.includes("land 2") && !order.includes("attempt 4"), order.join(" | "));
});

test("without the port the unread ticket is read only when a blocker it waited for lands", async () => {
  const { asked } = await play(["1", "2"], { 4: [{ id: "1" }] }, { 1: 5, 2: 60 }, () => [[unreadable]], { unread: false });
  assert.deepEqual(asked, ["4 after 1"]);
});

test("the last pipeline's pane stays open while an unread ticket may be freed by the ticket in flight", async () => {
  let lastWhileUnread: boolean | undefined;
  let waitUntil = 0;
  const { asked } = await play(
    ["1", "2"],
    { 4: [{ id: "1" }] },
    { 1: 5, 2: 1 },
    () => {
      waitUntil = Date.now();
      return [[unreadable]];
    },
    {
      attempt: async (t, at) => {
        if (t.id === "2") {
          // After 1's landing has read 4 as unreadable.
          while (!waitUntil) await sleep(5);
          lastWhileUnread = at.last();
        }
        return green(t.id);
      },
    },
  );
  assert.equal(asked.length >= 1, true);
  assert.equal(lastWhileUnread, false);
});

test("a read that throws leaves the unread ticket unread for the next landing, and tells no line for a landing nothing waited for", async () => {
  // 4 waits for 1 (unreadable after it); 2's landing throws; 3's landing answers.
  const { order, lines, asked } = await play(
    ["1", "2", "3"],
    { 4: [{ id: "1" }] },
    { 1: 5, 2: 60, 3: 120 },
    (_ids, _landed, call) => (call === 1 ? [[unreadable]] : call === 2 ? new Error("gh: HTTP 502") : [[]]),
  );
  assert.deepEqual(asked, ["4 after 1", "4 after 1,2", "4 after 1,2,3"]);
  // Nothing waited for 2: a line saying its dependants wait for the next run would name none, and 4 is read again.
  assert.deepEqual(lines.filter((l) => l.startsWith("unreleased")), []);
  assert.ok(order.indexOf("attempt 4") > order.indexOf("land 3"), order.join(" | "));
});

test("a read that throws at a landing a ticket waited for is told for that landing, and the unread one is read again", async () => {
  // 4 is unreadable after 1's landing; 6 waits for 2, whose read throws; 3's landing answers 4.
  const { order, lines, asked } = await play(
    ["1", "2", "3"],
    { 4: [{ id: "1" }], 6: [{ id: "2" }] },
    { 1: 5, 2: 60, 3: 120 },
    (ids, _landed, call) => (call === 1 ? [[unreadable]] : call === 2 ? new Error("gh: HTTP 502") : ids.map(() => [])),
  );
  assert.deepEqual(asked, ["4 after 1", "4,6 after 1,2", "4 after 1,2,3"]);
  assert.deepEqual(lines.filter((l) => l.startsWith("unreleased")), ["unreleased 2"]);
  assert.ok(order.indexOf("attempt 4") > order.indexOf("land 3"), order.join(" | "));
  assert.ok(!order.includes("attempt 6"), order.join(" | "));
});

test("burndown tells the scheduler which blockers were not read", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /blockers: \{ held: \[\.\.\.held\.values\(\)\], ticketOf: blockerTicket, unread: \(b\) => b\.state === "unreadable"/);
});
