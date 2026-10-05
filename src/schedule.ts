// The run's scheduler (`createSchedule`): every attempt and every landing of a run goes through it,
// and it returns each ticket's ending and the run's one stop state (`createStopState`). Its parts:
// a small work queue, the pipeline fan-out's and the landing worker's (workers keep pulling while
// the queue is open or still holds items, so an item can be pushed after the workers have started -
// a green outcome as its pipeline ends; `run` resolves only after `close()` and an empty queue), the
// landing worker (`createLanding`), and inside `createSchedule` the requeue-once rule, the file hold
// and the release of dependants (`createDependants`).

import { OperatorError } from "./errors.ts";
import type { Landed } from "./landing.ts";

export type Queue<T> = {
  /** Add an item; a waiting worker takes it at once. Refused after `close()`. */
  push(item: T): void;
  /** No more items are coming: workers finish what is queued, then `run` resolves. */
  close(): void;
  /** Items pushed and not yet taken by a worker. */
  readonly size: number;
  /** `close()` was called: a push now throws. */
  readonly closed: boolean;
  /** `workers` loops, each awaiting `fn` for one item at a time. Rejects as soon as one `fn` does. */
  run(workers: number, fn: (item: T) => Promise<void>): Promise<void>;
};

/**
 * `rank` orders what is waiting: the highest goes first, and equal ranks go in arrival order.
 * The landing queue ranks a carried branch above a new one, so it still lands first when both wait.
 */
export const createQueue = <T>(rank: (item: T) => number = () => 0): Queue<T> => {
  const items: T[] = [];
  const waiting: (() => void)[] = [];
  let closed = false;
  const wake = () => {
    for (const resume of waiting.splice(0)) resume();
  };
  // Boxed, so an item that is itself undefined or falsy is not mistaken for "no more".
  const take = async (): Promise<{ item: T } | undefined> => {
    for (;;) {
      if (items.length) {
        // `>` keeps the earliest of equal ranks.
        const at = items.reduce((best, item, i) => (rank(item) > rank(items[best]) ? i : best), 0);
        return { item: items.splice(at, 1)[0] };
      }
      if (closed) return undefined;
      await new Promise<void>((resume) => waiting.push(resume));
    }
  };
  return {
    push(item) {
      if (closed) throw new Error("cannot push to a closed queue");
      items.push(item);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    get size() {
      return items.length;
    },
    get closed() {
      return closed;
    },
    async run(workers, fn) {
      await Promise.all(
        Array.from({ length: workers }, async () => {
          for (let next = await take(); next; next = await take()) await fn(next.item);
        }),
      );
    },
  };
};

/** The files of one ticket: every path it changes or declares, and the ones among them git cannot merge. */
export type TicketFiles = { all: string[]; unmergeable: string[] };

/** What a ticket waits for: the ticket in flight that has `file`, a file git cannot merge. */
export type FileWait = { with: string; file: string };

/** Mergeable files two tickets that run together both change; landing and the requeue resolve them. */
export type FileShare = { with: string; files: string[] };

const SHOWN = 3;
const named = (files: string[]) => `${files.slice(0, SHOWN).join(", ")}${files.length > SHOWN ? ` and ${files.length - SHOWN} more` : ""}`;

/** The ticket's status note while it waits. */
export const fileWaitNote = (ref: (id: string) => string, w: FileWait) => `waits for ${ref(w.with)}: both change ${w.file} (git cannot merge it)`;

/** One line per pair that starts together and changes the same mergeable files. */
export const fileShareLine = (ref: (id: string) => string, id: string, s: FileShare) => `${ref(s.with)} and ${ref(id)} both change ${named(s.files)} - landing resolves it`;

/** The note of a ticket parked in a run that has stopped: nothing will start it before the next run. */
export const stoppedWaitNote = (ref: (id: string) => string, w?: FileWait) =>
  w ? `waits for ${ref(w.with)} (git cannot merge ${w.file}) - next run` : "stopped before it could start - next run";

/**
 * Which tickets may start. A file git cannot merge (a lockfile, a generated file, a minified
 * blob) conflicts at landing whatever the order, so one ticket at a time has it in flight; a ticket
 * that shares such a file with one in flight is parked. Files git can merge never hold anything:
 * the landing and the requeue deal with them, and `admit` only names them.
 * A ticket is in flight from `admit` until `end` (it landed, or left the run).
 *
 * A ticket's files are read once, when it is first admitted; a ticket in flight changes files
 * after that (its branch gains a lockfile change), so `refresh` re-reads them before each
 * comparison. A ticket that has not started keeps what it was read as. The scheduler's own.
 */
const createFileHold = <T extends { id: string }>(filesOf: (ticket: T) => TicketFiles, refresh?: (ticket: T, files: TicketFiles) => TicketFiles) => {
  const flying = new Map<string, { ticket: T; files: TicketFiles }>();
  // In arrival order; the first to be admitted again is the one that waited longest.
  const parked: T[] = [];
  const read = new Map<string, TicketFiles>();
  const reread = () => {
    if (!refresh) return;
    for (const f of flying.values()) {
      f.files = refresh(f.ticket, f.files);
      read.set(f.ticket.id, f.files);
    }
  };
  // The first ticket in flight that has a file git cannot merge with `mine`, and the mergeable files shared with the others.
  const meet = (id: string, mine: TicketFiles) => {
    const shares: FileShare[] = [];
    for (const [other, { files: theirs }] of flying) {
      if (other === id) continue;
      const hard = mine.unmergeable.filter((f) => theirs.unmergeable.includes(f)).sort();
      if (hard.length) return { wait: { with: other, file: hard[0] } };
      const soft = mine.all.filter((f) => theirs.all.includes(f)).sort();
      if (soft.length) shares.push({ with: other, files: soft });
    }
    return { shares };
  };
  const filesFor = (t: T) => {
    let mine = read.get(t.id);
    if (!mine) read.set(t.id, (mine = filesOf(t)));
    return mine;
  };
  const place = (t: T): { wait: FileWait } | { shares: FileShare[] } => {
    const mine = filesFor(t);
    const at = meet(t.id, mine);
    if ("wait" in at) {
      if (!parked.some((p) => p.id === t.id)) parked.push(t);
      return at;
    }
    flying.set(t.id, { ticket: t, files: mine });
    const i = parked.findIndex((p) => p.id === t.id);
    if (i >= 0) parked.splice(i, 1);
    return at;
  };
  return {
    /** Starts the ticket (claiming its files) or parks it, saying what it waits for. */
    admit(t: T): { wait: FileWait } | { shares: FileShare[] } {
      reread();
      return place(t);
    },
    /**
     * The ticket landed or left the run: its files are free, and each parked ticket that no longer
     * collides is admitted, in the order they waited. `waits` is what the ones still parked wait
     * for now, which may be another ticket than before.
     */
    end(id: string): { freed: { ticket: T; shares: FileShare[] }[]; waits: { id: string; wait: FileWait }[] } {
      flying.delete(id);
      reread();
      const freed: { ticket: T; shares: FileShare[] }[] = [];
      const waits: { id: string; wait: FileWait }[] = [];
      for (const t of [...parked]) {
        const r = place(t);
        if ("shares" in r) freed.push({ ticket: t, shares: r.shares });
        else waits.push({ id: t.id, wait: r.wait });
      }
      return { freed, waits };
    },
    /**
     * Like `end`, for a run that is stopping: the files are free, but nothing is admitted. Each
     * parked ticket is listed with the ticket in flight it still collides with, or none.
     */
    stop(id: string): { id: string; wait?: FileWait }[] {
      flying.delete(id);
      reread();
      return parked.map((t) => {
        const at = meet(t.id, filesFor(t));
        return "wait" in at ? { id: t.id, wait: at.wait } : { id: t.id };
      });
    },
    /** Tickets parked now. */
    get size() {
      return parked.length;
    },
  };
};

/** A blocker that is a ticket (`id`), and one of `ids`. */
const among = (ids: ReadonlySet<string>, id: string | undefined) => id !== undefined && ids.has(id);

/**
 * The held tickets that can start in this run: every open blocker is a ticket that starts now
 * (`starting`) or another such dependant. One that also waits on anything else (an outside issue,
 * a Linear key) is the next run's; counting it inflated the workers, the estimate and the start
 * line, which named it "waits for a blocker in this run". In `held`'s order.
 */
const dependantsInRun = <T extends { id: string }, B>(starting: Iterable<string>, held: { ticket: T; on: B[] }[], ticketOf: (b: B) => string | undefined) => {
  const inRun = new Set(starting);
  const kept = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const h of held) {
      if (kept.has(h.ticket.id) || !h.on.every((b) => among(inRun, ticketOf(b)))) continue;
      kept.add(h.ticket.id);
      inRun.add(h.ticket.id);
      grew = true;
    }
  }
  return held.filter((h) => kept.has(h.ticket.id));
};

/**
 * The tickets the run holds back for a blocker in the same run, and which of them a landing frees:
 * `held` is the ones that wait, with the blockers they waited on, and `release` reads again the
 * blockers of each one that waited for the ticket that landed (`open`, the plan's port) and takes
 * out each ticket that is now free. `inFlight`: the candidates that have not ended; a blocker in
 * it "lands this run". `outside`: the held tickets that are not candidates (one also waits on a
 * blocker outside the run); they never start here and their blockers are never read again, but the
 * note of each is told again as a blocker of theirs ends, from the run's own endings. The scheduler's own.
 */
const createDependants = <T extends { id: string }, B>(
  held: Map<string, { ticket: T; on: B[] }>,
  outside: { ticket: T; on: B[] }[],
  inFlight: Set<string>,
  ports: Pick<NonNullable<Plan<T, B>["blockers"]>, "ticketOf" | "open">,
) => {
  const landed = new Set<string>();
  const waitsOn = (h: { on: B[] }, id: string) => h.on.some((b) => ports.ticketOf(b) === id);
  return {
    /** The ticket is on the base and closed: a blocker no more. */
    landed(id: string) {
      landed.add(id);
      inFlight.delete(id);
    },
    /** The ticket will not land in this run (red, nothing to change, crashed, held, not begun). */
    ended(id: string) {
      inFlight.delete(id);
    },
    get size() {
      return held.size;
    },
    /** A held ticket waits on a blocker that is still in flight: it may start in this run. */
    get waitsForFlight() {
      return [...held.values()].some((h) => h.on.some((b) => among(inFlight, ports.ticketOf(b))));
    },
    /**
     * What each held ticket waits for now, with the candidates still in flight and the tickets
     * landed: every dependant, and of the others only the ones that waited for `id`, whose note
     * changes with its ending. No lookup: a landed blocker is left out, any other ending is "not in this run".
     */
    notes: (id: string) => [
      ...[...held].map(([k, h]) => ({ id: k, on: h.on, inFlight: [...inFlight], landed: [...landed] })),
      ...outside.filter((h) => waitsOn(h, id)).map((h) => ({ id: h.ticket.id, on: h.on, inFlight: [...inFlight], landed: [...landed] })),
    ],
    /**
     * Reads again the blockers of each held ticket that waited for `id`, and takes out and returns
     * the ones with none open, in held order. Only those: re-reading every held ticket after every
     * landing cost one tracker call per blocker, in turn, on the landing worker. Nothing changes
     * when the read throws, or when `stillStarts` is false once it is back (the run stopped meanwhile).
     */
    async release(id: string, stillStarts: () => boolean): Promise<T[]> {
      if (!ports.open) return [];
      const waiting = [...held.values()].filter((h) => waitsOn(h, id));
      if (!waiting.length) return [];
      const open = await ports.open(waiting.map((h) => h.ticket), new Set(landed));
      if (!stillStarts()) return [];
      const free: T[] = [];
      waiting.forEach((h, at) => {
        const on = open[at] ?? h.on;
        if (on.length) held.set(h.ticket.id, { ticket: h.ticket, on });
        else {
          held.delete(h.ticket.id);
          free.push(h.ticket);
        }
      });
      return free;
    },
  };
};

/**
 * Why a run stopped. A plan limit names the ticket whose agent hit it; a usage limit carries the
 * probe's line; `tampered` is a `.git` check that failed (after a pipeline, or the landing
 * worker's); `host failed` is a host git write the writer refused (`HostGit.failed`).
 */
export type StopCause =
  | { kind: "plan limit"; ticket: string }
  | { kind: "usage limit"; line: string }
  | { kind: "tampered"; error: unknown }
  | { kind: "host failed"; error: unknown };

/**
 * Each kind, once: whether it is a safety stop (nothing more lands - the repo is in a state no
 * gate vouched for) and its rank for the headline, lowest first. A kind missing here, or either
 * field of one, fails the type check, so a new cause cannot be honoured in one path and missed in
 * another. A limit still lands what is already green.
 */
export const STOP_KINDS = {
  tampered: { safety: true, rank: 0 },
  "host failed": { safety: true, rank: 1 },
  "plan limit": { safety: false, rank: 2 },
  "usage limit": { safety: false, rank: 3 },
} as const satisfies Record<StopCause["kind"], { safety: boolean; rank: number }>;

/**
 * The run's one answer to "has it stopped?". Every cause is kept, in arrival order; `startsNothing`
 * (any cause: no attempt begins, nothing is requeued, no dependant is released) and `landsNothing`
 * (any safety cause, not only the first) are the only readings, and `headline` is the cause the
 * closing summary names: the highest-ranked, the earliest within a rank. Read-only: a cause reaches
 * a run only through the scheduler, from a port's result or the host's failure read live.
 */
export type StopState = {
  readonly causes: readonly StopCause[];
  readonly startsNothing: boolean;
  readonly landsNothing: boolean;
  readonly headline: StopCause | undefined;
};

/** The stop state with its `add`, which only the scheduler holds. */
export type StopWriter = StopState & { add(cause: StopCause): void };

/** The readings of `stop`, without its `add`: what the scheduler hands out. */
const readings = (stop: StopState): StopState => ({
  get causes() {
    return stop.causes;
  },
  get startsNothing() {
    return stop.startsNothing;
  },
  get landsNothing() {
    return stop.landsNothing;
  },
  get headline() {
    return stop.headline;
  },
});

/**
 * `host` is read live: a write the host git refused is a safety stop the moment it is refused,
 * without anyone recording it, so no path can miss it.
 */
export const createStopState = (host?: { readonly failed: unknown }): StopWriter => {
  const added: StopCause[] = [];
  const causes = (): StopCause[] => {
    const failed = host?.failed;
    const live = failed !== undefined && !added.some((c) => c.kind === "host failed" && c.error === failed);
    return live ? [...added, { kind: "host failed", error: failed }] : added;
  };
  return {
    add: (cause) => void added.push(cause),
    get causes() {
      return [...causes()];
    },
    get startsNothing() {
      return causes().length > 0;
    },
    get landsNothing() {
      return causes().some((c) => STOP_KINDS[c.kind].safety);
    },
    get headline() {
      // `<` keeps the earliest of equal ranks.
      return causes().reduce<StopCause | undefined>((best, c) => (!best || STOP_KINDS[c.kind].rank < STOP_KINDS[best.kind].rank ? c : best), undefined);
    },
  };
};

/** A green branch waiting to land; a carried branch (one with work from an earlier run) goes first. */
export type Green = { issue: string; carried?: boolean };

/** The host's git, as the landing worker sees it. */
export type HostPort = {
  /** The `.git` check before landing `ticket`; a failure throws an `OperatorError`. */
  check(ticket: string): Promise<void>;
  /** The write the host git refused, if any: read live, it is a safety stop without anyone adding it. */
  readonly failed: unknown;
};

/** What the landing worker needs of a run: the landing itself (`landOne`), and the check before it. */
export type LandPorts<G extends Green> = {
  /** Lands one green branch. A refused write or a failed `.git` check throws an `OperatorError`; anything else is the port's own to turn into a `Landed`. */
  land(green: G): Promise<Landed>;
  host: HostPort;
};

/**
 * The landing worker. A green outcome is `push`ed as its pipeline ends; one worker lands them one
 * at a time, in arrival order except that a carried branch goes before a new one when both wait (in
 * finish order it came last - it had a merge to resolve - and lost a conflict to a new branch on the
 * same lines, run after run). `close()` says no more will come: `run` resolves once the queue is
 * empty. `settled` is awaited before the next landing, so a ticket it releases starts before that one
 * lands. Once the stop state `landsNothing` - a `.git` check that failed here or after a pipeline, a
 * host git write refused - what is queued and what arrives later is handed to `stopped`, not landed.
 * A usage or plan limit still lands what is green. The scheduler's own; exported for the tests that
 * still wire it by hand.
 */
export const createLanding = <G extends Green>(
  ports: LandPorts<G>,
  stop: StopWriter,
  on: {
    settled(green: G, landed: Landed): void | Promise<void>;
    stopped(green: G): void | Promise<void>;
    /** The land port threw something that is not a stop. Without it, the worker rejects. */
    crashed?(green: G, error: unknown): void | Promise<void>;
  },
) => {
  const queue = createQueue<G>((g) => (g.carried ? 1 : 0));
  return {
    push: (g: G) => queue.push(g),
    close: () => queue.close(),
    get size() {
      return queue.size;
    },
    run: () =>
      queue.run(1, async (g) => {
        if (stop.landsNothing) return on.stopped(g);
        let landed: Landed;
        try {
          await ports.host.check(g.issue);
          // The check waits its turn on the host git, behind a pipeline's own check: a safety stop
          // that arrived meanwhile lands this one no more than the ones queued behind it.
          if (stop.landsNothing) return on.stopped(g);
          landed = await ports.land(g);
        } catch (error) {
          if (error instanceof OperatorError) {
            // A refused write is the host's failure, which the stop state reads live; any other is a `.git` check.
            if (error !== ports.host.failed) stop.add({ kind: "tampered", error });
            return on.stopped(g);
          }
          if (!on.crashed) throw error;
          return on.crashed(g, error);
        }
        // A write refused after its merge (the close, the branch delete): this one landed, and the
        // stop state reads the host's failure live, so nothing after it does.
        await on.settled(g, landed);
      }),
  };
};

/** What a ticket's first attempt collided with at landing: its second attempt carries it. */
export type Again = { kind: "conflict" | "red"; with: string[]; gates?: string[]; failing?: string[] };

/** The tracker took the ticket back (closed, unqueued, marked for a human) before an attempt began. */
export type Withdrawn = { kind: "withdrawn"; reason: string };

/** What one attempt reports: how its pipeline ended, and any cause it found to stop the run. */
export type Attempted<G, O> =
  /** Gated green: on to the landing worker. */
  | { kind: "green"; green: G }
  /**
   * Ended in its pipeline: a red gate, nothing to change, held by the kit, work left uncommitted.
   * `causes`: the `.git` check after it failed - the run stops, and the ticket keeps its own ending.
   */
  | { kind: "pipeline"; outcome: O; causes?: StopCause[] }
  /** `causes`: a plan limit its agent hit, a `.git` check that failed after it. */
  | { kind: "crashed"; error: unknown; causes?: StopCause[] }
  /** Its pipeline ran, then the `.git` check after it failed: the run stops. */
  | { kind: "stopped"; cause: StopCause }
  /** The check before it found a usage limit, or the tracker withdrew the ticket: nothing ran. */
  | { kind: "not begun"; why: StopCause | Withdrawn };

/**
 * How one ticket's part in a run ends: exactly one per ticket the run took in. `attempts` counts the
 * attempts that began; a requeued ticket whose second attempt never began ends with its first
 * landing (`withdrawn` when the tracker took it back meanwhile). `again` is what the first attempt
 * collided with, on a second attempt's landing; its `landed.with` then names the tickets of both.
 */
export type Ending<G, O> =
  | { kind: "landing"; green: G; landed: Landed; attempts: 1 | 2; again?: Again }
  | { kind: "pipeline"; outcome: O; attempts: 1 | 2 }
  /** `green` when the land port threw, rather than the pipeline. */
  | { kind: "crashed"; error: unknown; attempts: 1 | 2; green?: G }
  /** `finished` (and `green`): it was green and waited to land; it lands on a later run. */
  | { kind: "stopped"; cause: StopCause | undefined; finished: boolean; green?: G }
  | { kind: "not begun"; why: StopCause | Withdrawn | { kind: "refused label"; reason: string } }
  /** Still parked behind a file git cannot merge, or held for a blocker, when the run ended. */
  | { kind: "waiting"; on: "file" | "blockers" };

/**
 * What the scheduler tells of the file hold as the run goes; the start's waits and shares are on
 * `start` instead. `started`: a ticket that waited starts, as its last blocker in this run landed or
 * as `freed` is done with the file it waited for, sharing `shares` (mergeable files) with tickets in
 * flight; told before it is queued. `waits`: a ticket waits for `wait.with` - `parked` when its
 * blockers freed it just now, otherwise it was parked already and may wait for another ticket than
 * before. `next run`: the run starts nothing more, so a parked ticket waits for the next run, behind
 * `wait.with` if that one is still in flight (`freed` ended just now).
 */
export type HoldChange =
  | { kind: "started"; id: string; after: { kind: "blockers" } | { kind: "file"; freed: string }; shares: FileShare[] }
  | { kind: "waits"; id: string; wait: FileWait; parked: boolean }
  | { kind: "next run"; id: string; freed: string; wait?: FileWait };

/**
 * What the scheduler tells of the tickets held for a blocker in this run. `blocked`: after every
 * ending, what each one still held waits for (`on`), and `inFlight`, the candidates that have not
 * ended - a blocker among them lands this run, any other is not this run's - and `landed`, the
 * tickets that have landed and closed, which are no blocker any more though `on` may still name
 * them. The held tickets that are not candidates (they also wait outside the run) are told too, as
 * a blocker of theirs ends, with the `on` the start read. `unreleased`: the
 * blockers could not be read again after `id` landed, so what waits for it starts no earlier than
 * another landing frees it.
 */
export type BlockerChange<B> = { kind: "blocked"; id: string; on: B[]; inFlight: string[]; landed: string[] } | { kind: "unreleased"; id: string; error: unknown };

/** What the scheduler tells as the run goes, for the run record and the views. */
export type Change<G, O, B = unknown> =
  /** Told before the ticket is queued again, so no view shows a queued ticket the record does not know. */
  | { kind: "requeued"; id: string; again: Again }
  /** The ticket's ending, as it happens: before the tickets it frees start. */
  | { kind: "ended"; id: string; ending: Ending<G, O> }
  /** The pipelines are idle and greens wait: the run is landing the `at`th of `of`. */
  | { kind: "landing"; at: number; of: number }
  /** How many sandbox slots the run could use now, told whenever the count changes (`demand` in `createSchedule`). */
  | { kind: "demand"; n: number }
  | HoldChange
  | BlockerChange<B>;

/**
 * Whether a landing put the branch on the base: what a ticket waiting for its fix needs to know.
 * `partly-done` merged too, though it leaves the ticket open.
 */
export const onBase = (landed: Landed) => landed.kind === "merged" || landed.kind === "close-failed" || landed.kind === "partly-done" || landed.kind === "closed-earlier";

/**
 * Which ticket is repairing which failure, so a second ticket red on the same one waits for the first
 * one's landing instead of repairing it its own way (the two fixes then conflicted at landing and
 * needed resolve passes that repeated the same fix). A pipeline `claim`s a failure key as its repair
 * starts, asks `fixing` before its own, and `wait`s for the ticket's ending, which `told` reads from
 * the scheduler's changes: `wait` answers whether that ticket landed. A ticket that failed, gave up
 * or was held never landed, so the waiter repairs as before - nobody waits on a landing that will
 * not come. A cycle (A waits on B's fix while B waits on A's) is refused at `fixing`, so no two
 * tickets wait on each other. A waiter holds its sandbox slot, and the landing it waits for may need
 * one: while `starved` says a landing waits for a slot, every waiter stops waiting (asked every
 * `pause` ms), so the two never wait on each other. A ticket whose landing put a commit on the base
 * (`landedAt`, read as it ends) has it remembered, and `fixing` hands it on: a ticket whose branch
 * holds that commit already got the fix when it started, so a merge brings it nothing. In memory, one
 * per run.
 */
export const createFixBoard = (starved?: () => boolean, pause = 1000, landedAt?: (id: string) => string | undefined) => {
  const claims = new Map<string, string>();
  // A ticket that ended: whether it landed.
  const ended = new Map<string, boolean>();
  // The commit that put a landed ticket on the base, where the landing record has one.
  const commits = new Map<string, string>();
  // The keys a ticket sent back at landing had claimed: its second attempt is often land-only and
  // repairs nothing, so without these its fix would land unclaimed and a later red repairs again.
  const sentBack = new Map<string, Set<string>>();
  const resumes = new Map<string, ((landed: boolean) => void)[]>();
  const waitingOn = new Map<string, string>();
  const release = (id: string, landed: boolean) => {
    for (const resume of resumes.get(id)?.splice(0) ?? []) resume(landed);
  };
  const claim = (key: string, id: string) => {
    const by = claims.get(key);
    if (by === undefined || by === id || ended.has(by)) claims.set(key, id);
  };
  return {
    /** `id` is repairing `key`. The first ticket to claim it that has not ended keeps it. */
    claim,
    /**
     * The other ticket repairing `key`, when `id` may wait for it: `landed` when its fix is on the base
     * already, so `id` merges the base without waiting (its gate may have finished just after that landing),
     * and `commit` is the one that put it there, when the landing record had it: a branch that holds it
     * was cut after the fix, and its red is its own.
     */
    fixing(key: string, id: string): { by: string; landed: boolean; commit?: string } | undefined {
      const by = claims.get(key);
      if (by === undefined || by === id) return undefined;
      if (ended.has(by)) return ended.get(by) ? { by, landed: true, commit: commits.get(by) } : undefined;
      for (let at = waitingOn.get(by); at !== undefined; at = waitingOn.get(at)) if (at === id) return undefined;
      return { by, landed: false };
    },
    /** Resolves when `on` has ended or been sent back for a second attempt, or a landing is starved of a slot: true when it landed. */
    async wait(id: string, on: string): Promise<boolean> {
      if (ended.has(on)) return ended.get(on) === true;
      waitingOn.set(id, on);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<boolean>((resume) => {
          resumes.set(on, [...(resumes.get(on) ?? []), resume]);
          const poll = () => (starved?.() ? resume(false) : (timer = setTimeout(poll, pause)));
          if (starved) timer = setTimeout(poll, pause);
        });
      } finally {
        clearTimeout(timer);
        waitingOn.delete(id);
      }
    },
    /**
     * The scheduler's changes: a ticket's ending is what its waiters wait for. A ticket sent back at
     * landing has landed nothing yet, and its second attempt may wait behind the very pipelines that
     * wait for it (every worker a waiter): they stop waiting, and its claims go until it repairs again.
     * Its second attempt may land a carried branch with no repair: that landing is still the fix to
     * the keys it had claimed, unless another ticket claimed one since and is still repairing it.
     */
    told<G, O, B>(change: Change<G, O, B>) {
      if (change.kind === "requeued") {
        const keys = sentBack.get(change.id) ?? new Set<string>();
        for (const [key, by] of claims) {
          if (by !== change.id) continue;
          claims.delete(key);
          keys.add(key);
        }
        sentBack.set(change.id, keys);
        release(change.id, false);
      } else if (change.kind === "ended") {
        const landed = change.ending.kind === "landing" && onBase(change.ending.landed);
        ended.set(change.id, landed);
        const commit = landed ? landedAt?.(change.id) : undefined;
        if (commit) commits.set(change.id, commit);
        if (landed) for (const key of sentBack.get(change.id) ?? []) claim(key, change.id);
        sentBack.delete(change.id);
        release(change.id, landed);
      }
    },
  };
};

export type FixBoard = ReturnType<typeof createFixBoard>;

/** One candidate at the start, in start order: `wait` when it starts later, and `file` when that is behind a file git cannot merge. */
export type Start<T> = { ticket: T; wait?: "file" | "blockers"; file?: FileWait; shares?: FileShare[] };

export type Plan<T extends { id: string }, B = unknown> = {
  /** The tickets ready to start, in start order; the file hold parks the ones that wait for a file. */
  tickets: T[];
  /** The files of each ticket (`of`), and of a ticket in flight read again (`refresh`). Without them (a dry run, which lands nothing) nothing is held. */
  files?: { of(ticket: T): TicketFiles; refresh?(ticket: T, files: TicketFiles): TicketFiles };
  /**
   * The tickets held for a blocker. `held`: each with its open blockers as the start read them, in
   * queue order; the ones whose every blocker starts in this run (`ticketOf`: the ticket a blocker
   * is, if any) are candidates that start as their blockers land. `open`: the blockers of each of
   * `tickets` that are open now, in order, asked as a ticket they waited for lands; `landed` is the
   * tickets landed so far, closed now though the start read them as open. Without `open` (a dry run,
   * which lands nothing) nothing is released.
   */
  blockers?: {
    held: { ticket: T; on: B[] }[];
    ticketOf(blocker: B): string | undefined;
    open?(tickets: T[], landed: ReadonlySet<string>): Promise<B[][]>;
  };
  /** Candidates decided elsewhere that start later in this run, if at all. */
  later?: { ticket: T; on: "file" | "blockers" }[];
  /** The refusal for a ticket's label, read at the start for each ticket that starts later: a bad one holds that ticket, never the run. */
  checkLabel?(ticket: T): string | undefined;
};

export type Work<T, G extends Green, O, B = unknown> = LandPorts<G> & {
  /** Pipelines at once. */
  workers: number;
  /** The run's concurrency, the most its demand for slots is ever told as; `workers` when not given. */
  concurrency?: number;
  /**
   * One attempt of a ticket: `n` is 2 for a requeued ticket, which carries `again`. `last()` says
   * nothing more will start after it - none queued, none that may be freed, or a stopped run - so a
   * sandbox's pane can close.
   */
  attempt(ticket: T, at: { n: 1 | 2; again?: Again; last(): boolean }): Promise<Attempted<G, O>>;
  /** Progress for the record and the views. A throw here is dropped: it must not cost a ticket. */
  tell(change: Change<G, O, B>): void;
};

/**
 * The run's one path for attempts and landings. `start` is the candidates in start order, decided
 * as the schedule is made, before the run record exists: the file hold admits each ready ticket or
 * parks it behind the one that has its file, the tickets held for a blocker that starts in this run
 * join them, and the labels are read. `run` fans the attempts out over `workers`, hands each green
 * one to the landing worker, sends a first conflict or red back for a second attempt (the
 * requeue-once rule, `requeue` below) unless the run starts nothing, and as each ticket ends frees
 * its files (`free` below), then releases its dependants (`release` below), and only then drops the
 * open count. A cause reaches the stop state only from an attempt's result, a landing's `.git`
 * check or refused write, or the host's failure read live. It resolves once every ticket has its
 * ending, with the endings and the stop state; it writes no run record and no wording - `tell` and
 * the endings carry what the burndown records.
 */
export const createSchedule = <T extends { id: string }, G extends Green, O = unknown, B = unknown>(plan: Plan<T, B>) => {
  // A file git cannot merge (a lockfile, a generated file, a minified blob) conflicts at landing
  // whatever the order, so one ticket at a time has it in flight. No files, no hold: a dry run lands
  // nothing, so it holds nothing.
  const hold = plan.files && createFileHold<T>(plan.files.of, plan.files.refresh);
  const now: Start<T>[] = [];
  const parked: Start<T>[] = [];
  for (const ticket of plan.tickets) {
    const at = hold?.admit(ticket);
    if (at && "wait" in at) parked.push({ ticket, wait: "file", file: at.wait });
    else now.push({ ticket, ...(at?.shares.length ? { shares: at.shares } : {}) });
  }
  // Decided once the tickets that start now are known: a parked ticket starts in this run, so a
  // ticket that waits for it as a blocker does too. None when nothing starts now.
  const blockers = plan.blockers;
  const dependants = now.length && blockers ? dependantsInRun([...now, ...parked].map((c) => c.ticket.id), blockers.held, blockers.ticketOf) : [];
  // A ticket the release frees queues behind the ones already waiting for a sandbox: the ones that
  // start now, then dependants, then parked.
  const later: Start<T>[] = [
    ...(plan.later ?? []).map((l) => ({ ticket: l.ticket, wait: l.on })),
    ...dependants.map((h) => ({ ticket: h.ticket, wait: "blockers" as const })),
    ...parked,
  ];
  // Read now, before any sandbox starts; a bad label holds that ticket when it would start, never the run.
  const labels = new Map<string, string>();
  for (const { ticket } of later) {
    const bad = plan.checkLabel?.(ticket);
    if (bad) labels.set(ticket.id, bad);
  }
  return {
    start: [...now, ...later] as readonly Start<T>[],
    async run(work: Work<T, G, O, B>): Promise<{ endings: Map<string, Ending<G, O>>; stop: StopState }> {
      const stop = createStopState(work.host);
      const endings = new Map<string, Ending<G, O>>();
      const tell = (change: Change<G, O, B>) => {
        try {
          work.tell(change);
        } catch {
          /* progress only: the ending stands */
        }
      };
      const byId = new Map(now.map((c) => [c.ticket.id, c.ticket] as const));
      // Parked behind a file now: at the end, such a ticket waits for a file, whatever held it first.
      const behind = new Set(later.flatMap((c) => (c.wait === "file" ? [c.ticket.id] : [])));
      // Every candidate is in flight until it ends; a blocker in flight lands this run.
      const waits = createDependants<T, B>(
        new Map(dependants.map((h) => [h.ticket.id, h] as const)),
        (blockers?.held ?? []).filter((h) => !dependants.includes(h)),
        new Set([...now, ...later].map((c) => c.ticket.id)),
        { ticketOf: blockers?.ticketOf ?? (() => undefined), open: blockers?.open },
      );
      // Attempts that began, by ticket.
      const attempts = new Map<string, 1 | 2>();
      // What a requeued ticket's first attempt collided with: its second carries it, and a second collision is final.
      const first = new Map<string, Again>();
      // A ticket landing sent back, until its second attempt begins: if that never begins, this landing is its ending.
      const sentBack = new Map<string, { green: G; landed: Landed }>();
      let working = 0;
      let pushed = 0;
      let dealt = 0;
      const pipelines = createQueue<T>();
      // The sandbox slots the run could use now (the machine pool's demand): the tickets in a
      // pipeline or ready for one, plus one while a green branch waits to land or is landing,
      // never more than the concurrency. A ticket held for a blocker or a file adds nothing until
      // it starts, so a run with two startable tickets left asks for two. Told when the count changes.
      const cap = Math.max(0, work.concurrency ?? work.workers);
      // Counted from the push to the end of the attempt, so a ticket a worker has taken but not yet begun still counts.
      let inPipeline = 0;
      let demanded: number | undefined;
      const demand = () => {
        const n = Math.min(cap, inPipeline + (dealt < pushed ? 1 : 0));
        if (n === demanded) return;
        demanded = n;
        tell({ kind: "demand", n });
      };
      const stage = () => {
        demand();
        if (working === 0 && pipelines.size === 0 && dealt < pushed) tell({ kind: "landing", at: dealt + 1, of: pushed });
      };
      // Tickets without their ending. The queues stay open until none is left: a landing can send
      // one back after every other pipeline has ended. A ticket that starts counts before the ending
      // that freed it drops the count, so it never touches zero between them.
      let open = now.length;
      const closeAll = () => {
        pipelines.close();
        landing.close();
      };
      // Said before the tickets it frees start. Its files are freed before its dependants are
      // released (a dependant that shares a file with it must not find it in flight), and both
      // before the open count drops: the queues close at zero, and a ticket started after that
      // would never run.
      const end = async (id: string, ending: Ending<G, O>, landed = false) => {
        endings.set(id, ending);
        tell({ kind: "ended", id, ending });
        try {
          free(id);
          await release(id, landed);
        } finally {
          if (--open <= 0) closeAll();
        }
      };
      const refuse = (id: string, reason: string) => {
        const ending: Ending<G, O> = { kind: "not begun", why: { kind: "refused label", reason } };
        endings.set(id, ending);
        waits.ended(id);
        tell({ kind: "ended", id, ending });
      };
      // A ticket that waited starts. Not into closed pipelines (a worker failed: nothing would take
      // it), checked before anything is told; told before the push, as a requeue is.
      const begin = (t: T, after: Extract<HoldChange, { kind: "started" }>["after"], shares: FileShare[]) => {
        if (pipelines.closed) return;
        tell({ kind: "started", id: t.id, after, shares });
        behind.delete(t.id);
        byId.set(t.id, t);
        open++;
        inPipeline++;
        pipelines.push(t);
        demand();
      };
      /**
       * The ticket landed or left the run: its files are free. Each parked ticket that no longer
       * collides starts, in the order they waited, and the ones still parked are told what they wait
       * for now. Once the run starts nothing, none starts: each is told it waits for the next run,
       * behind the ticket in flight it still collides with, if any, so none keeps naming one that is
       * gone. A requeued ticket has no ending yet, so it keeps its files through its second attempt.
       */
      const free = (id: string) => {
        if (!hold) return;
        if (stop.startsNothing) {
          for (const w of hold.stop(id)) tell({ kind: "next run", id: w.id, freed: id, ...(w.wait && { wait: w.wait }) });
          return;
        }
        const steps = [hold.end(id)];
        for (let step = steps.shift(); step; step = steps.shift()) {
          for (const w of step.waits) tell({ kind: "waits", id: w.id, wait: w.wait, parked: false });
          for (const f of step.freed) {
            const bad = labels.get(f.ticket.id);
            if (bad) {
              refuse(f.ticket.id, bad);
              // Admitted, so its files are claimed: a ticket that never begins gives them back.
              steps.push(hold.end(f.ticket.id));
              continue;
            }
            begin(f.ticket, { kind: "file", freed: id }, f.shares);
          }
        }
      };
      /**
       * The ticket ended: what waits for it is told what it waits for now. One that landed and
       * closed (`landed`) has the blockers of the tickets that waited for it read again, on the
       * landing worker - a lookup is the worker's wait, never a pipeline's - and each with none open
       * starts, or is parked behind the ticket in flight that has its file; a bad label holds that
       * ticket, never the run. Any other end frees none, and neither does a run that starts nothing
       * (asked again once the read is back) or one whose pipelines have closed.
       */
      const release = async (id: string, landed: boolean) => {
        if (landed) waits.landed(id);
        else waits.ended(id);
        let free: T[] = [];
        const starts = () => !stop.startsNothing && !pipelines.closed;
        if (landed && starts()) {
          try {
            free = await waits.release(id, starts);
          } catch (error) {
            tell({ kind: "unreleased", id, error });
          }
        }
        for (const n of waits.notes(id)) tell({ kind: "blocked", ...n });
        for (const t of free) {
          const bad = labels.get(t.id);
          if (bad) {
            refuse(t.id, bad);
            continue;
          }
          const at = hold?.admit(t);
          if (at && "wait" in at) {
            behind.add(t.id);
            tell({ kind: "waits", id: t.id, wait: at.wait, parked: true });
          } else begin(t, { kind: "blockers" }, at?.shares ?? []);
        }
      };

      /**
       * The requeue-once rule, decided here and nowhere else: a first conflict or red at landing
       * sends the ticket back for a second attempt that carries what it collided with. Not when the
       * run starts nothing (the second attempt would never begin, and the record would promise it),
       * nor when the pipelines are closed (a worker failed: nothing would take it) - both checked
       * before anything is told, so a requeue told is a requeue pushed, and nothing is undone.
       * Told before the push: no view shows a queued ticket the record does not know about.
       */
      const requeue = (g: G, landed: Landed): boolean => {
        if (landed.kind !== "conflict" && landed.kind !== "red") return false;
        const t = byId.get(g.issue);
        if (!t || first.has(t.id) || stop.startsNothing || pipelines.closed) return false;
        const again: Again = landed.kind === "red" ? { kind: "red", with: landed.with, gates: landed.gates, ...(landed.failing && { failing: landed.failing }) } : { kind: "conflict", with: landed.with };
        first.set(t.id, again);
        sentBack.set(t.id, { green: g, landed });
        tell({ kind: "requeued", id: t.id, again });
        inPipeline++;
        pipelines.push(t);
        demand();
        return true;
      };

      const landing = createLanding(work, stop, {
        settled: async (g, got) => {
          dealt++;
          stage();
          if (requeue(g, got)) return;
          const id = g.issue;
          const again = first.get(id);
          // A second collision names the tickets of both attempts.
          const landed = again && (got.kind === "conflict" || got.kind === "red") ? { ...got, with: [...new Set([...again.with, ...got.with])] } : got;
          const closed = landed.kind === "merged" || landed.kind === "close-failed" || landed.kind === "closed-earlier";
          await end(id, { kind: "landing", green: g, landed, attempts: attempts.get(id) ?? 1, ...(again && { again }) }, closed);
        },
        stopped: (g) => {
          dealt++;
          stage();
          return end(g.issue, { kind: "stopped", cause: stop.headline, finished: true, green: g });
        },
        crashed: (g, error) => {
          dealt++;
          stage();
          return end(g.issue, { kind: "crashed", error, attempts: attempts.get(g.issue) ?? 1, green: g });
        },
      });
      const last = () => stop.startsNothing || (pipelines.size === 0 && !waits.waitsForFlight && !hold?.size);

      // An attempt that does not begin: the ticket's first landing stands, if it had one.
      const notBegun = (t: T, why: StopCause | Withdrawn) => {
        const back = sentBack.get(t.id);
        sentBack.delete(t.id);
        if (!back) return end(t.id, { kind: "not begun", why });
        const landed: Landed = why.kind === "withdrawn" ? { kind: "withdrawn", reason: why.reason } : back.landed;
        return end(t.id, { kind: "landing", green: back.green, landed, attempts: 1 });
      };
      const attempt = async (t: T) => {
        working++;
        try {
          if (stop.startsNothing) return await notBegun(t, stop.headline!);
          const n = attempts.has(t.id) ? 2 : 1;
          let r: Attempted<G, O>;
          try {
            r = await work.attempt(t, { n, again: first.get(t.id), last });
          } catch (error) {
            r = { kind: "crashed", error };
          }
          if (r.kind === "not begun") {
            if (r.why.kind !== "withdrawn") stop.add(r.why);
            return await notBegun(t, r.why);
          }
          sentBack.delete(t.id);
          attempts.set(t.id, n);
          switch (r.kind) {
            case "green":
              pushed++;
              landing.push(r.green);
              return;
            case "pipeline":
              for (const c of r.causes ?? []) stop.add(c);
              return await end(t.id, { kind: "pipeline", outcome: r.outcome, attempts: n });
            case "crashed":
              for (const c of r.causes ?? []) stop.add(c);
              return await end(t.id, { kind: "crashed", error: r.error, attempts: n });
            case "stopped":
              stop.add(r.cause);
              return await end(t.id, { kind: "stopped", cause: r.cause, finished: false });
          }
        } finally {
          working--;
          inPipeline--;
          stage();
        }
      };

      if (open <= 0) closeAll();
      inPipeline = now.length;
      for (const c of now) pipelines.push(c.ticket);
      demand();
      // A pipeline worker that throws ends both queues; a landing worker that ends early closes the
      // pipelines too: nothing is left to send a ticket back to them, and they would wait for ever.
      const fanOut = pipelines.run(work.workers, attempt).finally(() => {
        closeAll();
        stage();
      });
      const lands = landing.run().finally(() => pipelines.close());
      const [a, b] = await Promise.allSettled([fanOut, lands]);
      for (const { ticket } of later) if (!endings.has(ticket.id)) endings.set(ticket.id, { kind: "waiting", on: behind.has(ticket.id) ? "file" : "blockers" });
      for (const r of [a, b]) if (r.status === "rejected") throw r.reason;
      return { endings, stop: readings(stop) };
    },
  };
};
