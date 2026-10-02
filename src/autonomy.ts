// Autonomy levels: how many turns (runs) one `sandcastle run` may make, which tickets a
// further turn would take, and the level-1 question. The loop itself is in cli.ts.
import { createInterface } from "node:readline/promises";
import { OperatorError } from "./errors.ts";
import type { Facts } from "./report.ts";

const parse = (value: string): number | undefined => (/^[0-3]$/.test(value) ? Number(value) : undefined);

/** 0 (default: one turn, no question), 1 (ask after every turn), 2 or 3 (the most turns). `env` wins over `config`. */
export const autonomyLevel = (env: string | undefined, config: unknown): number => {
  const fromEnv = env?.trim();
  if (fromEnv) {
    const level = parse(fromEnv);
    if (level === undefined) throw new OperatorError(`AUTONOMY_LEVEL=${fromEnv} - expected 0, 1, 2 or 3.`);
    return level;
  }
  if (config === undefined) return 0;
  const level = typeof config === "number" ? parse(String(config)) : undefined;
  if (level === undefined) throw new OperatorError(`autonomy: ${String(config)} in .sandcastle/config.ts - expected 0, 1, 2 or 3.`);
  return level;
};

export type Rerun = { conflicted: string[]; unblocked: string[] };

/**
 * What a further turn would take, or undefined when none should follow: a dry run changed
 * nothing, a stopped run or one that hit a usage limit should not be restarted by itself, and
 * a red base is not built on. An "uncommitted" ticket is not counted: its commit was refused,
 * and another turn would only repeat the refusal until a person fixes the cause.
 */
export const rerunnable = (facts: Facts): Rerun | undefined => {
  const tickets = Object.entries(facts.tickets);
  if (facts.dryRun || facts.stopped || facts.verify?.green === false) return undefined;
  if (tickets.some(([, t]) => t.state === "skipped")) return undefined;
  return {
    conflicted: tickets.filter(([, t]) => t.state === "conflict").map(([id]) => id),
    unblocked: facts.runnable,
  };
};

/** `turn` is the number of the turn that just ended (1-based). */
export const nextTurn = (level: number, turn: number, again: Rerun | undefined): "stop" | "ask" | "run" | "cap" => {
  if (!again || level === 0 || again.conflicted.length + again.unblocked.length === 0) return "stop";
  if (level === 1) return "ask";
  return turn < level ? "run" : "cap";
};

/** The last turn's line when tickets could still run again: the ids' own command, and the bare one, as the freed tickets are in the queue anyway. */
export const capLine = (level: number, ids: string[], list: string): string =>
  `Autonomy level ${level}: ${level} turn(s) done, the cap; ${ids.length} ticket(s) can still run again - ${list}. ` +
  `\`sandcastle run ${ids.join(" ")}\` runs them, or \`sandcastle run\` takes the whole queue.`;

export const rerunList = (again: Rerun, ref: (id: string) => string): string => {
  const all = [...again.conflicted, ...again.unblocked].map(ref).join(", ");
  const parts = [
    again.conflicted.length ? `conflicted: ${again.conflicted.map(ref).join(", ")}` : "",
    again.unblocked.length ? `unblocked: ${again.unblocked.map(ref).join(", ")}` : "",
  ].filter(Boolean);
  return `${all} (${parts.join("; ")})`;
};

/** undefined without reading when the input is not a terminal: a pipe, CI or `nohup` never blocks. Default No. */
export const confirm = async (
  question: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean | undefined> => {
  if (input.isTTY !== true) return undefined;
  const rl = createInterface({ input, output });
  try {
    return /^y/i.test((await rl.question(question)).trim());
  } catch (error) {
    // Ctrl-C at the question is a no, not a stack trace.
    if ((error as Error).name !== "AbortError") throw error;
    output.write("\n");
    return false;
  } finally {
    rl.close();
  }
};
