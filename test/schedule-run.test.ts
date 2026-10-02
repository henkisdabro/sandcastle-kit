// The run's scheduler (createSchedule in src/schedule.ts), driven through its interface with fake
// work: every ticket the run took in gets exactly one ending of a typed kind, `last()` says when
// nothing more will start, a first conflict is told as requeued before its second attempt, and a
// cause reaches the stop state only from a port's result or the host's failure read live. No git,
// no Docker, no network.
//
//   pnpm exec tsx --test test/schedule-run.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { OperatorError } from "../src/errors.ts";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, type Ending, type Plan, type Work } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string; carried?: boolean };
type O = string;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const green = (id: string): Attempted<G, O> => ({ kind: "green", green: { issue: id } });
const usage = { kind: "usage limit", line: "usage 97% of the 5-hour window" } as const;

/** Runs `ids` with fake work: `attempt` and `land` default to green and merged. Returns what was told, in order. */
const play = async (
  ids: string[],
  o: {
    attempt?: Work<T, G, O>["attempt"];
    land?: (g: G) => Promise<Landed>;
    host?: Work<T, G, O>["host"];
    workers?: number;
    later?: Plan<T>["later"];
    checkLabel?: Plan<T>["checkLabel"];
    release?: Plan<T>["release"];
  } = {},
) => {
  const told: Change<G, O>[] = [];
  const order: string[] = [];
  const { endings, stop } = await createSchedule<T, G, O>({ tickets: ids.map((id) => ({ id })), later: o.later, checkLabel: o.checkLabel, release: o.release }).run({
    workers: o.workers ?? ids.length,
    attempt: async (t, at) => {
      order.push(`attempt ${t.id}#${at.n}`);
      return (o.attempt ?? (async () => green(t.id)))(t, at);
    },
    land: async (g) => {
      order.push(`land ${g.issue}`);
      return (o.land ?? (async () => ({ kind: "merged" }) as Landed))(g);
    },
    host: o.host ?? { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  return { endings, stop, told, order };
};

const kinds = (endings: Map<string, Ending<G, O>>) => Object.fromEntries([...endings].map(([id, e]) => [id, e.kind]));

test("every ticket the run took in gets exactly one ending, of a typed kind", async () => {
  const { endings, told } = await play(["1", "2", "3", "4", "5"], {
    later: [
      { ticket: { id: "8" }, on: "file" },
      { ticket: { id: "9" }, on: "blockers" },
    ],
    attempt: async (t) => {
      if (t.id === "2") return { kind: "pipeline", outcome: "gate red" };
      if (t.id === "3") return { kind: "crashed", error: new Error("agent died") };
      if (t.id === "4") return { kind: "not begun", why: { kind: "withdrawn", reason: "ticket closed during the run" } };
      return green(t.id);
    },
    land: async (g) => (g.issue === "5" ? { kind: "held", paths: [".github/workflows/ci.yml"], reason: "human merge" } : { kind: "merged" }),
  });
  assert.deepEqual(kinds(endings), { 1: "landing", 2: "pipeline", 3: "crashed", 4: "not begun", 5: "landing", 8: "waiting", 9: "waiting" });
  assert.deepEqual(endings.get("1"), { kind: "landing", green: { issue: "1" }, landed: { kind: "merged" }, attempts: 1 });
  assert.deepEqual(endings.get("2"), { kind: "pipeline", outcome: "gate red", attempts: 1 });
  assert.deepEqual(endings.get("8"), { kind: "waiting", on: "file" });
  assert.deepEqual(endings.get("9"), { kind: "waiting", on: "blockers" });
  // Each ending is told once, as it happens.
  const ended = told.flatMap((c) => (c.kind === "ended" ? [c.id] : []));
  assert.deepEqual([...ended].sort(), ["1", "2", "3", "4", "5"]);
});

test("last() is false while more may start, and true once the queue is empty or the run starts nothing", async () => {
  // One worker, three tickets: the first two attempts have more behind them, the last has none.
  const seen: Record<string, boolean> = {};
  await play(["1", "2", "3"], {
    workers: 1,
    attempt: async (t, { last }) => {
      seen[t.id] = last();
      return green(t.id);
    },
  });
  assert.deepEqual(seen, { 1: false, 2: false, 3: true });

  // A ticket that may still be freed keeps the pane open.
  let more = true;
  const held: Record<string, boolean> = {};
  await play(["1"], {
    attempt: async (t, { last }) => {
      held[t.id] = last();
      return green(t.id);
    },
    release: (s) => ({
      afterLanding: () => {
        more = false;
        s.finish();
      },
      get more() {
        return more;
      },
    }),
  });
  assert.deepEqual(held, { 1: false });

  // 2 finds a usage limit before it begins; 1, still running, then has 3 behind it but nothing will start it.
  const stopped: Record<string, boolean> = {};
  let found!: () => void;
  const limit = new Promise<void>((resolve) => (found = resolve));
  const { endings } = await play(["1", "2", "3"], {
    workers: 2,
    attempt: async (t, { last }) => {
      if (t.id === "2") {
        found();
        return { kind: "not begun", why: usage };
      }
      await limit;
      await tick();
      stopped[t.id] = last();
      return green(t.id);
    },
  });
  assert.deepEqual(stopped, { 1: true });
  assert.deepEqual(kinds(endings), { 1: "landing", 2: "not begun", 3: "not begun" });
  assert.deepEqual(endings.get("3"), { kind: "not begun", why: usage });
});

test("a first conflict is told as requeued before its second attempt, which carries it; a second is final", async () => {
  let landings = 0;
  const { endings, told, order } = await play(["2"], {
    land: async () => (++landings === 1 ? { kind: "conflict", files: ["shared.txt"], with: ["1"] } : { kind: "conflict", files: ["other.txt"], with: ["3"] }),
    attempt: async (t, at) => {
      if (at.n === 2) assert.deepEqual(at.again, { kind: "conflict", with: ["1"] });
      return green(t.id);
    },
  });
  assert.deepEqual(order, ["attempt 2#1", "land 2", "attempt 2#2", "land 2"]);
  assert.deepEqual(
    told.filter((c) => c.kind !== "landing").map((c) => c.kind),
    ["requeued", "ended"],
  );
  assert.deepEqual(told.find((c) => c.kind === "requeued"), { kind: "requeued", id: "2", again: { kind: "conflict", with: ["1"] } });
  // Both attempts' tickets are named.
  assert.deepEqual(endings.get("2"), {
    kind: "landing",
    green: { issue: "2" },
    landed: { kind: "conflict", files: ["other.txt"], with: ["1", "3"] },
    attempts: 2,
    again: { kind: "conflict", with: ["1"] },
  });
});

test("after a usage stop a conflict at landing is not requeued, and a green ticket still lands", async () => {
  // 1 reports the limit before it begins; 2 and 3 were already running, and land after it.
  let found!: () => void;
  const limit = new Promise<void>((resolve) => (found = resolve));
  const { endings, told, stop } = await play(["1", "2", "3"], {
    attempt: async (t) => {
      if (t.id === "1") {
        found();
        return { kind: "not begun", why: usage };
      }
      await limit;
      return green(t.id);
    },
    land: async (g) => (g.issue === "2" ? { kind: "conflict", files: ["shared.txt"], with: ["9"] } : { kind: "merged" }),
  });
  assert.equal(told.some((c) => c.kind === "requeued"), false);
  assert.deepEqual(endings.get("2"), { kind: "landing", green: { issue: "2" }, landed: { kind: "conflict", files: ["shared.txt"], with: ["9"] }, attempts: 1 });
  assert.deepEqual(endings.get("3"), { kind: "landing", green: { issue: "3" }, landed: { kind: "merged" }, attempts: 1 });
  assert.deepEqual(stop.causes, [usage]);
  assert.equal(stop.landsNothing, false);
});

test("a .git change after a pipeline lands nothing more: a green ticket ends stopped, finished", async () => {
  const error = new OperatorError("STOPPED after #1: main moved while sandboxes ran");
  let found!: () => void;
  const tampered = new Promise<void>((resolve) => (found = resolve));
  const { endings, stop, order } = await play(["1", "2"], {
    attempt: async (t) => {
      if (t.id === "1") {
        found();
        return { kind: "stopped", cause: { kind: "tampered", error } };
      }
      await tampered;
      return green(t.id);
    },
  });
  assert.deepEqual(endings.get("1"), { kind: "stopped", cause: { kind: "tampered", error }, finished: false });
  assert.deepEqual(endings.get("2"), { kind: "stopped", cause: { kind: "tampered", error }, finished: true, green: { issue: "2" } });
  assert.equal(order.includes("land 2"), false);
  assert.equal(stop.landsNothing, true);
});

test("the host's refused write and the landing check stop the run without anyone adding a cause", async () => {
  // The write refused while landing 1: read live, nothing after it lands.
  const refused = new OperatorError("STOPPED before writing to the base branch: HEAD changed");
  const host = { check: async () => {}, failed: undefined as unknown };
  const live = await play(["1", "2"], {
    workers: 1,
    host,
    land: async (g) => {
      if (g.issue !== "1") return { kind: "merged" };
      host.failed = refused;
      throw refused;
    },
  });
  assert.deepEqual(kinds(live.endings), { 1: "stopped", 2: "stopped" });
  assert.deepEqual(live.stop.causes, [{ kind: "host failed", error: refused }]);

  // The check before a landing fails: a tampered `.git`, its error kept as the cause.
  const moved = new OperatorError("STOPPED before landing #1: main moved while sandboxes ran");
  const checked = await play(["1"], { host: { check: async () => Promise.reject(moved), failed: undefined } });
  assert.deepEqual(checked.stop.causes, [{ kind: "tampered", error: moved }]);
  assert.equal(checked.order.includes("land 1"), false);
  // Read-only outside the scheduler: no halt, and no add.
  // @ts-expect-error the stop state a run returns cannot be added to
  assert.equal(checked.stop.add, undefined);
});

test("a requeued ticket whose second attempt never begins ends with its first landing, or withdrawn", async () => {
  const conflict: Landed = { kind: "conflict", files: ["shared.txt"], with: ["1"] };
  const withdrawn = await play(["2"], {
    land: async () => conflict,
    attempt: async (t, { n }) => (n === 2 ? { kind: "not begun", why: { kind: "withdrawn", reason: "ticket closed during the run" } } : green(t.id)),
  });
  assert.deepEqual(withdrawn.endings.get("2"), { kind: "landing", green: { issue: "2" }, landed: { kind: "withdrawn", reason: "ticket closed during the run" }, attempts: 1 });
  // Withdrawn is no stop: nothing else is held back by it.
  assert.deepEqual(withdrawn.stop.causes, []);

  const limited = await play(["2"], {
    land: async () => conflict,
    attempt: async (t, { n }) => (n === 2 ? { kind: "not begun", why: usage } : green(t.id)),
  });
  assert.deepEqual(limited.endings.get("2"), { kind: "landing", green: { issue: "2" }, landed: conflict, attempts: 1 });
  assert.deepEqual(limited.stop.causes, [usage]);
});

test("a crash names its causes, and a throwing attempt or land port costs that ticket only", async () => {
  const { endings, stop } = await play(["1", "2", "3"], {
    workers: 1,
    attempt: async (t) => {
      if (t.id === "1") return { kind: "crashed", error: new Error("limit reached"), causes: [{ kind: "plan limit", ticket: "1" }] };
      throw new Error("not a result at all");
    },
  });
  assert.equal(endings.get("1")?.kind, "crashed");
  // The plan limit stops the run: 2 and 3 never begin.
  assert.deepEqual(kinds(endings), { 1: "crashed", 2: "not begun", 3: "not begun" });
  assert.deepEqual(stop.causes, [{ kind: "plan limit", ticket: "1" }]);

  const thrown = await play(["1", "2"], { workers: 1, attempt: async (t) => (t.id === "1" ? Promise.reject(new Error("boom")) : green(t.id)) });
  assert.deepEqual(kinds(thrown.endings), { 1: "crashed", 2: "landing" });
  const landPort = await play(["1", "2"], { workers: 1, land: async (g) => (g.issue === "1" ? Promise.reject(new Error("ENOSPC")) : { kind: "merged" }) });
  assert.deepEqual(kinds(landPort.endings), { 1: "crashed", 2: "landing" });
  assert.deepEqual(landPort.stop.causes, []);
});

test("the release hears each ending after it is told, a landed ticket as landed, and may start or refuse a ticket", async () => {
  const heard: string[] = [];
  const { endings, told, order } = await play(["1"], {
    later: [
      { ticket: { id: "2" }, on: "blockers" },
      { ticket: { id: "3" }, on: "blockers" },
    ],
    // Read at the start; it holds 3 once 3 is freed.
    checkLabel: (t) => (t.id === "3" ? "NOT STARTED: #3 has the label effort:turbo" : undefined),
    release: (s) => ({
      afterLanding: (id, landed) => {
        heard.push(`${id} ${landed}`);
        // 1 landed: 2 is freed, 3's label holds it. Started before the finish, so the run waits for 2.
        if (id === "1") {
          s.start({ id: "2" });
          assert.equal(s.badLabel("3"), "NOT STARTED: #3 has the label effort:turbo");
          assert.equal(s.badLabel("2"), undefined);
        }
        s.finish();
      },
      more: false,
    }),
  });
  assert.deepEqual(heard, ["1 true", "2 true"]);
  assert.deepEqual(order, ["attempt 1#1", "land 1", "attempt 2#1", "land 2"]);
  assert.deepEqual(endings.get("3"), { kind: "not begun", why: { kind: "refused label", reason: "NOT STARTED: #3 has the label effort:turbo" } });
  assert.equal(endings.get("2")?.kind, "landing");
  assert.ok(told.findIndex((c) => c.kind === "ended" && c.id === "1") >= 0);
});

test("the landing stage is told once the pipelines are idle and greens wait", async () => {
  const { told } = await play(["1", "2"], { workers: 2 });
  assert.deepEqual(
    told.filter((c) => c.kind === "landing"),
    [
      { kind: "landing", at: 1, of: 2 },
      { kind: "landing", at: 2, of: 2 },
    ],
  );
});

test("a run with nothing to start ends at once, with no endings", async () => {
  const { endings, stop } = await play([]);
  assert.equal(endings.size, 0);
  assert.equal(stop.startsNothing, false);
});
