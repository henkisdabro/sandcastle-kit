// Live runs, one file per project holding its root, so the Herdr tab bar can show every run on
// the machine whichever pane has focus, and the Claude Code mod can find a run its session
// started in another directory. Written by the run itself (burndown.ts), with or without Herdr.
// A run that dies without its exit handler leaves its file; readers ask `liveness` (the mod's
// run-live.ts) about the run's pid and drop the file when the run is not live. A run whose Herdr
// tab is still to be told how it ended leaves its file at a clean exit too (`registerRun`).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `||`, not `??`: an empty XDG_CACHE_HOME is unset (the XDG rule, and the mod's shell reads it so).
export const KIT_CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sandcastle-kit");
export const RUNS_DIR = join(KIT_CACHE, "runs");
// Left by `sandcastle herdr configure` while the plugin is linked, and read by status.sh (at
// this path, in shell) to know that a Ctrl-click on a ticket will open its log.
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
 * tab bar's tick reports there, but the tab bar runs the kit only while a file is in the directory.
 */
const tabAwaitsReport = (root: string) => {
  try {
    const view = JSON.parse(readFileSync(viewRecord(root), "utf8")) as { adopted?: boolean; reported?: boolean };
    return view.adopted === false && !view.reported;
  } catch {
    return false;
  }
};

const registered = new Set<string>();

/**
 * Registers this process's run of `root` and removes the file when the process exits (a clean end,
 * or a stop on SIGHUP, SIGINT or SIGTERM: run.ts runs the exit handlers), unless the run's own Herdr
 * tab is still to be told how it ended: then the readers remove it once it has been (`tellDeadTab`).
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
    if (!tabAwaitsReport(root)) rmSync(file, { force: true });
  });
};
