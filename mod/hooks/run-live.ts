// Whether a run is live: the one rule behind the status view, the Herdr tab bar, the closing
// summary, `sandcastle wait` and the Claude Code mod. A run is live when its record has not
// finished and its pid is a process whose command line contains RUN_COMMAND: the pid alone
// comes round again as some other process, and a run that was SIGKILLed would read as live
// for as long as that process lasts. Pure and importing nothing, so the mod (which cannot
// import the kit's source) and the kit's own tests can both read it; the process check is
// passed in. status.sh keeps its own bash version of the same rule (`test/run-live-contract.test.ts`
// holds the two together). Terms are GLOSSARY.md's.

/** What the run's process shows in its command line (bin/sandcastle starts it): how a look tells it from a process that got its pid later. */
export const RUN_COMMAND = "src/cli.ts";

/**
 * The process check: the command line of the process with this pid, or undefined when there is
 * none. A process another user owns exists all the same (EPERM on a signal says so): the probe
 * reads its command line like any other, as `ps -p <pid> -o command=` does.
 */
export type Probe = (pid: number) => string | undefined;

/** The pid is a process of the kit, not one that has since taken the number. */
export const isKit = (command: string | undefined): boolean => command !== undefined && command.includes(RUN_COMMAND);

/** The pid names a process of the kit that is running now. */
export const kitRunning = (pid: number | undefined, probe: Probe): boolean => Number.isInteger(pid) && (pid as number) > 0 && isKit(probe(pid as number));

/** The fields of a run record that decide it; the rest of the record is not read. */
export type LiveRecord = { pid?: unknown; finishedAt?: unknown; exitCode?: unknown };

/**
 * What a run is:
 * - `live`: its process is running (the pid it holds the run lock under, or the one its
 *   unfinished record names);
 * - `finished`: its record says it ended, with the exit code it wrote (none for a run that was
 *   not given one);
 * - `own`: its record is unfinished and names the asking process itself - the run that is
 *   summing itself up, between its own turns, which is not "another live run" and not a killed
 *   one either;
 * - `dead`: no record, or an unfinished one whose process is gone or is not the kit's: killed.
 */
export type Liveness = { state: "live"; pid: number } | { state: "finished"; exitCode?: number } | { state: "own" } | { state: "dead" };

const finished = (record: LiveRecord) => (typeof record.finishedAt === "string" && record.finishedAt !== "") || Number.isInteger(record.exitCode);

/**
 * The lock goes before the process does (its exit handlers run in turn, and the record's end is
 * written after the lock is released), so the lock's pid decides first: a process that still
 * holds it is live whatever the record says, and a record that has not finished is live while its
 * own pid is.
 */
export const liveness = ({ record, lockPid, self }: { record?: LiveRecord; lockPid?: number; self?: number }, probe: Probe): Liveness => {
  if (kitRunning(lockPid, probe)) return { state: "live", pid: lockPid as number };
  if (!record) return { state: "dead" };
  if (finished(record)) return { state: "finished", ...(Number.isInteger(record.exitCode) ? { exitCode: record.exitCode as number } : {}) };
  const pid = record.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { state: "dead" };
  if (pid === self) return { state: "own" };
  return kitRunning(pid, probe) ? { state: "live", pid } : { state: "dead" };
};
