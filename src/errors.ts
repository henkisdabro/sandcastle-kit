// A refusal the operator acts on (a missing config, a red gate, a live run): printed as a message, never a stack trace.
export class OperatorError extends Error {}

/** Edit distance between two words, for "did you mean" on a typo. */
export const distance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};

/** The candidate nearest `word`, within two edits, if any. */
export const nearest = (word: string, candidates: string[]) =>
  candidates.filter((c) => distance(word, c) <= 2).sort((a, b) => distance(word, a) - distance(word, b))[0];

/** Words for the cause and the fix of a container that took too long to start; the one text every start timeout carries. */
const slowStart = (seconds: number, what: string) =>
  new OperatorError(`Docker took longer than ${seconds} s to ${what}, most likely because the machine is busy. Nothing was changed by it: retry once the machine is quieter.`);

/**
 * Sandcastle's container-start timeout (`ContainerStartTimeoutError`, 120 s), as an `OperatorError`, or undefined for
 * any other error. The library runs its effects through `runPromise`, so the error arrives wrapped in a
 * `FiberFailure` whose name or message still carries the tag and the milliseconds; both are read, whichever form it has.
 */
export const containerStartTimeout = (error: unknown): OperatorError | undefined => {
  const e = error as { _tag?: string; name?: string; message?: string; timeoutMs?: number } | undefined;
  const text = `${e?._tag ?? ""} ${e?.name ?? ""} ${e?.message ?? ""}`;
  if (!/ContainerStartTimeoutError|container start timed out after \d+ms/.test(text)) return undefined;
  const ms = e?.timeoutMs ?? Number(/timed out after (\d+)ms/.exec(text)?.[1] ?? 120_000);
  return Object.assign(slowStart(Math.round(ms / 1000), "start a container"), { cause: error });
};

/** A `docker run` that `execFileSync` or `spawnSync` ended at its time limit (`ETIMEDOUT`), as an `OperatorError` naming `what` ran too long. */
export const dockerRunTimeout = (error: unknown, seconds: number, what: string): OperatorError | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? Object.assign(slowStart(seconds, what), { cause: error }) : undefined;
