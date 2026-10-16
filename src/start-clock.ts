// Where a run's start spent its time. A start can take over a minute before the status view opens, and
// nothing said which step held it: the clock times the steps `sandcastle run` and `burndown()` take
// before the view, and `line()` names the heaviest once the start took 10 s or more.
// It writes nothing: not to timings.jsonl (whose phases feed the estimate), not to the run record.

/** A start shorter than this says nothing. */
const SAY_AT_MS = 10_000;
/** A step shorter than this is not named; its time counts toward `others`. */
const NAME_AT_MS = 1_000;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const startClock = (now: () => number = () => performance.now()) => {
  const began = now();
  const steps = new Map<string, number>();
  const asides = new Map<string, number>();
  let current: { name: string; at: number } | undefined;

  const end = () => {
    if (!current) return;
    steps.set(current.name, (steps.get(current.name) ?? 0) + (now() - current.at));
    current = undefined;
  };

  return {
    /** Ends the step in progress and starts `name`; with no name, ends it and starts none (the gap counts toward `others`). */
    step(name?: string) {
      end();
      if (name !== undefined) current = { name, at: now() };
    },
    /** Awaits `fn()`; its whole time, a question to the operator say, is left out of the start's total. */
    async aside<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      end();
      const at = now();
      try {
        return await fn();
      } finally {
        asides.set(name, (asides.get(name) ?? 0) + (now() - at));
      }
    },
    /** Ends the step in progress; the line, or undefined when the start took under 10 s. */
    line(): string | undefined {
      end();
      let left = 0;
      for (const ms of asides.values()) left += ms;
      const total = now() - began - left;
      if (total < SAY_AT_MS) return undefined;
      // A stable sort: ties stay in the order first timed.
      const named = [...steps].filter(([, ms]) => ms >= NAME_AT_MS).sort((a, b) => b[1] - a[1]);
      const others = total - named.reduce((sum, [, ms]) => sum + ms, 0);
      const parts = named.map(([name, ms]) => `${name} ${seconds(ms)}`);
      if (seconds(others) !== "0.0 s") parts.push(`others ${seconds(others)}`);
      const apart = [...asides].filter(([, ms]) => ms >= NAME_AT_MS).map(([name, ms]) => `${Math.round(ms / 1000)} s at the ${name}`);
      return `Start took ${seconds(total)}: ${parts.join(", ")}${apart.length ? ` (not counting ${apart.join(", ")})` : ""}`;
    },
  };
};

export type StartClock = ReturnType<typeof startClock>;
