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
 */
export const createFileHold = <T extends { id: string }>(filesOf: (ticket: T) => TicketFiles) => {
  const flying = new Map<string, TicketFiles>();
  // In arrival order; the first to be admitted again is the one that waited longest.
  const parked: T[] = [];
  const read = new Map<string, TicketFiles>();
  const admit = (t: T): { wait: FileWait } | { shares: FileShare[] } => {
    let mine = read.get(t.id);
    if (!mine) read.set(t.id, (mine = filesOf(t)));
    const shares: FileShare[] = [];
    for (const [id, theirs] of flying) {
      if (id === t.id) continue;
      const hard = mine.unmergeable.filter((f) => theirs.unmergeable.includes(f)).sort();
      if (hard.length) {
        if (!parked.some((p) => p.id === t.id)) parked.push(t);
        return { wait: { with: id, file: hard[0] } };
      }
      const soft = mine.all.filter((f) => theirs.all.includes(f)).sort();
      if (soft.length) shares.push({ with: id, files: soft });
    }
    flying.set(t.id, mine);
    const at = parked.findIndex((p) => p.id === t.id);
    if (at >= 0) parked.splice(at, 1);
    return { shares };
  };
  return {
    /** Starts the ticket (claiming its files) or parks it, saying what it waits for. */
    admit,
    /**
     * The ticket landed or left the run: its files are free, and each parked ticket that no longer
     * collides is admitted, in the order they waited. `waits` is what the ones still parked wait
     * for now, which may be another ticket than before.
     */
    end(id: string): { freed: { ticket: T; shares: FileShare[] }[]; waits: { id: string; wait: FileWait }[] } {
      flying.delete(id);
      const freed: { ticket: T; shares: FileShare[] }[] = [];
      const waits: { id: string; wait: FileWait }[] = [];
      for (const t of [...parked]) {
        const r = admit(t);
        if ("shares" in r) freed.push({ ticket: t, shares: r.shares });
        else waits.push({ id: t.id, wait: r.wait });
      }
      return { freed, waits };
    },
    /** Tickets parked now. */
    get size() {
      return parked.length;
    },
  };
};

export type FileHold<T extends { id: string }> = ReturnType<typeof createFileHold<T>>;
