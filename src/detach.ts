// A run that outlives the command that started it: `sandcastle run --detach`, then
// `sandcastle wait` and `sandcastle stop`; and the two controls of a live run that are not an end,
// `sandcastle pause` and `sandcastle resume`.
//
// An agent that starts a run needs it to survive the agent's own session and a harness's
// background-command time cap, so the run is its own process, in its own session, writing to a
// log. It has no terminal, so nothing in it may ask a question (autonomy level 1 is refused) and
// it never adopts the tab its starter is in (herdr.ts). `wait` and `stop` find it through the
// run lock, the same file that keeps a second run out. `pause` and `resume` write and remove a
// control file the run reads (`readPause`), which names the run's pid: one left by a run that died
// is another run's, and pauses nothing. A run with `USAGE_PAUSE` set writes the same file when its plan's
// usage calls for it (`holdForUsage`), with the cause and the time it resumes at in it.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OperatorError } from "./errors.ts";
import { commandOf } from "./live-runs.ts";
import { withLockSync } from "./pool.ts";
import { DOCKER_INFO_ENV } from "./runtime.ts";
import { readUsagePaused, type StandingPause } from "./usage.ts";
import type { UsagePaused } from "../mod/hooks/run-record.ts";
import { kitRunning, liveness, type Probe } from "../mod/hooks/run-live.ts";

export const OUTPUT_LOG = ".sandcastle/logs/run-output.log";

const lockFile = (root: string) => join(root, ".sandcastle/logs/run.lock");

/** The pid in the run lock if that process is the kit's and running: the live run of this project, if there is one. */
export const livePid = (root: string, probe: Probe = commandOf): number | undefined => {
  const pid = lockPid(root);
  return kitRunning(pid, probe) ? pid : undefined;
};

const lockPid = (root: string): number | undefined => {
  try {
    return Number(readFileSync(lockFile(root), "utf8").split(" ")[0]);
  } catch {
    return undefined;
  }
};

/** The pid run.json names while the run has written no end: a run that has not finished, whether or not it still holds the lock. */
const unfinishedPid = (root: string, probe: Probe): number | undefined => {
  try {
    const live = liveness({ record: JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")) }, probe);
    return live.state === "live" ? live.pid : undefined;
  } catch {
    return undefined;
  }
};

/** The pause's control file, in the project's gitignored `.sandcastle/.run/`: present while a person has the run paused. */
export const PAUSE_FILE = ".sandcastle/.run/paused";

const pauseFile = (root: string) => join(root, PAUSE_FILE);

/**
 * Runs a read-then-write of the control file whole under a short lock beside it: the usage timer's
 * `holdForUsage` read "no pause" and then renamed its own over a person's `sandcastle pause` that
 * landed in between. Every writer and `resumeRun` takes it, so the rule that the timer never replaces
 * or undoes a person's pause holds whatever the order of the processes.
 */
const underLock = <T>(root: string, fn: () => T): T => withLockSync(`${pauseFile(root)}.lock`, "pause", fn);

/**
 * The pause asked for the run with this pid (`since` in seconds since the epoch), or undefined: no
 * file, one that cannot be read, or one written for another run - a run that died while paused must
 * not leave the next one paused. A pause the run took for its plan's usage carries `usage`, and is none
 * once its `resumesAt` has come (`now`, seconds): the file is left where it is, and never read as a pause
 * again. One whose cause cannot be read is a person's, which stays until `sandcastle resume`.
 * Never throws: the run reads it every second.
 */
export const readPause = (root: string, pid: number, now = Date.now() / 1000): StandingPause | undefined => {
  try {
    const found = JSON.parse(readFileSync(pauseFile(root), "utf8")) as { pid?: unknown; since?: unknown; cause?: unknown };
    if (found.pid !== pid || typeof found.since !== "number" || !Number.isFinite(found.since)) return undefined;
    const usage = found.cause === "usage" ? readUsagePaused(found) : undefined;
    if (!usage) return { since: found.since };
    return usage.resumesAt > now ? { since: found.since, usage } : undefined;
  } catch {
    return undefined;
  }
};

/** Writes the control file whole and renamed in, as the run reads it every second. */
const writePause = (root: string, pause: { pid: number; since: number } & Partial<UsagePaused>) => {
  mkdirSync(dirname(pauseFile(root)), { recursive: true });
  const tmp = `${pauseFile(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pause) + "\n");
  renameSync(tmp, pauseFile(root));
};

/**
 * The run's own pause for its plan's usage (`USAGE_PAUSE`): the control file with the cause, the window and
 * the time to resume at. Nothing when a person's pause stands - the timer must never undo it - or when the
 * run's own already waits for this window or a later one; a later reset moves the standing one on, and keeps its `since`.
 */
export const holdForUsage = (root: string, pid: number, pause: UsagePaused, now = Math.floor(Date.now() / 1000)): void =>
  underLock(root, () => {
    const standing = readPause(root, pid, now);
    if (standing && (!standing.usage || standing.usage.resumesAt >= pause.resumesAt)) return;
    writePause(root, { pid, since: standing?.since ?? now, ...pause });
  });

/** What `sandcastle pause` did: nothing for lack of a run, nothing for a run already paused, or paused it. */
export type Paused =
  | { kind: "no run" }
  | { kind: "already"; pid: number; since: number }
  | { kind: "paused"; pid: number; since: number }
  /** The run had paused itself for its plan's usage: the pause is a person's now, and no timer resumes it. */
  | { kind: "taken over"; pid: number; since: number; usage: UsagePaused };

/** Pauses the project's live run: writes the control file the run reads. Written whole and renamed in, as the run reads it every second. */
export const pauseRun = (root: string, probe: Probe = commandOf, now = () => Math.floor(Date.now() / 1000)): Paused => {
  const pid = livePid(root, probe);
  if (pid === undefined) return { kind: "no run" };
  return underLock(root, (): Paused => {
    const since = now();
    const standing = readPause(root, pid, since);
    if (standing?.usage) {
      writePause(root, { pid, since: standing.since });
      return { kind: "taken over", pid, since: standing.since, usage: standing.usage };
    }
    if (standing) return { kind: "already", pid, since: standing.since };
    writePause(root, { pid, since });
    return { kind: "paused", pid, since };
  });
};

/** What `sandcastle resume` did: nothing for lack of a run, nothing for a run not paused, or resumed it. */
export type Resumed = { kind: "no run" } | { kind: "not paused"; pid: number } | { kind: "resumed"; pid: number; since: number; usage?: UsagePaused };

/** Resumes the project's live run: removes the control file, and one left by a run that died with it. */
export const resumeRun = (root: string, probe: Probe = commandOf): Resumed => {
  const pid = livePid(root, probe);
  if (pid === undefined) return { kind: "no run" };
  const standing = underLock(root, () => {
    const found = readPause(root, pid);
    rmSync(pauseFile(root), { force: true });
    return found;
  });
  return standing ? { kind: "resumed", pid, since: standing.since, ...(standing.usage ? { usage: standing.usage } : {}) } : { kind: "not paused", pid };
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

/** How this process was started, less its arguments: node's own flags (the launcher's preload among them) and the CLI's path. */
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
 * stand-in); `args` are the run's own, without `--detach`; `dockerInfo` is the `docker info` the
 * parent has read, which the child takes over.
 */
export const startDetached = async (
  root: string,
  args: string[],
  { entry = cliEntry(), inHerdr, timeoutMs = 60_000, dockerInfo }: { entry?: string[]; inHerdr: boolean; timeoutMs?: number; dockerInfo?: string },
): Promise<Detached> => {
  const log = join(root, OUTPUT_LOG);
  mkdirSync(dirname(log), { recursive: true });
  // Each run starts its log afresh, so the skill's "read every turn's summary" reads this run
  // alone; the run before is kept in logs/archive/, where it was once overwritten and lost.
  if (existsSync(log)) {
    const archive = join(dirname(log), "archive");
    mkdirSync(archive, { recursive: true });
    renameSync(log, join(archive, `run-output-${statSync(log).mtime.toISOString().replace(/[:.]/g, "-")}.log`));
  }
  // The child's stdout and stderr share it.
  const fd = openSync(log, "w");
  const env = { ...process.env, SANDCASTLE_DETACHED: "1" } as NodeJS.ProcessEnv;
  delete env.SANDCASTLE_DETACH;
  // The one `docker info` reading of this start, so the child asks the daemon nothing the parent already did; a stale one from the starter's environment is never passed on.
  delete env[DOCKER_INFO_ENV];
  if (dockerInfo !== undefined) env[DOCKER_INFO_ENV] = dockerInfo;
  let ended: number | undefined;
  let failed: Error | undefined;
  const child = spawn(process.execPath, [...entry, "run", ...args], { cwd: root, detached: true, stdio: ["ignore", fd, fd], env });
  closeSync(fd);
  child.on("error", (error) => (failed = error));
  // A run ends on SIGINT or SIGTERM by re-raising it (src/run.ts `exitOnSignal`): report what the
  // shell would, 130 or 143, not a bare 128.
  child.on("exit", (code, signal) => (ended = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)));
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
 * Blocks while the run is alive: the process holding the run lock, or the one run.json names while
 * it has no exit code. The lock goes before the process does (its exit handlers run in turn, and
 * the record's exit code is written after the lock is released), so a `wait` that starts inside
 * that gap finds no lock but still sees a live pid with an unfinished record; and the pid last
 * seen is waited for too: reading the record any sooner gave the previous exit code. `seconds`
 * undefined waits as long as it takes.
 */
export const waitForRun = async (root: string, seconds?: number, pollMs = 500, probe: Probe = commandOf): Promise<{ ended: boolean; pid?: number }> => {
  const deadline = seconds === undefined ? Infinity : Date.now() + seconds * 1000;
  let seen: number | undefined;
  for (;;) {
    const now = livePid(root, probe) ?? unfinishedPid(root, probe) ?? (kitRunning(seen, probe) ? seen : undefined);
    if (now === undefined) return { ended: true };
    seen = now;
    if (Date.now() >= deadline) return { ended: false, pid: now };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
};
