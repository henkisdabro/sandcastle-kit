// Live runs, one file per project holding its root, so the Herdr tab bar can show every run on
// the machine whichever pane has focus, and the Claude Code mod can find a run its session
// started in another directory. Written by the run itself (burndown.ts), with or without Herdr.
// A run that dies without its exit handler leaves its file; readers ask `liveness` (the mod's
// run-live.ts) about the run's pid and drop the file when the run is not live. A run whose Herdr
// tab is still to be told how it ended moves its file to the awaiting directory beside it
// (`registerRun`, and the readers for a run that died): the tab bar starts the kit only while
// `runs` has a file, so a finished run kept there started it every tick for as long as its status
// view ran, and for good on a Herdr server that never came back.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// `||`, not `??`: an empty XDG_CACHE_HOME is unset (the XDG rule, and the mod's shell reads it so).
export const KIT_CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sandcastle-kit");
export const RUNS_DIR = join(KIT_CACHE, "runs");
/** Beside the runs directory: finished runs whose own Herdr tab is still to be told how they ended, a file each, named as in `runs`. */
export const awaitingDir = (runsDir = RUNS_DIR) => join(dirname(runsDir), "awaiting");
// A tab not told within this many days of its run's end never will be: its server is gone, or the
// tab was closed while the status view ran. Without an end its file stayed for good.
export const AWAIT_REPORT_DAYS = 7;
// Left by `sandcastle herdr configure` while the plugin is linked, and read by status.sh (at
// this path, in shell) to know that a Ctrl-click on a ticket will open its card.
export const PLUGIN_MARKER = join(KIT_CACHE, "herdr-plugin-linked");

/**
 * The process check `liveness` is given: the command line of the process with this pid, or
 * undefined when there is none. A signal of 0 says whether the process exists without waking
 * it (EPERM: it exists, another user's); `ps` then says what it is, so a pid that came round
 * as some other process is told from the run. `-p` and `-o command=` are what BSD `ps` (macOS)
 * and procps-ng share, the flags the mod and status.sh use too.
 */
export const commandOf = (pid: number): string | undefined => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return ps.status === 0 ? ps.stdout.trim() || undefined : undefined;
};

/** The root with symlinks resolved (macOS: `/tmp` is `/private/tmp`), or as given when it cannot be. */
export const real = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

/** Named by the resolved root, so one project reached by two paths has one file. */
export const runFile = (root: string, dir = RUNS_DIR) => join(dir, createHash("sha1").update(real(root)).digest("hex").slice(0, 12));

// The tab and panes a run opened in Herdr, written by `openSandboxView` (herdr.ts) for the next run
// and the plugin to find. Here, not in herdr.ts, for the exit handler below.
export const viewRecord = (root: string) => join(root, ".sandcastle/logs/herdr-view.json");

/**
 * Whether the run's view record is a tab the kit opened for it (not one adopted from a person's
 * terminal) that has not been given the report. A Herdr restart leaves that tab as idle shells, and
 * a run that ends after it (or is stopped by the restart's hangup) has nothing else to say so: the
 * plugin reports there, from the awaiting directory.
 */
const tabAwaitsReport = (root: string) => {
  try {
    const view = JSON.parse(readFileSync(viewRecord(root), "utf8")) as { adopted?: boolean; reported?: boolean };
    // Only the plugin's readers remove a kept file: without the plugin it would stay for good.
    return view.adopted === false && !view.reported && existsSync(PLUGIN_MARKER);
  } catch {
    return false;
  }
};

/** Moves a finished run's file (`file`, in `dir`), holding its root, to the awaiting directory. Best effort, as registering is. */
export const awaitReport = (root: string, dir = RUNS_DIR, file = runFile(root, dir)): void => {
  try {
    mkdirSync(awaitingDir(dir), { recursive: true });
    writeFileSync(runFile(root, awaitingDir(dir)), root);
  } catch {
    /* the tab goes untold, as with no plugin */
  }
  rmSync(file, { force: true });
};

/**
 * Whether the run of `root` ended more than `AWAIT_REPORT_DAYS` ago: from its record's `finishedAt`,
 * or, for a killed run that wrote none, the record's last change. No record reads as gone.
 */
export const awaitedTooLong = (root: string, now = Date.now()): boolean => {
  const record = join(root, ".sandcastle/logs/run.json");
  try {
    const { finishedAt } = JSON.parse(readFileSync(record, "utf8")) as { finishedAt?: unknown };
    const finished = typeof finishedAt === "string" ? Date.parse(finishedAt) : Number.NaN;
    const ended = Number.isNaN(finished) ? statSync(record).mtimeMs : finished;
    return now - ended > AWAIT_REPORT_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
};

const registered = new Set<string>();

/**
 * Registers this process's run of `root` and removes the file when the process exits (a clean end,
 * or a stop on SIGHUP, SIGINT or SIGTERM: run.ts runs the exit handlers), unless the run's own Herdr
 * tab is still to be told how it ended: then it moves to the awaiting directory, which the plugin's
 * readers clear once the tab has been told (`tellDeadTab`).
 * The file holds the root as given: the tab bar compares it with the cwd Herdr reports. Once per
 * file: an autonomy run's next turn is the same process and the same run. Best effort - a cache
 * directory that cannot be written must not stop a run.
 */
export const registerRun = (root: string, dir = RUNS_DIR): void => {
  const file = runFile(root, dir);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, root);
  } catch {
    return;
  }
  if (registered.has(file)) return;
  registered.add(file);
  process.on("exit", () => {
    if (tabAwaitsReport(root)) awaitReport(root, dir, file);
    else rmSync(file, { force: true });
  });
};
