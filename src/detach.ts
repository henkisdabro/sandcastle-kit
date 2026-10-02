// A run that outlives the command that started it: `sandcastle run --detach`, then
// `sandcastle wait` and `sandcastle stop`.
//
// An agent that starts a run needs it to survive the agent's own session and a harness's
// background-command time cap, so the run is its own process, in its own session, writing to a
// log. It has no terminal, so nothing in it may ask a question (autonomy level 1 is refused) and
// it never adopts the tab its starter is in (herdr.ts). `wait` and `stop` find it through the
// run lock, the same file that keeps a second run out.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OperatorError } from "./errors.ts";
import { alive } from "./pool.ts";

export const OUTPUT_LOG = ".sandcastle/logs/run-output.log";

const lockFile = (root: string) => join(root, ".sandcastle/logs/run.lock");

/** The pid in the run lock if that process is alive: the live run of this project, if there is one. */
export const livePid = (root: string): number | undefined => {
  let text: string;
  try {
    text = readFileSync(lockFile(root), "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(text.split(" ")[0]);
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
};

/** The exit code the run wrote to run.json at its end; 0 when there is none (no run, or one killed outright). */
export const recordedExitCode = (root: string): number => {
  try {
    const code = JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")).exitCode;
    return Number.isInteger(code) ? code : 0;
  } catch {
    return 0;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tail = (text: string, lines: number) => text.split("\n").filter((l) => l.trim()).slice(-lines).join("\n");
const readLog = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** How this process was started, less its arguments: node's own flags (the tsx loader) and the CLI's path. */
const cliEntry = () => [...process.execArgv, fileURLToPath(new URL("./cli.ts", import.meta.url))];

export type Detached = {
  /** What to print. */
  lines: string[];
  /** The starter's exit code: 0 once the run is going, the run's own if it ended before it got going. */
  code: number;
};

/**
 * Starts the run as a detached process and returns once it is going: in Herdr when it has printed
 * where its status view is, elsewhere when it holds the run lock. A run that ends before that is
 * reported with the end of its output. `entry` is what node runs instead of the CLI (a test's
 * stand-in); `args` are the run's own, without `--detach`.
 */
export const startDetached = async (
  root: string,
  args: string[],
  { entry = cliEntry(), inHerdr, timeoutMs = 60_000 }: { entry?: string[]; inHerdr: boolean; timeoutMs?: number },
): Promise<Detached> => {
  const log = join(root, OUTPUT_LOG);
  mkdirSync(dirname(log), { recursive: true });
  // Opened for writing, so each run starts its log afresh; the child's stdout and stderr share it.
  const fd = openSync(log, "w");
  const env = { ...process.env, SANDCASTLE_DETACHED: "1" } as NodeJS.ProcessEnv;
  delete env.SANDCASTLE_DETACH;
  let ended: number | undefined;
  let failed: Error | undefined;
  const child = spawn(process.execPath, [...entry, "run", ...args], { cwd: root, detached: true, stdio: ["ignore", fd, fd], env });
  closeSync(fd);
  child.on("error", (error) => (failed = error));
  child.on("exit", (code, signal) => (ended = code ?? (signal ? 128 : 1)));
  child.unref();

  const pid = child.pid;
  let status: string | undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && ended === undefined && !failed) {
    if (inHerdr) {
      // Printed by the run (burndown.ts) once its view is open.
      const found = /^Status view: pane (\S+)(?: \(tab (\S+)\))?$/m.exec(readLog(log));
      if (found) status = `Status view: pane ${found[1]}${found[2] ? ` (tab ${found[2]})` : ""}`;
    } else if (pid !== undefined && livePid(root) === pid) {
      status = "Status view: run `sandcastle status`";
    }
    if (status) break;
    await sleep(100);
  }
  if (failed) throw new OperatorError(`NOT STARTED: the run could not be started (${failed.message}).`);
  if (ended !== undefined) {
    // Let the exit's last output reach the file before it is read.
    await sleep(50);
    return {
      lines: [`The run ended at once (exit ${ended}). Its output (${OUTPUT_LOG}):`, tail(readLog(log), 12)],
      code: ended,
    };
  }
  return {
    lines: [
      `Run started detached (pid ${pid}). ${status ?? `Status view: not reported within ${Math.round(timeoutMs / 1000)} s - read the output`}. ` +
        `Output: ${OUTPUT_LOG}. \`sandcastle wait\` ends with the run; \`sandcastle stop\` stops it.`,
    ],
    code: 0,
  };
};

/**
 * Blocks while the process holding the run lock is alive. The lock goes before the process does
 * (its exit handlers run in turn, and the record's exit code is written after the lock is
 * released), so the pid last seen is waited for too: reading the record any sooner gave the
 * previous exit code. `seconds` undefined waits as long as it takes.
 */
export const waitForRun = async (root: string, seconds?: number, pollMs = 500): Promise<{ ended: boolean; pid?: number }> => {
  const deadline = seconds === undefined ? Infinity : Date.now() + seconds * 1000;
  let seen: number | undefined;
  for (;;) {
    const now = livePid(root) ?? (seen !== undefined && alive(seen) ? seen : undefined);
    if (now === undefined) return { ended: true };
    seen = now;
    if (Date.now() >= deadline) return { ended: false, pid: now };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
};
