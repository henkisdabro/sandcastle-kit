// The run's scheduler (`createSchedule`): every attempt and every landing of a run goes through it,
// and it returns each ticket's ending and the run's one stop state (`createStopState`). Its parts:
// a small work queue, the pipeline fan-out's and the landing worker's (workers keep pulling while
// the queue is open or still holds items, so an item can be pushed after the workers have started -
// a green outcome as its pipeline ends; `run` resolves only after `close()` and an empty queue), the
// landing worker (`createLanding`), and inside `createSchedule` the requeue-once rule, the file hold
// and the release of dependants (`createDependants`).

import type { UsagePaused } from "../mod/hooks/run-record.ts";
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
 * The landing queue ranks a carried branch above a new one, so it still lands first when both wait;
 * the pipeline queue ranks a requeued ticket above a released one, and a released one above a ticket that has not started.
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

/** Mergeable files two tickets that run together both change; a conflict at landing is sent back once and resolved on the second attempt. */
export type FileShare = { with: string; files: string[] };

const SHOWN = 3;
const named = (files: string[]) => `${files.slice(0, SHOWN).join(", ")}${files.length > SHOWN ? ` and ${files.length - SHOWN} more` : ""}`;

/** The ticket's status note while it waits. */
export const fileWaitNote = (ref: (id: string) => string, w: FileWait) => `waits for ${ref(w.with)}: both change ${w.file} (git cannot merge it)`;

/** One line per pair that starts together and changes the same mergeable files: the pair list's own line in the file-shares log (`fileShareSummary` is what the start prints). */
export const fileShareLine = (ref: (id: string) => string, id: string, s: FileShare) =>
  `${ref(s.with)} and ${ref(id)} both change ${named(s.files)} - if they conflict at landing, the later one is sent back once and its merge resolved`;

/** Files nearly every ticket's docs touch: naming the tickets that share one says nothing, so they are counted on one line. */
const DOC_FILES = ["README.md", "CHANGELOG.md"];

/**
 * The lines a start prints for the pairs that share mergeable files: one per file, naming its
 * tickets, and one count for the docs files every ticket touches (a 29-ticket run printed 92 pair
 * lines, nearly all for those, and buried the pool warning). `pairs` are in `fileShareLine`'s own
 * shape: `id` shares `share.files` with `share.with`. A file's tickets are in the order they first
 * appear. Empty when no pair shares a file.
 */
export const fileShareSummary = (ref: (id: string) => string, pairs: { id: string; share: FileShare }[]) => {
  const byFile = new Map<string, string[]>();
  for (const { id, share } of pairs)
    for (const file of share.files) {
      const ids = byFile.get(file) ?? [];
      for (const t of [share.with, id]) if (!ids.includes(t)) ids.push(t);
      byFile.set(file, ids);
    }
  const lines = [...byFile].filter(([file]) => !DOC_FILES.includes(file)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, ids]) => `${file}: ${ids.map(ref).join(" ")}`);
  const docs = [...byFile].filter(([file]) => DOC_FILES.includes(file));
  if (docs.length) lines.push(`${docs.map(([file]) => file).join(", ")}: shared by ${new Set(docs.flatMap(([, ids]) => ids)).size} tickets (not listed)`);
  return lines;
};

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
    /** Every ticket in flight with its files as they are now (read again first). */
    touched(): Map<string, string[]> {
      reread();
      return new Map([...flying].map(([id, f]) => [id, f.files.all] as const));
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
  // Candidates that ended without landing: still in this run's endings, never "not in this run".
  const ended = new Set<string>();
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
      ended.add(id);
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
     * changes with its ending. No lookup: a landed blocker is left out, and one that ended another
     * way is in `ended`, for the run to word by its state - never "not in this run".
     */
    notes: (id: string) => [
      ...[...held].map(([k, h]) => ({ id: k, on: h.on, inFlight: [...inFlight], landed: [...landed], ended: [...ended] })),
      ...outside.filter((h) => waitsOn(h, id)).map((h) => ({ id: h.ticket.id, on: h.on, inFlight: [...inFlight], landed: [...landed], ended: [...ended] })),
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
 * What a juncture throws to a ticket parked by a pause when the run stops before the pause ends: the
 * ticket's attempt is over, and ends as `parked`. A port lets it through; the scheduler is its only catcher.
 */
export class StoppedWhileParked extends Error {
  /** The `.git` check after its sandbox closed, when it failed: the run stops with it as after any other attempt. */
  readonly causes: readonly StopCause[];
  constructor(causes: readonly StopCause[] = []) {
    super("the run stopped while this ticket was parked by a pause");
    this.causes = causes;
  }
}

/**
 * How one ticket's part in a run ends: exactly one per ticket the run took in. `attempts` counts the
 * attempts that began; a requeued ticket whose second attempt never began ends with its first
 * landing (`withdrawn` when the tracker took it back meanwhile). `again` is what the first attempt
 * collided with, on a second attempt's landing; its `landed.with` then names the tickets of both.
 */
export type Ending<G, O> =
  | { kind: "landing"; green: G; landed: Landed; attempts: number; again?: Again; unstarted?: true }
  | { kind: "pipeline"; outcome: O; attempts: number }
  /** `green` when the land port threw, rather than the pipeline. */
  | { kind: "crashed"; error: unknown; attempts: number; green?: G }
  /** `finished` (and `green`): it was green and waited to land; it lands on a later run. */
  | { kind: "stopped"; cause: StopCause | undefined; finished: boolean; green?: G }
  | { kind: "not begun"; why: StopCause | Withdrawn | { kind: "refused label"; reason: string } }
  /** Parked at a juncture of a paused run when the run stopped: it never resumed, its branch holds every commit and the next run picks it up. */
  | { kind: "parked"; cause: StopCause | undefined }
  /** Still parked behind a file git cannot merge, or held for a blocker, when the run ended. */
  | { kind: "waiting"; on: "file" | "blockers" };

/**
 * What the scheduler tells of the file hold as the run goes; the start's waits and shares are on
 * `start` instead. `started`: a ticket that waited starts, as its last blocker in this run landed or
 * as `freed` is done with the file it waited for, sharing `shares` (mergeable files) with tickets in
 * flight; told before it is queued. `waits`: a ticket waits for `wait.with` - `parked` when its
 * blockers freed it just now, otherwise it was parked already and may wait for another ticket than
 * before. `next run`: the run starts nothing more, so a parked ticket waits for the next run, behind
 * `wait.with` if that one is still in flight (`freed` ended just now). `resolve waits`: a ticket
 * sent back after a conflict holds its second attempt until the tickets `for` - green branches
 * queued to land, and tickets still in their pipelines, that share files with it - have landed or
 * ended, told again when that list changes; `resolve starts`: none is left, the attempt begins.
 */
export type HoldChange =
  | { kind: "started"; id: string; after: { kind: "blockers" } | { kind: "file"; freed: string }; shares: FileShare[] }
  | { kind: "waits"; id: string; wait: FileWait; parked: boolean }
  | { kind: "next run"; id: string; freed: string; wait?: FileWait }
  | { kind: "resolve waits"; id: string; for: string[] }
  | { kind: "resolve starts"; id: string };

/**
 * What the scheduler tells of the tickets held for a blocker in this run. `blocked`: after every
 * ending, what each one still held waits for (`on`), and `inFlight`, the candidates that have not
 * ended - a blocker among them lands this run, any other is not this run's - and `landed`, the
 * tickets that have landed and closed, which are no blocker any more though `on` may still name
 * them - and `ended`, the candidates that ended without landing, which the run words by the state
 * each ended in. The held tickets that are not candidates (they also wait outside the run) are told too, as
 * a blocker of theirs ends, with the `on` the start read. `unreleased`: the
 * blockers could not be read again after `id` landed, so what waits for it starts no earlier than
 * another landing frees it.
 */
export type BlockerChange<B> = { kind: "blocked"; id: string; on: B[]; inFlight: string[]; landed: string[]; ended: string[] } | { kind: "unreleased"; id: string; error: unknown };

/** What the scheduler tells as the run goes, for the run record and the views. */
export type Change<G, O, B = unknown> =
  /** Told before the ticket is queued again, so no view shows a queued ticket the record does not know. */
  | { kind: "requeued"; id: string; again: Again }
  /** The ticket's ending, as it happens: before the tickets it frees start. */
  | { kind: "ended"; id: string; ending: Ending<G, O> }
  /**
   * The stop's first safety cause (`stop.landsNothing` turned true), told once, as it holds: the
   * run finishes what is in flight and lands nothing more. `cause` is the headline then; the
   * closing summary may name a more severe one.
   */
  | { kind: "stopped landing"; cause: StopCause }
  /** The pipelines are idle and greens wait: the run is landing the `at`th of `of`. */
  | { kind: "landing"; at: number; of: number }
  /** How many sandbox slots the run could use now, told whenever the count changes (`demand` in `createSchedule`). */
  | { kind: "demand"; n: number }
  /**
   * A person paused the run (`since`, seconds since the epoch): `finishing` are the tickets still
   * doing something - an agent pass, a gate run, a landing - told again whenever they change, until
   * the last one has reached a juncture or landed. Nothing is in flight when it is empty. `usage`
   * is set while the pause is the run's own, for its plan's usage, not a person's; it is told again
   * when that changes (a window that resets later, a person taking the pause over).
   */
  | { kind: "paused"; since: number; finishing: string[]; usage?: UsagePaused }
  /** The pause was lifted: the parked tickets continue and the run asks for its slots again. */
  | { kind: "resumed" }
  /**
   * A stop arrived while the run was paused, told once as it is noticed: the pause no longer holds - the parked tickets
   * end as parked and the ones in flight finish - so no `paused` follows and the record must stop saying paused now.
   */
  | { kind: "pause stopped" }
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
    /**
     * Resolves when `on` has ended or been sent back for a second attempt, a landing is starved of a slot, or
     * the run is `paused` (the waiter holds a sandbox and a slot the pause would have it give back, and `on` may
     * be parked and unable to land until the resume): true when it landed.
     */
    async wait(id: string, on: string, paused?: () => boolean): Promise<boolean> {
      if (ended.has(on)) return ended.get(on) === true;
      waitingOn.set(id, on);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<boolean>((resume) => {
          resumes.set(on, [...(resumes.get(on) ?? []), resume]);
          const poll = () => (starved?.() || paused?.() ? resume(false) : (timer = setTimeout(poll, pause)));
          if (starved || paused) timer = setTimeout(poll, pause);
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

// What a ticket in the pipeline queue ranks as: the highest starts first, equals in arrival order.
const FIRST = 0;
const RELEASED = 1;
const REQUEUED = 2;

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

/**
 * The pause a person has asked for (`sandcastle pause`), as the scheduler reads it: at each
 * juncture and every `pollMs`, so a pause or a resume reaches the run within that, whether or not a
 * ticket is at a juncture. A source never throws: one that cannot be read answers as it did last.
 */
export type PauseSource = {
  /**
   * The pause in force - `since` in seconds since the epoch - or undefined when the run is not paused.
   * `usage` says the run took it for its plan's usage and resumes by itself: the source answers
   * undefined once that time has come, which is how the schedule resumes.
   */
  read(): { since: number; usage?: UsagePaused } | undefined;
  /** How often the pause is read between junctures, in milliseconds. 1000 when not given. */
  pollMs?: number;
};

/**
 * What a ticket does to leave a juncture and come back to it: `suspend` closes its sandbox and gives
 * back what the sandbox held (a machine-wide slot), keeping the branch; `resume` opens a fresh one
 * on the same branch and takes a slot again. Told by the scheduler only when the run is paused.
 */
export type Park = { suspend(): Promise<void>; resume(): Promise<void> };

export type Work<T, G extends Green, O, B = unknown> = LandPorts<G> & {
  /** Pipelines at once. */
  workers: number;
  /** The run's concurrency, the most its demand for slots is ever told as; `workers` when not given. */
  concurrency?: number;
  /** A person's pause, if the run takes one (a dry run may: it simply has nothing to hold). Without it nothing is held. */
  pause?: PauseSource;
  /**
   * One attempt of a ticket: `n` is 2 for a requeued ticket, which carries `again`. `last()` says
   * nothing more will start after it - none queued, none that may be freed, or a stopped run - so a
   * sandbox's pane can close. `juncture(phase, park)` is awaited before each step that would start
   * an agent pass (`phase` names it): it returns at once while the run is not paused; while paused it
   * runs `park.suspend()`, waits for the resume, runs `park.resume()` and returns, so the attempt
   * goes on from that phase. A paused run holds no ticket's sandbox at a juncture, and a ticket that
   * has not begun waits before its attempt does. `paused()` reads the pause now: an attempt that waits
   * for a machine-wide slot stops waiting when the run is paused, and reaches its first juncture instead.
   */
  attempt(ticket: T, at: { n: number; again?: Again; last(): boolean; juncture(phase: string, park?: Park): Promise<void>; paused(): boolean }): Promise<Attempted<G, O>>;
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
  // The order of this list: the ones that start now, then dependants, then parked. Once the run is
  // going, a dependant that is released starts ahead of every ticket that has not started (`RELEASED`).
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
      const attempts = new Map<string, number>();
      // What a requeued ticket's last attempt collided with: its next carries it, and a second collision is final unless
      // a landing after its resolve began caused it (`requeue`).
      const first = new Map<string, Again>();
      // A ticket landing sent back, until its second attempt begins: if that never begins, this landing is its ending.
      const sentBack = new Map<string, { green: G; landed: Landed }>();
      // The files a ticket sent back after a conflict collided on: its second attempt waits for the green branches that touch them.
      const conflicted = new Map<string, string[]>();
      // Sent-back tickets whose second attempt waits for those landings: in no pipeline, and no one waits for them.
      const resolving = new Set<string>();
      // Landings that reached the base, counted as they settle: a second attempt that begins after n of them
      // merges a base that holds those, so a conflict with a ticket landed after n is a new one, not "again".
      let landings = 0;
      const landedAt = new Map<string, number>();
      const resolveFrom = new Map<string, number>();
      // The tickets whose resolve waits were told, by what they waited for; a wait that failed.
      const resolveSaid = new Map<string, string>();
      const failures: unknown[] = [];
      const settles: (() => void)[] = [];
      let working = 0;
      let pushed = 0;
      let dealt = 0;
      // What waits for a sandbox slot. A requeued ticket and a released dependant go before the tickets
      // that have not started: they have waited already, and every landing that happens before they
      // start moves the base under them (a requeued one first, as it is the older work).
      const pipelines = createQueue<{ ticket: T; rank: number }>((q) => q.rank);
      // The sandbox slots the run could use now (the machine pool's demand): the tickets in a
      // pipeline or ready for one, plus one while a green branch waits to land or is landing,
      // never more than the concurrency. A ticket held for a blocker or a file adds nothing until
      // it starts, so a run with two startable tickets left asks for two. Told when the count changes.
      const cap = Math.max(0, work.concurrency ?? work.workers);
      // Counted from the push to the end of the attempt, so a ticket a worker has taken but not yet begun still counts.
      let inPipeline = 0;
      let demanded: number | undefined;
      // The pause (`work.pause`, read by `sync`): the one a person asked for, told as it begins and ends.
      let pausedSince: number | undefined;
      let pausedFor: UsagePaused | undefined;
      // The tickets that hold no sandbox because of the pause, by the phase they wait at ("start": not begun).
      const parked = new Map<string, string>();
      // Tickets inside an attempt, and green branches queued for landing or landing: what a pause lets finish.
      const running = new Set<string>();
      const greens = new Set<string>();
      const wakers: (() => void)[] = [];
      let toldFinishing: string | undefined;
      // While paused only the tickets inside an attempt that hold a sandbox ask for a slot: one queued for a
      // worker, waiting at the start or parked at a juncture holds none.
      const active = () => (pausedSince === undefined ? inPipeline - resolving.size : [...running].filter((id) => !parked.has(id)).length);
      const demand = () => {
        const n = Math.min(cap, active() + (dealt < pushed ? 1 : 0));
        if (n === demanded) return;
        demanded = n;
        tell({ kind: "demand", n });
      };
      // The tickets still doing something while paused; told again each time the list changes.
      const tellPaused = () => {
        // After a stop the pause is over (`noticeStop` told it): the finishing list changing is not a pause to record again.
        if (pausedSince === undefined || stop.startsNothing) return;
        const finishing = [...new Set([...[...running].filter((id) => !parked.has(id)), ...greens])];
        const key = JSON.stringify([finishing, pausedFor]);
        if (key === toldFinishing) return;
        toldFinishing = key;
        tell({ kind: "paused", since: pausedSince, finishing, ...(pausedFor ? { usage: pausedFor } : {}) });
      };
      // Told once, the moment the stop first holds - from wherever it is noticed: an ending, a stage
      // change, the poll. The host's refused write is read live, so no one adds it and any caller may find it.
      let toldStop = false;
      let toldPauseStopped = false;
      const noticeStop = () => {
        // A stop wakes the parked tickets: a pause that ends only with the window's reset must not outlast a run that can do nothing more.
        if (stop.startsNothing) {
          for (const wake of wakers.splice(0)) wake();
          // The record says paused until told otherwise, and only the run's end would: the tickets in flight finish first.
          if (pausedSince !== undefined && !toldPauseStopped) {
            toldPauseStopped = true;
            tell({ kind: "pause stopped" });
          }
        }
        if (toldStop || !stop.landsNothing) return;
        toldStop = true;
        tell({ kind: "stopped landing", cause: stop.headline! });
      };
      const stage = () => {
        for (const wake of settles.splice(0)) wake();
        noticeStop();
        demand();
        tellPaused();
        // A ticket waiting to resolve runs nothing and is no attempt: with none left in a pipeline, the run is landing.
        if (working === 0 && pipelines.size === 0 && dealt < pushed) tell({ kind: "landing", at: dealt + 1, of: pushed });
      };
      // Reads the pause: at each juncture, and every `pollMs` for a run none reaches. A resume drops every
      // parked ticket from the demand before any of them asks for a slot again, and wakes them.
      const sync = () => {
        noticeStop();
        let now: { since: number; usage?: UsagePaused } | undefined;
        try {
          now = work.pause?.read();
        } catch {
          return;
        }
        if (now && pausedSince === undefined) {
          pausedSince = now.since;
          pausedFor = now.usage;
          toldFinishing = undefined;
          tellPaused();
          demand();
        } else if (now && JSON.stringify(now.usage) !== JSON.stringify(pausedFor)) {
          // Still paused, for another reason or until another time: a later window's reset, a person taking the pause over.
          pausedFor = now.usage;
          tellPaused();
        } else if (!now && pausedSince !== undefined) {
          pausedSince = undefined;
          pausedFor = undefined;
          parked.clear();
          toldFinishing = undefined;
          // A stop already ended the pause for the record: a resume now would say a pause lifted that never held.
          if (!toldPauseStopped) tell({ kind: "resumed" });
          demand();
          for (const wake of wakers.splice(0)) wake();
        }
      };
      // The ticket holds nothing while the run is paused; returns once it is not, or once the run stops.
      const waitParked = async (id: string, phase: string) => {
        parked.set(id, phase);
        tellPaused();
        demand();
        for (sync(); pausedSince !== undefined && !stop.startsNothing; sync()) await new Promise<void>((wake) => wakers.push(wake));
        parked.delete(id);
      };
      const juncture = async (id: string, phase: string, park?: Park) => {
        sync();
        if (pausedSince === undefined) return;
        await park?.suspend();
        await waitParked(id, phase);
        // Woken by a stop, not the resume: its sandbox stays closed - a stopped run opens none - and the branch holds every commit.
        if (pausedSince !== undefined && stop.startsNothing) throw new StoppedWhileParked();
        await park?.resume();
      };
      // Not unref'd: with every ticket parked nothing else may keep the process alive, and a run that
      // exits while a person has it paused is not paused. Cleared when the schedule ends.
      const poll = work.pause && setInterval(sync, work.pause.pollMs ?? 1000);
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
        noticeStop();
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
        pipelines.push({ ticket: t, rank: after.kind === "blockers" ? RELEASED : FIRST });
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
        if (!t || stop.startsNothing || pipelines.closed) return false;
        // A second conflict is final, unless a landing that finished after the resolve began caused it: the
        // resolve could not have merged that one, so it is no fault of the resolve and the ticket is sent back again.
        if (first.has(t.id) && !(landed.kind === "conflict" && landed.with.some((id) => (landedAt.get(id) ?? 0) > (resolveFrom.get(t.id) ?? Infinity)))) return false;
        const again: Again = landed.kind === "red" ? { kind: "red", with: landed.with, gates: landed.gates, ...(landed.failing && { failing: landed.failing }) } : { kind: "conflict", with: landed.with };
        first.set(t.id, again);
        if (landed.kind === "conflict") conflicted.set(t.id, landed.files);
        sentBack.set(t.id, { green: g, landed });
        tell({ kind: "requeued", id: t.id, again });
        inPipeline++;
        pipelines.push({ ticket: t, rank: REQUEUED });
        demand();
        return true;
      };

      const landing = createLanding(work, stop, {
        settled: async (g, got) => {
          dealt++;
          greens.delete(g.issue);
          if (onBase(got)) landedAt.set(g.issue, ++landings);
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
          greens.delete(g.issue);
          stage();
          return end(g.issue, { kind: "stopped", cause: stop.headline, finished: true, green: g });
        },
        crashed: (g, error) => {
          dealt++;
          greens.delete(g.issue);
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
        // `unstarted` only says more than `attempts: 1` does once a third attempt, or later, is the one that never began.
        const done = attempts.get(t.id) ?? 1;
        return end(t.id, { kind: "landing", green: back.green, landed, attempts: done, ...(done > 1 && { unstarted: true as const }) });
      };
      // What a sent-back ticket's resolve waits for: the green branches queued to land that share a file with it, and the
      // tickets still in their pipelines whose branches touch the files it conflicted on. Each lands on the same lines
      // and would send the resolve back again; the ticket merges the base once they are done.
      const ahead = (t: T): string[] => {
        const touched = hold?.touched();
        if (!touched) return [];
        const hit = (id: string, files: Set<string>) => (touched.get(id) ?? []).some((f) => files.has(f));
        const conflict = new Set(conflicted.get(t.id));
        const mine = new Set([...(touched.get(t.id) ?? []), ...conflict]);
        return [
          ...[...greens].filter((id) => id !== t.id && hit(id, mine)),
          ...[...running].filter((id) => id !== t.id && !greens.has(id) && !resolving.has(id) && hit(id, conflict)),
        ];
      };
      // Returns when none is ahead of the ticket's resolve, or the run starts nothing; a pause parks it as at the start.
      const resolveTurn = async (t: T) => {
        try {
          for (sync(); !stop.startsNothing; sync()) {
            if (pausedSince !== undefined) {
              await waitParked(t.id, "start");
              continue;
            }
            const before = ahead(t);
            if (!before.length) break;
            resolving.add(t.id);
            if (before.join(",") !== resolveSaid.get(t.id)) {
              resolveSaid.set(t.id, before.join(","));
              tell({ kind: "resolve waits", id: t.id, for: before });
            }
            demand();
            // Woken at every stage change; the timer is a backstop against one that is missed.
            await new Promise<void>((wake) => {
              const timer = setTimeout(wake, 1000);
              settles.push(() => (clearTimeout(timer), wake()));
            });
          }
        } finally {
          resolving.delete(t.id);
          demand();
        }
      };
      // A sent-back ticket's wait is no pipeline worker's: the worker that took it hands it here and goes back to the
      // queue, so with N workers a waiting resolve leaves all N for the tickets behind it. Pushed again once nothing
      // is ahead of it (or the run starts nothing: the attempt then ends it as not begun), ahead of the queue as before.
      const waitToResolve = (t: T) => {
        void resolveTurn(t).then(
          () => {
            // A closed queue means a worker or the landing worker failed: the run rejects with that, nothing would take it.
            if (!pipelines.closed) pipelines.push({ ticket: t, rank: REQUEUED });
          },
          (error) => {
            failures.push(error);
            closeAll();
          },
        );
      };
      const attempt = async (t: T) => {
        // A paused run starts no ticket: it waits here, holding nothing, until the resume - or a stop.
        for (sync(); pausedSince !== undefined && !stop.startsNothing; sync()) await waitParked(t.id, "start");
        // #398's exception sends a ticket back again after a landing that finished after its resolve began: a third attempt counts as one.
        const n = (attempts.get(t.id) ?? 0) + 1;
        const resolves = n >= 2 && first.get(t.id)?.kind === "conflict";
        // Something is ahead of its resolve (checked again here: a landing may have queued since it was pushed): wait off the worker.
        if (resolves && !stop.startsNothing && ahead(t).length) return waitToResolve(t);
        working++;
        running.add(t.id);
        try {
          if (stop.startsNothing) return await notBegun(t, stop.headline!);
          if (resolves) {
            resolveFrom.set(t.id, landings);
            if (resolveSaid.delete(t.id)) tell({ kind: "resolve starts", id: t.id });
          }
          let r: Attempted<G, O>;
          // Every step the attempt takes is announced by a juncture of a phase other than "start", so a stop that wakes the
          // attempt before the first of them found nothing begun: the ticket ends as not begun, and a requeued one keeps its landing.
          let stepped = false;
          try {
            r = await work.attempt(t, { n, again: first.get(t.id), last, juncture: (phase, park) => ((stepped ||= phase !== "start"), juncture(t.id, phase, park)), paused: () => (sync(), pausedSince !== undefined) });
          } catch (error) {
            // Parked at a juncture when the run stopped: its record keeps the phase it waits at.
            if (error instanceof StoppedWhileParked) {
              for (const c of error.causes) stop.add(c);
              if (!stepped) return await notBegun(t, stop.headline!);
              return await end(t.id, { kind: "parked", cause: stop.headline });
            }
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
              greens.add(r.green.issue);
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
          running.delete(t.id);
          inPipeline--;
          stage();
        }
      };

      if (open <= 0) closeAll();
      inPipeline = now.length;
      for (const c of now) pipelines.push({ ticket: c.ticket, rank: FIRST });
      // A pause asked for before the schedule began is in force from the first demand told.
      sync();
      demand();
      // A pipeline worker that throws ends both queues; a landing worker that ends early closes the
      // pipelines too: nothing is left to send a ticket back to them, and they would wait for ever.
      const fanOut = pipelines.run(work.workers, (q) => attempt(q.ticket)).finally(() => {
        closeAll();
        stage();
      });
      const lands = landing.run().finally(() => pipelines.close());
      const [a, b] = await Promise.allSettled([fanOut, lands]);
      clearInterval(poll);
      for (const { ticket } of later) if (!endings.has(ticket.id)) endings.set(ticket.id, { kind: "waiting", on: behind.has(ticket.id) ? "file" : "blockers" });
      for (const r of [a, b]) if (r.status === "rejected") throw r.reason;
      if (failures.length) throw failures[0];
      return { endings, stop: readings(stop) };
    },
  };
};
