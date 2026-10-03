// The idle mark: the one line the mod pins in the status line under the prompt between runs, in a
// project set up for sandcastle. Pure, and like run-state.ts it imports nothing: register.tsx
// gathers the facts and this module decides the text. The input is one object on purpose - the
// ready count, the project's hidden flag and a dismissal join it without a new signature.

/** A project's cached ready-ticket read, one `$.store` entry shared by every session on the machine. */
export type Entry = {
  /** When `ids` were read, in ms since the epoch: the age of the count, kept through failed reads. */
  at: number;
  /** The ready ticket ids of the last good read. */
  ids: string[];
  /** Whether the latest read worked; a failure keeps `ids` and `at` and says so here. */
  ok: boolean;
  /**
   * When the latest read ended, good or not: what `due` measures. Apart from `at` so that a
   * tracker that cannot be reached is tried every ten minutes, not at every look.
   */
  tried: number;
};

/** What the line is decided from. */
export type MarkInput = {
  /** The project's `.sandcastle/config.ts` is a plain file: `sandcastle init` ran there. */
  setUp: boolean;
  /** The machine switch: false when the personal settings say `"idleMark": false`. */
  idleMark: boolean;
  /** The cached read; none yet, or with no `now`, gives the bare mark. */
  entry?: Entry;
  /** The time, ms since the epoch. */
  now?: number;
};

/** A cached read is read again when it is this old. */
export const READ_MS = 10 * 60 * 1000;
/** A count older than this is not shown: the mark stands without one. */
export const COUNT_MS = 60 * 60 * 1000;

/**
 * The line, or undefined to clear it. A count shows only while the last good read is under an
 * hour old, so a tracker that cannot be reached keeps the number for a while and then goes quiet;
 * the line never says why (`sandcastle queue` and the status view do).
 */
export const markText = (input: MarkInput): string | undefined => {
  if (!input.setUp || !input.idleMark) return undefined;
  const { entry, now } = input;
  const age = entry && now !== undefined ? now - entry.at : undefined;
  const count = age !== undefined && age >= 0 && age < COUNT_MS ? entry!.ids.length : 0;
  return count > 0 ? `sandcastle · ${count} ready - /sandcastle run` : "sandcastle";
};

/**
 * The ready ticket ids in `sandcastle queue --json`'s stdout - the queued tickets with no open
 * blocker - or undefined for a read that is no list of tickets. Never an empty list for output
 * that is not one: a failed read must not count as "nothing ready".
 */
export const readyIds = (stdout: string): string[] | undefined => {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
    const { id, blockedOn } = row as Record<string, unknown>;
    if ((typeof id !== "string" && typeof id !== "number") || String(id) === "" || !Array.isArray(blockedOn)) return undefined;
    if (blockedOn.length === 0 && !ids.includes(String(id))) ids.push(String(id));
  }
  return ids;
};

/**
 * What makes a read due ahead of its age: a run of the project ended, or the sandcastle skill was
 * used (it may just have labelled tickets). A session's start needs none: its first look applies
 * the age rule at once, so an entry that is missing or old is read then.
 */
export type Trigger = "run-ended" | "skill";

/** Whether to read the tracker now: no entry, one `READ_MS` old or more, or a trigger fired. */
export const due = (entry: Entry | undefined, now: number, trigger?: Trigger): boolean => {
  if (trigger !== undefined || entry === undefined) return true;
  const age = now - entry.tried;
  // An entry from the future is a clock that moved: read it again rather than trust it.
  return age < 0 || age >= READ_MS;
};

/** The entry after a read: `ids` is the read's result, or undefined for a failed one. */
export const afterRead = (prior: Entry | undefined, ids: string[] | undefined, now: number): Entry =>
  ids !== undefined ? { at: now, ids, ok: true, tried: now } : { at: prior?.at ?? now, ids: prior?.ids ?? [], ok: false, tried: now };

/** A stored value as an entry, or undefined when it is not one: a store is shared, so it is checked. */
export const parseEntry = (value: unknown): Entry | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { at, ids, ok, tried } = value as Record<string, unknown>;
  if (typeof at !== "number" || !Number.isFinite(at) || typeof tried !== "number" || !Number.isFinite(tried) || typeof ok !== "boolean") return undefined;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
  return { at, ids: ids as string[], ok, tried };
};

/**
 * Prints the personal machine settings, honouring `XDG_CONFIG_HOME` as the kit's `USER_CONFIG`
 * does (src/sandbox.ts). `cat` only: BSD and GNU alike. A missing file prints nothing.
 */
export const SETTINGS_SCRIPT = ['cat -- "${XDG_CONFIG_HOME:-$HOME/.config}/sandcastle-kit/config.json" 2>/dev/null', "exit 0"].join("\n");

/**
 * The machine switch from the settings file's text. Off only for `"idleMark": false`: a file that
 * is not JSON, or any other value, leaves the mark on - `sandcastle doctor` is where those are
 * reported, and a typo never hides the mark silently the other way round.
 */
export const machineSwitch = (stdout: string): boolean => {
  try {
    const settings: unknown = JSON.parse(stdout);
    return !(typeof settings === "object" && settings !== null && !Array.isArray(settings) && (settings as Record<string, unknown>).idleMark === false);
  } catch {
    return true;
  }
};
