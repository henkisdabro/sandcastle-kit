// Autonomy levels: how many turns (runs) one `sandcastle run` may make, which tickets a
// further turn would take, and the level-1 question. The loop itself is in cli.ts.
import { createInterface } from "node:readline/promises";
import type { OutcomeEntry } from "../mod/hooks/run-record.ts";
import { OperatorError } from "./errors.ts";
import type { Facts } from "./report.ts";
import type { Ticket, Tracker } from "./tracker.ts";

/** `drain`: turns until the queue is drained or a stop condition holds, never more than DRAIN_CAP. */
export type Level = 0 | 1 | 2 | 3 | "drain";

/** The backstop for `drain`: a queue that still has work after this many turns needs a person. */
export const DRAIN_CAP = 20;

const parse = (value: string): Level | undefined => (/^[0-3]$/.test(value) ? (Number(value) as Level) : value === "drain" ? "drain" : undefined);

/** 0 (default: one turn, no question), 1 (ask after every turn), 2 or 3 (the most turns), `drain` (until drained). `env` wins over `config`. */
export const autonomyLevel = (env: string | undefined, config: unknown): Level => {
  const fromEnv = env?.trim();
  if (fromEnv) {
    const level = parse(fromEnv);
    if (level === undefined) throw new OperatorError(`AUTONOMY_LEVEL=${fromEnv} - expected 0, 1, 2, 3 or drain.`);
    return level;
  }
  if (config === undefined) return 0;
  const level = typeof config === "number" || config === "drain" ? parse(String(config)) : undefined;
  if (level === undefined) throw new OperatorError(`autonomy: ${String(config)} in .sandcastle/config.ts - expected 0, 1, 2, 3 or "drain".`);
  return level;
};

export type Rerun = { conflicted: string[]; unblocked: string[] };

/** Why no further turn should follow a turn, or undefined when one may: the cause `drain` prints. */
export const noRerunCause = (facts: Facts): string | undefined => {
  if (facts.dryRun) return "the run was a dry run";
  if (facts.stopped) return `the run stopped (${facts.stopped})`;
  if (facts.verify?.green === false) return "the merged base is red";
  // A usage limit leaves no `stopped`, only skipped tickets whose note names it.
  const skipped = Object.values(facts.tickets).find((t) => t.state === "skipped");
  if (skipped) return `the run stopped early (${skipped.note?.replace(/^not started: /, "") || "tickets were not started"})`;
  return undefined;
};

/**
 * What a further turn would take, or undefined when none should follow: a dry run changed
 * nothing, a stopped run or one that hit a usage limit should not be restarted by itself, and
 * a red base is not built on. An "uncommitted" ticket is not counted: its commit was refused,
 * and another turn would only repeat the refusal until a person fixes the cause.
 */
export const rerunnable = (facts: Facts): Rerun | undefined => {
  if (noRerunCause(facts)) return undefined;
  const tickets = Object.entries(facts.tickets);
  return {
    conflicted: tickets.filter(([, t]) => t.state === "conflict").map(([id]) => id),
    unblocked: facts.runnable,
  };
};

/** `turn` is the number of the turn that just ended (1-based). */
export const nextTurn = (level: Level, turn: number, again: Rerun | undefined): "stop" | "ask" | "run" | "cap" => {
  if (!again || level === 0 || again.conflicted.length + again.unblocked.length === 0) return "stop";
  if (level === 1) return "ask";
  return turn < (level === "drain" ? DRAIN_CAP : level) ? "run" : "cap";
};

/** The last turn's line when tickets could still run again: the ids' own command, and the bare one, as the freed tickets are in the queue anyway. */
export const capLine = (level: Exclude<Level, 0 | 1>, ids: string[], list: string): string => {
  const turns = level === "drain" ? DRAIN_CAP : level;
  return (
    `Autonomy level ${level}: ${turns} turn(s) done, the cap; ${ids.length} ticket(s) can still run again - ${list}. ` +
    `\`sandcastle run ${ids.join(" ")}\` runs them, or \`sandcastle run\` takes the whole queue.`
  );
};

/** What one `drain` turn did, for deciding whether another is worth taking. */
export type DrainTurn = {
  /** Tickets this turn merged. */
  landed: number;
  /** Tickets this turn's landings freed that the turn before did not already have free. */
  released: string[];
  /** Tickets whose outcome from this turn is a merge conflict (outcomes.json). */
  conflicted: string[];
};

/**
 * The cause to stop `drain` on after a turn, or undefined to go on: the same ticket conflicting
 * in two turns running (a third try would conflict the same way), or a turn that landed and
 * released nothing (the next would start from the same queue).
 */
export const drainStop = (turn: DrainTurn, earlier: DrainTurn | undefined, ref: (id: string) => string = (id) => id): string | undefined => {
  const again = earlier ? turn.conflicted.filter((id) => earlier.conflicted.includes(id)) : [];
  if (again.length) return `${again.map(ref).join(", ")} conflicted in two turns running`;
  if (turn.landed === 0 && turn.released.length === 0) return "no progress: the turn landed nothing and released nothing";
  return undefined;
};

/** The tickets a run recorded as a merge conflict, by id: outcomes.json keeps one entry per ticket, with the run that wrote it. */
export const conflictedIn = (outcomes: Record<string, OutcomeEntry>, run: string): string[] =>
  Object.entries(outcomes)
    .filter(([, o]) => o?.run === run && o.kind === "conflict")
    .map(([id]) => id);

export const drainLine = (turns: number, landed: number, cause: string): string =>
  `Drain: ${turns} turn${turns === 1 ? "" : "s"}, ${landed} landed, stopped because ${cause}`;

/**
 * The closing lines for tickets the queue holds now that no turn of the run had: queued after it
 * started, so the drain does not take them (a turn takes only the last turn's re-runnable tickets,
 * never the whole queue) and the next `sandcastle run` does. `held` names the ones a blocker holds
 * back, which a bare `sandcastle run` would not start either. Unreadable queue: no line, as the
 * run is over and the lines are only a courtesy.
 */
export const lateQueueLines = async (
  tracker: Tracker,
  inRun: ReadonlySet<string>,
  held: (queue: Ticket[]) => Promise<ReadonlySet<string>>,
): Promise<string[]> => {
  try {
    const late = tracker.queued(false).filter((t) => !inRun.has(t.id));
    if (late.length === 0) return [];
    const blocked = await held(late);
    return late.filter((t) => !blocked.has(t.id)).map((t) => `${tracker.ref(t.id)} was queued after this run started: \`sandcastle run\` takes it`);
  } catch {
    return [];
  }
};

export const rerunList = (again: Rerun, ref: (id: string) => string): string => {
  const all = [...again.conflicted, ...again.unblocked].map(ref).join(", ");
  const parts = [
    again.conflicted.length ? `conflicted: ${again.conflicted.map(ref).join(", ")}` : "",
    again.unblocked.length ? `unblocked: ${again.unblocked.map(ref).join(", ")}` : "",
  ].filter(Boolean);
  return `${all} (${parts.join("; ")})`;
};

/** Whether the tracker still has the ticket open; unreadable counts as closed, so a re-run never names it. */
export const stillOpen = (tracker: Tracker) => (id: string): boolean => {
  try {
    return tracker.get(id).open;
  } catch {
    return false;
  }
};

/**
 * What the loop does after a turn, from that turn's facts: the tickets a further turn would take
 * (`open` drops one closed by hand, which would make the TICKETS path throw) and the verdict. The
 * loop in cli.ts and the turn's own closing summary both ask, so the summary never says the
 * operator's next step is something the loop is about to do.
 */
export const afterTurn = (facts: Facts, level: Level, turn: number, open: (id: string) => boolean) => {
  const again = rerunnable(facts);
  if (!again) return undefined;
  const left: Rerun = { conflicted: again.conflicted.filter(open), unblocked: again.unblocked.filter(open) };
  return { left, ids: [...left.conflicted, ...left.unblocked], verdict: nextTurn(level, turn, left) };
};

/** undefined without reading when the input is not a terminal: a pipe, CI or `nohup` never blocks. Default No. */
export const confirm = async (
  question: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  /** The answer to a bare Enter. */
  byDefault = false,
): Promise<boolean | undefined> => {
  if (input.isTTY !== true) return undefined;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    return answer ? /^y/i.test(answer) : byDefault;
  } catch (error) {
    // Ctrl-C at the question is a no, not a stack trace.
    if ((error as Error).name !== "AbortError") throw error;
    output.write("\n");
    return false;
  } finally {
    rl.close();
  }
};
