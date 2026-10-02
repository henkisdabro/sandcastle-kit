// The run's scheduler (`createSchedule`): every attempt and every landing of a run goes through it,
// and it returns each ticket's ending and the run's one stop state (`createStopState`). Its parts:
// a small work queue, the pipeline fan-out's and the landing worker's (workers keep pulling while
// the queue is open or still holds items, so an item can be pushed after the workers have started -
// a green outcome as its pipeline ends; `run` resolves only after `close()` and an empty queue), the
// landing worker (`createLanding`), and the file hold.

import { OperatorError } from "./errors.ts";
import { createFlow, type Landed } from "./landing.ts";

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

/**
 * Which tickets may start. A file git cannot merge (a lockfile, a generated file, a minified
 * blob) conflicts at landing whatever the order, so one ticket at a time has it in flight; a ticket
 * that shares such a file with one in flight is parked. Files git can merge never hold anything:
 * the landing and the requeue deal with them, and `admit` only names them.
 * A ticket is in flight from `admit` until `end` (it landed, or left the run).
 *
 * A ticket's files are read once, when it is first admitted; a ticket in flight changes files
 * after that (its branch gains a lockfile change), so `refresh` re-reads them before each
 * comparison. A ticket that has not started keeps what it was read as.
 */
export const createFileHold = <T extends { id: string }>(filesOf: (ticket: T) => TicketFiles, refresh?: (ticket: T, files: TicketFiles) => TicketFiles) => {
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

export type FileHold<T extends { id: string }> = ReturnType<typeof createFileHold<T>>;

/** The note of a ticket parked in a run that has stopped: nothing will start it before the next run. */
export const stoppedWaitNote = (ref: (id: string) => string, w?: FileWait) =>
  w ? `waits for ${ref(w.with)} (git cannot merge ${w.file}) - next run` : "stopped before it could start - next run";

/**
 * The start of a run, for what `burndown()` hands over as ready to start: each ticket is admitted
 * to the hold or parked behind the one that has its file. A parked ticket still starts in this
 * run, once that one is done, so it joins the candidates, goes on `waiting`, gets its `order` in
 * run.json after the others, and has its label checked now (a bad one holds that ticket, never
 * the run) next to the dependants. `dependants` is asked once the tickets that start now are
 * known, as a parked ticket counts for the ones that wait for it. No hold (a dry run) parks nothing.
 */
export const startHold = <T extends { id: string }>(
  hold: FileHold<T> | undefined,
  ready: T[],
  o: {
    ref(id: string): string;
    /** The run record's `waiting` list; a parked ticket is added to it. */
    waiting: { issue: string; on: string[] }[];
    /** The tickets that wait for a blocker in this run, given every ticket that starts now or once a file is free. */
    dependants(starting: T[]): T[];
    /** The refusal for a ticket's label, if it has one. */
    checkLabel(ticket: T): string | undefined;
    say(line: string): void;
  },
) => {
  const parked: { ticket: T; wait: FileWait }[] = [];
  const issues: T[] = [];
  for (const i of ready) {
    const at = hold?.admit(i);
    if (at && "wait" in at) {
      parked.push({ ticket: i, wait: at.wait });
      o.waiting.push({ issue: i.id, on: [o.ref(at.wait.with)] });
      o.say(`  ${o.ref(i.id)} ${fileWaitNote(o.ref, at.wait)}`);
    } else {
      issues.push(i);
      for (const share of at?.shares ?? []) o.say(`  ${fileShareLine(o.ref, i.id, share)}`);
    }
  }
  const dependants = issues.length ? o.dependants([...issues, ...parked.map((p) => p.ticket)]) : [];
  const candidates = [...issues, ...dependants, ...parked.map((p) => p.ticket)];
  // A released ticket queues behind the ones already waiting for a sandbox: issues, then dependants, then parked.
  const order = new Map(candidates.map((t, at) => [t.id, at] as const));
  const badLabels = new Map<string, string>();
  for (const i of [...dependants, ...parked.map((p) => p.ticket)]) {
    const bad = o.checkLabel(i);
    if (bad) badLabels.set(i.id, bad);
  }
  return { issues, parked, dependants, candidates, order, badLabels };
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
export type Again = { kind: "conflict" | "red"; with: string[] };

/** The tracker took the ticket back (closed, unqueued, marked for a human) before an attempt began. */
export type Withdrawn = { kind: "withdrawn"; reason: string };

/** What one attempt reports: how its pipeline ended, and any cause it found to stop the run. */
export type Attempted<G, O> =
  /** Gated green: on to the landing worker. */
  | { kind: "green"; green: G }
  /** Ended in its pipeline: a red gate, nothing to change, held by the kit, work left uncommitted. */
  | { kind: "pipeline"; outcome: O }
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

/** What the scheduler tells as the run goes, for the run record and the views. */
export type Change<G, O> =
  /** Told before the ticket is queued again, so no view shows a queued ticket the record does not know. */
  | { kind: "requeued"; id: string; again: Again }
  /** The ticket's ending, as it happens: before the tickets it frees start. */
  | { kind: "ended"; id: string; ending: Ending<G, O> }
  /** The pipelines are idle and greens wait: the run is landing the `at`th of `of`. */
  | { kind: "landing"; at: number; of: number };

/** The release of dependants and the file hold, as the run's start set them up; the scheduler calls them. */
export type Release = {
  /** The ticket is done with: `landed` when it landed and closed. Starts what it frees, then calls `finish` once. */
  afterLanding(id: string, landed: boolean): void | Promise<void>;
  /** A ticket parked or held may still start in this run. */
  readonly more: boolean;
};

export type Plan<T extends { id: string }> = {
  /** The tickets that start now, in start order. */
  tickets: T[];
  /** The candidates that start later in this run, if at all: behind a file git cannot merge, or a blocker in this run. */
  later?: { ticket: T; on: "file" | "blockers" }[];
  /**
   * The release of dependants and the file hold, given the scheduler's own `start` (a ticket freed
   * mid-run), `finish` (a ticket is done), `refuse` (a freed ticket's label holds it) and stop state.
   * Without it, a ticket's end frees nothing.
   */
  release?(s: { start(ticket: T): void; finish(): void; refuse(id: string, reason: string): void; stop: StopState }): Release;
};

export type Work<T, G extends Green, O> = LandPorts<G> & {
  /** Pipelines at once. */
  workers: number;
  /**
   * One attempt of a ticket: `n` is 2 for a requeued ticket, which carries `again`. `last()` says
   * nothing more will start after it - none queued, none that may be freed, or a stopped run - so a
   * sandbox's pane can close.
   */
  attempt(ticket: T, at: { n: 1 | 2; again?: Again; last(): boolean }): Promise<Attempted<G, O>>;
  /** Progress for the record and the views. A throw here is dropped: it must not cost a ticket. */
  tell(change: Change<G, O>): void;
};

/**
 * The run's one path for attempts and landings. `start` is the candidates in start order. `run`
 * fans the attempts out over `workers`, hands each green one to the landing worker, sends a first
 * conflict or red back for a second attempt (`createFlow`) unless the run starts nothing, and calls
 * the plan's release as each ticket ends. A cause reaches the stop state only from an attempt's
 * result, a landing's `.git` check or refused write, or the host's failure read live. It resolves
 * once every ticket has its ending, with the endings and the stop state; it writes no run record and
 * no wording - `tell` and the endings carry what the burndown records.
 */
export const createSchedule = <T extends { id: string }, G extends Green, O = unknown>(plan: Plan<T>) => {
  const later = plan.later ?? [];
  return {
    start: [...plan.tickets.map((ticket) => ({ ticket })), ...later.map((l) => ({ ticket: l.ticket, wait: l.on }))],
    async run(work: Work<T, G, O>): Promise<{ endings: Map<string, Ending<G, O>>; stop: StopState }> {
      const stop = createStopState(work.host);
      const endings = new Map<string, Ending<G, O>>();
      const tell = (change: Change<G, O>) => {
        try {
          work.tell(change);
        } catch {
          /* progress only: the ending stands */
        }
      };
      const byId = new Map(plan.tickets.map((t) => [t.id, t] as const));
      // Attempts that began, by ticket.
      const attempts = new Map<string, 1 | 2>();
      // A ticket landing sent back, until its second attempt begins: if that never begins, this landing is its ending.
      const sentBack = new Map<string, { green: G; landed: Landed }>();
      let working = 0;
      let pushed = 0;
      let dealt = 0;
      const pipelines = createQueue<T>();
      const stage = () => {
        if (working === 0 && pipelines.size === 0 && dealt < pushed) tell({ kind: "landing", at: dealt + 1, of: pushed });
      };
      // Said before the tickets it frees start, and before `finish` drops the open count.
      const end = async (id: string, ending: Ending<G, O>, landed = false) => {
        endings.set(id, ending);
        tell({ kind: "ended", id, ending });
        await release.afterLanding(id, landed);
      };

      const landing = createLanding(work, stop, {
        settled: async (g, got) => {
          dealt++;
          stage();
          const id = g.issue;
          const t = byId.get(id);
          // A first conflict or red goes back to the pipelines once, in this run: told, then queued.
          if (t && !pipelines.closed && (got.kind === "conflict" || got.kind === "red")) {
            const again: Again = { kind: got.kind, with: got.with };
            if (flow.retry(t, got, stop.startsNothing, () => tell({ kind: "requeued", id, again })) !== undefined) {
              sentBack.set(id, { green: g, landed: got });
              return;
            }
          }
          const first = flow.earlier(id);
          // A second collision names the tickets of both attempts.
          const landed = first && (got.kind === "conflict" || got.kind === "red") ? { ...got, with: [...new Set([...first.with, ...got.with])] } : got;
          const closed = landed.kind === "merged" || landed.kind === "close-failed" || landed.kind === "closed-earlier";
          await end(id, { kind: "landing", green: g, landed, attempts: attempts.get(id) ?? 1, ...(first && { again: first }) }, closed);
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
      // Keeps the pipeline queue open until every ticket has its ending: a landing can send one back.
      const flow = createFlow(plan.tickets.length, pipelines, landing);
      const release: Release = plan.release?.({
        start: (t) => {
          byId.set(t.id, t);
          flow.start(t);
        },
        finish: () => flow.finish(),
        refuse: (id, reason) => {
          const ending: Ending<G, O> = { kind: "not begun", why: { kind: "refused label", reason } };
          endings.set(id, ending);
          tell({ kind: "ended", id, ending });
        },
        stop: readings(stop),
      }) ?? { afterLanding: () => flow.finish(), more: false };
      const last = () => stop.startsNothing || (pipelines.size === 0 && !release.more);

      // An attempt that does not begin: the ticket's first landing stands, if it had one.
      const notBegun = (t: T, why: StopCause | Withdrawn) => {
        const first = sentBack.get(t.id);
        sentBack.delete(t.id);
        if (!first) return end(t.id, { kind: "not begun", why });
        const landed: Landed = why.kind === "withdrawn" ? { kind: "withdrawn", reason: why.reason } : first.landed;
        return end(t.id, { kind: "landing", green: first.green, landed, attempts: 1 });
      };
      const attempt = async (t: T) => {
        working++;
        try {
          if (stop.startsNothing) return await notBegun(t, stop.headline!);
          const n = attempts.has(t.id) ? 2 : 1;
          let r: Attempted<G, O>;
          try {
            r = await work.attempt(t, { n, again: flow.earlier(t.id), last });
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
          stage();
        }
      };

      for (const t of plan.tickets) pipelines.push(t);
      // A pipeline worker that throws ends both queues; a landing worker that ends early closes the
      // pipelines too: nothing is left to send a ticket back to them, and they would wait for ever.
      const fanOut = pipelines.run(work.workers, attempt).finally(() => {
        pipelines.close();
        landing.close();
        stage();
      });
      const lands = landing.run().finally(() => pipelines.close());
      const [a, b] = await Promise.allSettled([fanOut, lands]);
      for (const l of later) if (!endings.has(l.ticket.id)) endings.set(l.ticket.id, { kind: "waiting", on: l.on });
      for (const r of [a, b]) if (r.status === "rejected") throw r.reason;
      return { endings, stop: readings(stop) };
    },
  };
};
