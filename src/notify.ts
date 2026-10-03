// The end-of-run notify command from the personal config.json: any program, as an argv
// array, run once when a run ends. Herdr's own notification is separate and still fires.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { OperatorError } from "./errors.ts";
import type { RunRecord, TicketState } from "../mod/hooks/run-record.ts";
import { NEEDS_FIXING } from "./report.ts";
import { machineSettings, USER_CONFIG } from "./sandbox.ts";

// Refused before the run starts: a typo found at the end of a six-hour run would be a
// notification that never came.
export const notifyCommand = (): string[] | undefined => {
  const value = machineSettings().notify;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || v === "")) {
    throw new OperatorError(
      `NOT STARTED: "notify" in ${join(USER_CONFIG, "config.json")} must be a list of strings - the command and its arguments, for example ["notify-send", "Sandcastle"] - not a shell string.`,
    );
  }
  return value as string[];
};

// One line from the final run record, the same shape the closing summary's counts use.
export const endSummary = (run: RunRecord): string => {
  const all = Object.values(run.tickets ?? {});
  const tickets = all.filter((t) => t.state !== "blocked");
  const count = (states: TicketState[]) => tickets.filter((t) => t.state && states.includes(t.state)).length;
  const merged = count(["merged"]);
  const needYou = count(["held"]) + tickets.filter((t) => t.state === "merged" && (t.closeFailed || t.unmet)).length;
  const fixing = count(NEEDS_FIXING);
  const head =
    (run.stopped ? "run STOPPED before landing" : run.exitCode === 0 ? "run finished" : `run ended with exit ${run.exitCode}`) +
    (run.dryRun ? " (dry run)" : "");
  return `${head} - ${merged} merged, ${needYou} need you, ${fixing} need fixing, of ${tickets.length}`;
};

// Synchronous on purpose: an exit handler cannot wait for an async child. Nothing here
// may throw out of the handler or change the process's exit code.
export const runNotify = (cmd: string[], name: string, run: RunRecord): void => {
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      stdio: "ignore",
      timeout: 10_000,
      env: { ...process.env, SANDCASTLE_NAME: name, SANDCASTLE_SUMMARY: endSummary(run), SANDCASTLE_EXIT: String(run.exitCode ?? "") },
    });
    if (r.error || r.status !== 0) {
      console.error(`notify: ${cmd[0]} failed (${r.error ? r.error.message : `exit ${r.status}`}) - the run's result stands.`);
    }
  } catch {
    /* a notifier is a convenience; the run already ended */
  }
};
