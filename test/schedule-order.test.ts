// The run's scheduler (createSchedule in src/schedule.ts) played through many orders of events, so
// an ordering bug shows up here rather than in a real run. Each seed makes a run of its own - how
// many tickets, which ones share a file git cannot merge, which wait for a blocker in the run, how
// each attempt and landing ends, whether one stops the run - and then picks, one at a time, which
// pending port call comes back next: an attempt finishing, a `.git` check, a landing returning
// (merged, conflict, red, held, refused), a blocker read. Between two of them every promise the
// scheduler chains settles, so a seed always plays the same order. After every run it checks:
//
// - every ticket the run took in gets exactly one ending, told once (a waiting one is not told);
// - two tickets sharing a file git cannot merge never run at the same time;
// - once a stop arrives nothing is requeued and nothing new starts, and after a safety stop
//   nothing more is checked or landed;
// - a dependant whose blockers all landed starts before the run ends, unless the run stopped.
//
// A failure names its seed and the run it made. `SCHEDULE_SEED=<n>` replays that seed alone, and
// with `SCHEDULE_RUNS=<count>` plays `count` seeds from it. The default seeds are fixed, so the
// gates never turn red on a draw. No git, no Docker, no network, no timers.
//
//   SCHEDULE_SEED=42 pnpm test:file test/schedule-order.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { OperatorError } from "../src/errors.ts";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, type Ending, type StopCause, type TicketFiles } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string; carried?: boolean };
type O = string;

/** mulberry32: small, fast, and the same numbers on every platform for a seed. */
const random = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** One of `weights`' keys, each as likely as its weight. */
const pick = <K extends string>(rng: () => number, weights: Record<K, number>): K => {
  const entries = Object.entries(weights) as [K, number][];
  let at = rng() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [k, w] of entries) if ((at -= w) < 0) return k;
  return entries[entries.length - 1][0];
};

type AttemptEnd = "green" | "pipeline" | "crashed" | "plan limit" | "tampered" | "usage limit" | "withdrawn";
type LandEnd = "merged" | "conflict" | "red" | "held" | "close-failed" | "closed-earlier" | "withdrawn" | "check tampered" | "host failed" | "crash";

/** What a seed makes: everything but the order, which the seed's later draws decide as the run goes. */
type Scenario = {
  workers: number;
  tickets: string[];
  /** Held for blockers: the in-run ones (and `50`, outside the run) each waits on. */
  held: { id: string; on: string[] }[];
  unmergeable: Record<string, string[]>;
  shared: string[];
  refused: string[];
  /** By ticket, first attempt then second. */
  attempts: Record<string, AttemptEnd[]>;
  lands: Record<string, LandEnd[]>;
  carried: string[];
};

const scenario = (rng: () => number): Scenario => {
  const n = 2 + Math.floor(rng() * 6);
  const tickets = Array.from({ length: n }, (_, i) => String(i + 1));
  const held: Scenario["held"] = [];
  for (let i = 0, k = Math.floor(rng() * 4); i < k; i++) {
    // On a ticket that starts now or an earlier dependant (a chain); now and then also on one outside the run.
    const pool = [...tickets, ...held.map((h) => h.id)];
    const on = [...new Set([pool[Math.floor(rng() * pool.length)], ...(rng() < 0.4 ? [pool[Math.floor(rng() * pool.length)]] : [])])];
    if (rng() < 0.15) on.push("50");
    held.push({ id: String(11 + i), on });
  }
  const all = [...tickets, ...held.map((h) => h.id)];
  const unmergeable: Record<string, string[]> = {};
  for (const id of all) {
    const r = rng();
    unmergeable[id] = r < 0.3 ? ["pnpm-lock.yaml"] : r < 0.45 ? ["schema.gen.ts"] : r < 0.55 ? ["pnpm-lock.yaml", "schema.gen.ts"] : [];
  }
  // Half the runs never stop, so the release of dependants is played to its end often enough.
  const stops = rng() < 0.5;
  const attemptEnds: Record<AttemptEnd, number> = {
    green: 70,
    pipeline: 8,
    crashed: 5,
    withdrawn: 5,
    "plan limit": stops ? 3 : 0,
    tampered: stops ? 3 : 0,
    "usage limit": stops ? 4 : 0,
  };
  const landEnds: Record<LandEnd, number> = {
    merged: 55,
    conflict: 14,
    red: 8,
    held: 4,
    "close-failed": 4,
    "closed-earlier": 3,
    withdrawn: 3,
    crash: 3,
    "check tampered": stops ? 3 : 0,
    "host failed": stops ? 3 : 0,
  };
  const attempts: Scenario["attempts"] = {};
  const lands: Scenario["lands"] = {};
  for (const id of all) {
    attempts[id] = [pick(rng, attemptEnds), pick(rng, attemptEnds)];
    lands[id] = [pick(rng, landEnds), pick(rng, landEnds)];
  }
  return {
    workers: 1 + Math.floor(rng() * 4),
    tickets,
    held,
    unmergeable,
    shared: all.filter(() => rng() < 0.3),
    refused: all.filter(() => rng() < 0.08),
    attempts,
    lands,
    carried: all.filter(() => rng() < 0.2),
  };
};

/** What happened, in order: the ports' calls, the stops as they arrive, and what was told. */
type Event =
  | { kind: "attempt"; id: string; n: number }
  | { kind: "check"; id: string }
  | { kind: "land"; id: string }
  | { kind: "stop"; safety: boolean }
  | { kind: "told"; change: Change<G, O, string> };

/** Lets every promise chained so far settle: the scheduler has no timer, so one turn is enough. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const play = async (seed: number) => {
  const rng = random(seed);
  const s = scenario(rng);
  const log: Event[] = [];
  // The port calls not yet answered; the seed picks which one comes back next.
  const pending: { what: string; answer: () => void }[] = [];
  const later = <V>(what: string, answer: () => V) =>
    new Promise<V>((resolve, reject) =>
      pending.push({
        what,
        answer: () => {
          try {
            resolve(answer());
          } catch (error) {
            reject(error);
          }
        },
      }),
    );
  const stopped = (safety: boolean) => log.push({ kind: "stop", safety });

  const lands = new Map<string, number>();
  const host = {
    failed: undefined as unknown,
    check: (id: string) => {
      log.push({ kind: "check", id });
      const n = lands.get(id) ?? 0;
      return later(`check ${id}`, () => {
        if (s.lands[id][n] !== "check tampered") return;
        stopped(true);
        throw new OperatorError(`STOPPED before landing #${id}: main moved while sandboxes ran`);
      });
    },
  };
  const schedule = createSchedule<T, G, O, string>({
    tickets: s.tickets.map((id) => ({ id })),
    files: { of: (t): TicketFiles => ({ all: [`${t.id}.ts`, ...s.unmergeable[t.id], ...(s.shared.includes(t.id) ? ["README.md"] : [])], unmergeable: s.unmergeable[t.id] }) },
    blockers: {
      held: s.held.map((h) => ({ ticket: { id: h.id }, on: h.on })),
      ticketOf: (b) => (b === "50" ? undefined : b),
      open: (ts, landed) => later(`blockers of ${ts.map((t) => t.id).join(",")}`, () => ts.map((t) => s.held.find((h) => h.id === t.id)!.on.filter((b) => !landed.has(b)))),
    },
    checkLabel: (t) => (s.refused.includes(t.id) ? `NOT STARTED: #${t.id} has the label effort:turbo` : undefined),
  });
  const run = schedule.run({
    workers: s.workers,
    attempt: (t, at) => {
      log.push({ kind: "attempt", id: t.id, n: at.n });
      return later(`attempt ${t.id}#${at.n}`, (): Attempted<G, O> => {
        // A scenario scripts two attempts; a third (#398's exception) repeats the second's.
        const end = s.attempts[t.id][Math.min(at.n, 2) - 1];
        const cause = (c: StopCause) => (stopped(c.kind === "tampered"), c);
        switch (end) {
          case "green":
            return { kind: "green", green: { issue: t.id, ...(s.carried.includes(t.id) && { carried: true }) } };
          case "pipeline":
            return { kind: "pipeline", outcome: "gate red" };
          case "crashed":
            return { kind: "crashed", error: new Error("agent died") };
          case "plan limit":
            return { kind: "crashed", error: new Error("limit reached"), causes: [cause({ kind: "plan limit", ticket: t.id })] };
          case "tampered":
            return { kind: "stopped", cause: cause({ kind: "tampered", error: new OperatorError(`STOPPED after #${t.id}`) }) };
          case "usage limit":
            return { kind: "not begun", why: cause({ kind: "usage limit", line: "usage 97% of the 5-hour window" }) };
          case "withdrawn":
            return { kind: "not begun", why: { kind: "withdrawn", reason: "ticket closed during the run" } };
        }
      });
    },
    host,
    land: (g) => {
      log.push({ kind: "land", id: g.issue });
      const n = lands.get(g.issue) ?? 0;
      lands.set(g.issue, n + 1);
      return later(`land ${g.issue}`, (): Landed => {
        const others = [...s.tickets, ...s.held.map((h) => h.id)].filter((id) => id !== g.issue);
        const other = others[Math.floor(rng() * others.length)];
        // A landing beyond the script (a conflict a landing after the resolve began caused sends the ticket back again) merges.
        const end = s.lands[g.issue][n] ?? "merged";
        switch (end) {
          case "merged":
          case "closed-earlier":
            return { kind: end };
          case "close-failed":
            return { kind: end, error: "gh: HTTP 502" };
          case "conflict":
            return { kind: "conflict", files: ["README.md"], with: [other] };
          case "red":
            return { kind: "red", with: [other], gates: ["test"] };
          case "held":
            return { kind: "held", paths: [".github/workflows/ci.yml"], reason: "human merge", by: "protected" };
          case "withdrawn":
            return { kind: "withdrawn", reason: "ticket closed during the run" };
          case "crash":
            throw new Error("ENOSPC");
          case "host failed": {
            const refused = new OperatorError("STOPPED before writing to the base branch: HEAD changed");
            host.failed = refused;
            stopped(true);
            throw refused;
          }
          case "check tampered":
            // The check before it already stopped the run; a landing that gets here anyway merges.
            return { kind: "merged" };
        }
      });
    },
    tell: (change) => void log.push({ kind: "told", change }),
  });

  let result: Awaited<typeof run> | undefined;
  let failure: unknown;
  let done = false;
  void run.then(
    (r) => (result = r),
    (e) => (failure = e),
  ).finally(() => (done = true));
  for (let steps = 0; ; steps++) {
    await turn();
    if (done) break;
    if (!pending.length) throw new Error("the run hangs: nothing is pending and it has not resolved");
    if (steps > 10_000) throw new Error("the run never ends");
    pending.splice(Math.floor(rng() * pending.length), 1)[0].answer();
  }
  if (!result) throw failure;
  return { s, start: schedule.start.map((c) => c.ticket.id), log, ...result };
};

const LANDED = new Set(["merged", "close-failed", "closed-earlier"]);

/** The invariants, over one run. */
const check = ({ s, start, log, endings, stop }: Awaited<ReturnType<typeof play>>) => {
  const told = log.flatMap((e) => (e.kind === "told" ? [e.change] : []));

  // Every ticket the run took in gets exactly one ending, told once as it happens; a ticket still
  // waiting when the run ends is not told.
  assert.deepEqual([...endings.keys()].sort(), [...start].sort(), "the endings are the tickets the run took in");
  for (const id of start) {
    const ended = told.filter((c): c is Extract<typeof c, { kind: "ended" }> => c.kind === "ended" && c.id === id);
    const ending = endings.get(id)!;
    if (ending.kind === "waiting") assert.equal(ended.length, 0, `#${id} waits, yet was told ended`);
    else assert.deepEqual(ended.map((c) => c.ending), [ending], `#${id} is told its ending once`);
  }
  for (const c of told) if (c.kind === "ended") assert.ok(start.includes(c.id), `#${c.id} ended, yet the run never took it in`);

  // A first attempt, then each further one (numbered in turn) only after a requeue of its own told before it: a first conflict or red, and
  // again only a conflict a landing caused after the resolve began (the scenario's landings after the script merge).
  for (const id of start) {
    const ns = log.flatMap((e) => (e.kind === "attempt" && e.id === id ? [e.n] : []));
    assert.ok(ns.every((n, i) => n === i + 1), `#${id} attempts: ${ns.join(", ")}`);
    const requeues = told.filter((c) => c.kind === "requeued" && c.id === id).length;
    assert.ok(requeues <= Math.max(0, ns.length), `#${id} is requeued ${requeues} times over ${ns.length} attempts`);
    for (let i = 1; i < ns.length; i++) {
      const at = log.findIndex((e, k) => e.kind === "attempt" && e.id === id && log.slice(0, k + 1).filter((x) => x.kind === "attempt" && x.id === id).length === i + 1);
      const before = log.slice(0, at).filter((e) => e.kind === "told" && e.change.kind === "requeued" && e.change.id === id).length;
      assert.ok(before >= i, `#${id}'s attempt ${i + 1} was never told as requeued`);
    }
  }

  // Two tickets sharing a file git cannot merge never run at the same time: from a ticket's first
  // attempt to its ending, no other with that file is attempted.
  const span = (id: string) => {
    const from = log.findIndex((e) => e.kind === "attempt" && e.id === id);
    const to = log.findIndex((e) => e.kind === "told" && e.change.kind === "ended" && e.change.id === id);
    return from < 0 ? undefined : { from, to: to < 0 ? log.length : to };
  };
  for (const a of start)
    for (const b of start) {
      if (a >= b) continue;
      const file = s.unmergeable[a].find((f) => s.unmergeable[b].includes(f));
      const [x, y] = [span(a), span(b)];
      if (!file || !x || !y) continue;
      assert.ok(x.to < y.from || y.to < x.from, `#${a} and #${b} both change ${file}, yet ran at the same time`);
    }

  // Once a stop arrives nothing is requeued and nothing new starts; after a safety stop nothing
  // more is checked or landed.
  const stopAt = log.findIndex((e) => e.kind === "stop");
  if (stopAt >= 0) {
    const after = log.slice(stopAt + 1);
    const late = (e: Event) => e.kind === "attempt" || (e.kind === "told" && (e.change.kind === "requeued" || e.change.kind === "started"));
    assert.deepEqual(after.filter(late), [], "started or requeued after the run stopped");
    assert.equal(stop.startsNothing, true, "a stop arrived, yet the run reads as going");
  }
  const safetyAt = log.findIndex((e) => e.kind === "stop" && e.safety);
  if (safetyAt >= 0) {
    assert.deepEqual(log.slice(safetyAt + 1).filter((e) => e.kind === "check" || e.kind === "land"), [], "landed after a safety stop");
    assert.equal(stop.landsNothing, true, "a safety stop arrived, yet the run reads as landing");
  }
  if (stopAt < 0) assert.deepEqual(stop.causes, [], "no stop arrived, yet the run has a cause");

  // A dependant whose blockers all landed starts before the run ends, unless the run stopped (or
  // its label refused it).
  const landed = (id: string): boolean => {
    const e = endings.get(id);
    return e?.kind === "landing" && LANDED.has(e.landed.kind);
  };
  if (!stop.startsNothing)
    for (const h of s.held) {
      if (!start.includes(h.id) || !h.on.every(landed)) continue;
      const e = endings.get(h.id)!;
      const refused = e.kind === "not begun" && e.why.kind === "refused label";
      assert.ok(refused || log.some((x) => x.kind === "attempt" && x.id === h.id), `#${h.id}'s blockers all landed, yet it never started (${e.kind})`);
    }
};

/** Plays and checks one seed; a failure names the seed and the run it made, to replay it. */
const playSeed = async (seed: number) => {
  let r: Awaited<ReturnType<typeof play>> | undefined;
  try {
    r = await play(seed);
    check(r);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const made = r ? `\nrun: ${JSON.stringify(r.s)}\nendings: ${JSON.stringify(Object.fromEntries([...r.endings].map(([id, e]) => [id, e.kind])))}` : "";
    throw new Error(`seed ${seed} (replay: SCHEDULE_SEED=${seed} node --test test/schedule-order.test.ts): ${why}${made}`, { cause: error });
  }
  return r;
};

/**
 * Seeds that found a bug, played on every run whatever `SCHEDULE_SEED` says. A change to how a seed
 * makes its run changes what these play, so each bug also has a test of its own below.
 */
const REGRESSIONS: Record<number, string> = {
  2: "a .git change a pipeline found while the landing check waited still landed that ticket",
};

test("the seeds that once found a bug keep the invariants", async () => {
  for (const seed of Object.keys(REGRESSIONS)) await playSeed(Number(seed));
});

test("a safety stop that arrives while the landing check waits lands that ticket no more", async () => {
  // 1 is green and its landing check waits on the host git, behind 2's pipeline, whose own check finds `.git` changed.
  const error = new OperatorError("STOPPED after #2: main moved while sandboxes ran");
  let checking!: () => void;
  const checked = new Promise<void>((resolve) => (checking = resolve));
  let release!: () => void;
  const turnToCheck = new Promise<void>((resolve) => (release = resolve));
  const landed: string[] = [];
  const { endings, stop } = await createSchedule<T, G, O>({ tickets: [{ id: "1" }, { id: "2" }] }).run({
    workers: 2,
    attempt: async (t) => {
      if (t.id === "1") return { kind: "green", green: { issue: "1" } };
      await checked;
      release();
      return { kind: "stopped", cause: { kind: "tampered", error } };
    },
    host: {
      check: async () => {
        checking();
        await turnToCheck;
        await turn();
      },
      failed: undefined,
    },
    land: async (g) => (landed.push(g.issue), { kind: "merged" }),
    tell: () => {},
  });
  assert.deepEqual(landed, []);
  assert.deepEqual(endings.get("1"), { kind: "stopped", cause: { kind: "tampered", error }, finished: true, green: { issue: "1" } });
  assert.equal(stop.landsNothing, true);
});

const from = process.env.SCHEDULE_SEED ? Number(process.env.SCHEDULE_SEED) : 1;
const runs = process.env.SCHEDULE_RUNS ? Number(process.env.SCHEDULE_RUNS) : process.env.SCHEDULE_SEED ? 1 : 500;

test(`the scheduler keeps its invariants over ${runs} seeded orders of events, from seed ${from}`, async () => {
  const seen = { stopped: 0, requeued: 0, released: 0, parked: 0 };
  for (let seed = from; seed < from + runs; seed++) {
    const r = await playSeed(seed);
    if (r.stop.startsNothing) seen.stopped++;
    if (r.log.some((e) => e.kind === "told" && e.change.kind === "requeued")) seen.requeued++;
    if (r.log.some((e) => e.kind === "told" && e.change.kind === "started" && e.change.after.kind === "blockers")) seen.released++;
    if (r.log.some((e) => e.kind === "told" && e.change.kind === "started" && e.change.after.kind === "file")) seen.parked++;
  }
  // The default seeds reach every path the invariants are about; a replay of one seed need not.
  if (runs >= 100) for (const [what, count] of Object.entries(seen)) assert.ok(count >= runs / 20, `only ${count} of ${runs} runs ${what}`);
});
