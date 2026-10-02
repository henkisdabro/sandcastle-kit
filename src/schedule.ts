// A small work queue: the pipeline fan-out's, and the landing worker's. Workers keep pulling while
// the queue is open or still holds items, so an item can be pushed after the workers have started
// (a green outcome as its pipeline ends). `run` resolves only after `close()` and an empty queue.

export type Queue<T> = {
  /** Add an item; a waiting worker takes it at once. Refused after `close()`. */
  push(item: T): void;
  /** No more items are coming: workers finish what is queued, then `run` resolves. */
  close(): void;
  /** Items pushed and not yet taken by a worker. */
  readonly size: number;
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
