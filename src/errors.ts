// A refusal the operator acts on (a missing config, a red gate, a live run): printed as a message, never a stack trace.
export class OperatorError extends Error {}

/**
 * The checkout refused a run's start (`assertCleanBase`): a dirty working tree, a branch that is not the base, or git's
 * half-done leftovers. A later autonomy turn that meets it ends the run as the turn before it did (`turnRefusedCause`,
 * `src/autonomy.ts`): another session's edit mid-run is a busy checkout, not a failure of the merged base. `reason` is
 * the short cause and `files` the paths it names (the dirty files, the leftovers); the message is the full refusal.
 */
export class CheckoutRefusal extends OperatorError {
  readonly reason: string;
  readonly files: string[];
  constructor(message: string, reason: string, files: string[] = []) {
    super(message);
    this.reason = reason;
    this.files = files;
  }
}

const reported = new WeakSet<object>();

/**
 * Marks an error whose message the run's closing summary has printed already, and returns it: `cli.ts` then ends
 * the process on it without printing the message a second time.
 */
export const reportedError = <E>(error: E): E => {
  if (typeof error === "object" && error !== null) reported.add(error);
  return error;
};

/** Whether `reportedError` marked this error. */
export const wasReported = (error: unknown): boolean => typeof error === "object" && error !== null && reported.has(error);

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

/**
 * A container that took too long to start: the machine's state, not the `.git` guard's. Its own class, so a caller that
 * reads any other `OperatorError` as a failed `.git` check (a landing, which stops the run on one) tells it apart.
 */
export class SlowStartError extends OperatorError {}

/** Words for the cause and the fix of a container that took too long to start; the one text every start timeout carries. */
const slowStart = (seconds: number, what: string) =>
  new SlowStartError(`Docker took longer than ${seconds} s to ${what}, most likely because the machine is busy. Nothing was changed by it: retry once the machine is quieter.`);

/**
 * Sandcastle's container-start timeout (`ContainerStartTimeoutError`, 120 s), as an `OperatorError`, or undefined for
 * any other error. The library runs its effects through `runPromise`, so the error arrives wrapped in a
 * `FiberFailure` whose name or message still carries the tag and the milliseconds; both are read, whichever form it has.
 */
export const containerStartTimeout = (error: unknown): SlowStartError | undefined => {
  const e = error as { _tag?: string; name?: string; message?: string; timeoutMs?: number } | undefined;
  const text = `${e?._tag ?? ""} ${e?.name ?? ""} ${e?.message ?? ""}`;
  if (!/ContainerStartTimeoutError|container start timed out after \d+ms/.test(text)) return undefined;
  const ms = e?.timeoutMs ?? Number(/timed out after (\d+)ms/.exec(text)?.[1] ?? 120_000);
  return Object.assign(slowStart(Math.round(ms / 1000), "start a container"), { cause: error });
};

// The step and its exit at the head of `SetupFailed`'s message (and of a note cut from it).
// A step may hold backticks of its own, and a note cut at a word may end before the step's closing one, so the prefix
// is what says a line is `SetupFailed`'s, and the step with its exit is read up to the last "` exited N".
const SETUP_PREFIX = /^setup failed(?: again after a requeue)?: (?=`)/;

/** Whether a line is `SetupFailed`'s: a setup problem's words then name the step and `sandcastle gates`, not `doctor --verify`. */
export const isSetupLine = (line: string) => SETUP_PREFIX.test(line);

/**
 * Whether two `SetupFailed` lines (a message, or a note cut from one) name the same step with the same exit, whatever
 * the output's last line says. A note cut before its exit matches a line whose step begins with what it kept.
 */
const sameSetupStep = (a: string, b: string): boolean => {
  const body = (line: string) => {
    const rest = line.replace(SETUP_PREFIX, "");
    const whole = /^(`[\s\S]*` (?:exited \d+|did not finish))(?: - [\s\S]*)?$/.exec(rest)?.[1];
    return whole ? { text: whole, cut: false } : { text: rest.replace(/…$/, ""), cut: true };
  };
  const [x, y] = [body(a), body(b)];
  if (!x.cut && !y.cut) return x.text === y.text;
  return x.cut ? y.text.startsWith(x.text) : x.text.startsWith(y.text);
};

/**
 * A command of the project's `setup` that failed as a sandbox opened (`assertSetup`, src/sandbox.ts): the step, its exit
 * status and its output's last lines. The message is one line - the step and its last output line - for a ticket's
 * note; a ticket's open throws it, which costs that attempt, and the scheduler sends the ticket back once
 * (`src/schedule.ts`).
 */
export class SetupFailed extends Error {
  readonly failure: { name: "setup"; command: string; exitCode: number; output: string };
  constructor(failure: SetupFailed["failure"]) {
    const last = failure.output.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
    super(`setup failed: \`${failure.command}\` ${failure.exitCode < 0 ? "did not finish" : `exited ${failure.exitCode}`}${last ? ` - ${cutAtWord(last, 120)}` : ""}`);
    this.failure = failure;
  }
}

/**
 * `text` cut to at most `max` characters at a word, with "…" when it was cut. A text with no space to cut at is cut
 * at `max`.
 */
export const cutAtWord = (text: string, max = 160): string => {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const at = room.lastIndexOf(" ");
  return `${(at > 0 ? room.slice(0, at) : room).replace(/[\s,;:-]+$/, "")}…`;
};

/**
 * The status code of a GitHub server failure (an HTTP 5xx) in a prompt-expansion line, undefined for anything else.
 * `gh` words it `HTTP 502: Bad Gateway (https://...)`; a 5xx is GitHub's outage, not the setup's.
 */
export const githubServerError = (line: string): string | undefined => /\bHTTP (5\d\d)\b/.exec(line)?.[1];

/**
 * Whether two prompt-expansion lines are the same failure: equal once the command (which names the ticket) and an
 * elapsed time are set aside. The command's own output stays: a 404 and a 500 are two failures. Every HTTP 5xx is
 * one failure, whatever follows the status: a 502 and then a 504 are the same GitHub outage.
 */
export const sameExpansionFailure = (a: string, b: string): boolean => {
  // A failed setup step (`SetupFailed`): the same step with the same exit, whatever its last output line says.
  if (isSetupLine(a) || isSetupLine(b)) return isSetupLine(a) && isSetupLine(b) && sameSetupStep(a, b);
  const key = (line: string) =>
    line
      .replace(/`[^`]*`/g, "``")
      .replace(/\d+ms/g, "#ms")
      // From the status on: `gh` words the rest by the response (`502 Bad Gateway`, a JSON message, the URL called).
      .replace(/\bHTTP 5\d\d\b.*$/s, "HTTP 5xx");
  return key(a) === key(b);
};

/**
 * The cleaned line of a failed prompt expansion (a shell expression of the prompt that exited non-zero, or timed out), or
 * undefined for any other error. It is the ticket's setup, not its work, when every ticket fails the same way: the
 * token cannot see the repo, `gh` is not signed in. The library runs its effects through `runPromise`, so the error
 * arrives as a `FiberFailure` whose name or message carries the tag (`(FiberFailure) PromptError`); both are read. The
 * command's stderr is on the lines after the first, so the first non-empty line of it follows the command.
 */
export const promptExpansionLine = (error: unknown): string | undefined => {
  const e = error as { _tag?: string; name?: string; message?: string } | undefined;
  const raw = error instanceof Error ? e?.message ?? "" : String(error);
  if (!/\bPrompt(?:Expansion\w*)?Error\b/.test(`${e?._tag ?? ""} ${e?.name ?? ""} ${raw}`)) return undefined;
  const lines = raw.replace(/^\(FiberFailure\)\s*/, "").replace(/^\w*Error:\s*/, "").split("\n").map((l) => l.trim());
  const first = lines.find(Boolean) ?? "";
  const rest = first.endsWith(":") ? lines.slice(lines.indexOf(first) + 1).find(Boolean) : undefined;
  return cutAtWord(rest ? `${first} ${rest}` : first.replace(/:$/, ""));
};

/** A `docker run` that `execFileSync` or `spawnSync` ended at its time limit (`ETIMEDOUT`), as an `OperatorError` naming `what` ran too long. */
export const dockerRunTimeout = (error: unknown, seconds: number, what: string): SlowStartError | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? Object.assign(slowStart(seconds, what), { cause: error }) : undefined;
