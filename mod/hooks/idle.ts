// The idle mark: the one row the mod draws in sand above the prompt (not in the status line) between runs, in a
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

/**
 * A person's choices for one project, one `$.store` entry beside the ready entry: machine-local,
 * kept across a restart, never in the repository.
 */
export type Choice = {
  /** `/sandcastle-mark hide`: no mark in this project until `show`. */
  hidden: boolean;
  /** `/sandcastle-mark dismiss`: the ready ids at that moment; absent when nothing is dismissed. */
  dismissed?: string[];
};

/** What the line is decided from. */
export type MarkInput = {
  /** The project's `.sandcastle/config.ts` is a plain file: `sandcastle init` ran there. */
  setUp: boolean;
  /** The machine switch: false when the personal settings say `"idleMark": false`. */
  idleMark: boolean;
  /** The project's hidden flag (`/sandcastle-mark hide`). */
  hidden?: boolean;
  /** The ids of a dismissal (`/sandcastle-mark dismiss`); the count stays quiet while the ready set is within them. */
  dismissed?: string[];
  /** The cached read; none yet, or with no `now`, gives the bare mark. */
  entry?: Entry;
  /** The time, ms since the epoch. */
  now?: number;
};

/** A cached read is read again when it is this old. */
export const READ_MS = 10 * 60 * 1000;
/** A count older than this is not shown: the mark stands without one. */
export const COUNT_MS = 60 * 60 * 1000;

/** The ready ids of a read that is current - under `COUNT_MS` old - else none: what a count may be made of. */
const shown = (entry: Entry | undefined, now: number | undefined): entry is Entry => entry !== undefined && now !== undefined && now - entry.at >= 0 && now - entry.at < COUNT_MS;
const current = (entry: Entry | undefined, now: number | undefined): string[] => (shown(entry, now) ? entry.ids : []);

/**
 * Whether a dismissal has ended: the current ready set holds an id the dismissal does not. An id
 * leaving the set ends nothing, and a count too old to show says nothing either way.
 */
export const dismissalEnded = (dismissed: string[], entry: Entry | undefined, now: number | undefined): boolean =>
  current(entry, now).some((id) => !dismissed.includes(id));

/**
 * The line, or undefined to clear it. A count shows only while the last good read is under an
 * hour old, so a tracker that cannot be reached keeps the number for a while and then goes quiet;
 * the line never says why (`sandcastle queue` and the status view do). A dismissal takes the
 * count off, never the mark; hiding takes both.
 */
export const markText = (input: MarkInput): string | undefined => {
  if (!input.setUp || !input.idleMark || input.hidden) return undefined;
  const { entry, now, dismissed } = input;
  const ids = current(entry, now);
  const quiet = dismissed !== undefined && !dismissalEnded(dismissed, entry, now);
  return ids.length > 0 && !quiet ? `sandcastle · ${ids.length} ready - /sandcastle run` : "sandcastle";
};

/** What `/sandcastle-mark` takes. */
export const MARK_USAGE = "Usage: /sandcastle-mark [dismiss|hide|show]";

/** The command's argument, or undefined for one it does not know. Nothing is "no argument": the report. */
export const markAction = (args: string): "dismiss" | "hide" | "show" | "report" | undefined => {
  const word = args.trim().toLowerCase();
  return word === "" ? "report" : word === "dismiss" || word === "hide" || word === "show" ? word : undefined;
};

/** The choice after `dismiss`, `hide` or `show`: the dismissal holds the ids of a count that is current, none otherwise. */
export const choiceAfter = (action: "dismiss" | "hide" | "show", choice: Choice, entry: Entry | undefined, now: number | undefined): Choice =>
  action === "show" ? { hidden: false } : action === "hide" ? { ...choice, hidden: true } : { ...choice, dismissed: [...current(entry, now)] };

/** A stored value as a choice, or undefined when it is not one (the store is shared, so it is checked). */
export const parseChoice = (value: unknown): Choice | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { hidden, dismissed } = value as Record<string, unknown>;
  if (typeof hidden !== "boolean") return undefined;
  if (dismissed === undefined) return { hidden };
  if (!Array.isArray(dismissed) || !dismissed.every((id) => typeof id === "string")) return undefined;
  return { hidden, dismissed: dismissed as string[] };
};

const ago = (ms: number): string => {
  const min = Math.floor(Math.max(ms, 0) / 60000);
  return min < 1 ? "under a minute ago" : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
};

/** The reply to a bare `/sandcastle-mark`: whether the mark is shown, and the cached count with its age. */
export const markReport = (input: MarkInput): string => {
  const { entry, now } = input;
  const dismissed = input.dismissed !== undefined && !dismissalEnded(input.dismissed, entry, now);
  const state = !input.setUp
    ? "not shown: this project is not set up (no .sandcastle/config.ts)"
    : !input.idleMark
      ? `hidden on this machine ("idleMark": false in the personal settings)${input.hidden ? " and in this project" : ""}`
      : input.hidden
        ? "hidden in this project (/sandcastle-mark show brings it back)"
        : dismissed
          ? "shown without a count: dismissed until a new ticket becomes ready (/sandcastle-mark show ends it)"
          : "shown";
  const count = !entry
    ? "No count read yet."
    : `${entry.ids.length} ready, read ${now === undefined ? "earlier" : ago(now - entry.at)}${entry.ok ? "" : " (the latest read failed)"}${shown(entry, now) ? "" : "; too old to show"}.`;
  return `Idle mark: ${state}.\nCached count: ${count}`;
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
 * What makes a read due ahead of its age: a run ended - the project's own, or one this session
 * followed elsewhere, perhaps a second clone of it - or the sandcastle skill was used (it may just
 * have labelled tickets). A session's start needs none: its first look applies
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
