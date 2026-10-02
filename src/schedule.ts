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

/**
 * Keeps a queue open for as long as something can still add to it. A ticket that waits for a
 * blocker in the same run is pushed only once the blocker has landed, which happens after the
 * pipelines that were queued at the start have ended: closing the queue at the start would end
 * the run before it. `start` pushes an item; `finish` says one item is done with the run (its
 * pipeline ended with nothing to land, or its landing settled). A release goes through `start`
 * before the landed ticket's own `finish`, so the count never touches zero between them; at zero
 * nothing is left to release anything, and the queue closes.
 */
export const createFlow = <T>(queue: Queue<T>) => {
  let active = 0;
  return {
    start(item: T) {
      active++;
      queue.push(item);
    },
    finish() {
      if (--active <= 0) queue.close();
    },
    /** Items started and not yet finished. */
    get active() {
      return active;
    },
  };
};
