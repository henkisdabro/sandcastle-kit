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

/** What `sandcastle --version --json` prints (src/upgrading.ts's `versionFacts`), the part the mark reads. */
export type VersionFacts = {
  kit: { version: string; release: string; past: number };
  /** The newest release tagged on the kit's remote and when the kit read it (ISO 8601); null when it is not known: the check is off, failed or found none. */
  newestRelease: { release: string; checkedAt: string } | null;
  /** Null outside a set-up project. */
  project: { recorded: boolean; release: string | null; pendingNotes: string[] } | null;
};

/**
 * A project's cached version read, one `$.store` entry beside the ready entry and shared by every
 * session on the machine. A failed read keeps the last good `facts` and `at`, as the ready entry does.
 */
export type VersionEntry = {
  /** When `facts` were read, in ms since the epoch. */
  at: number;
  /** The facts of the last good read; null before one. */
  facts: VersionFacts | null;
  /** Whether the latest read worked. */
  ok: boolean;
  /** When the latest read ended, good or not: what `due` measures. */
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
  /**
   * `/sandcastle-mark dismiss`: the newest release tagged on the remote at that moment, when it was newer than the kit's
   * own; absent when no release is dismissed. Kept apart from `dismissed`, so ending one leaves the other as it was.
   */
  dismissedRelease?: string;
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
  /** The release of a dismissal (`/sandcastle-mark dismiss`); `N out` stays quiet until a release newer than it is tagged. */
  dismissedRelease?: string;
  /** The cached read; none yet, or with no `now`, gives the bare mark. */
  entry?: Entry;
  /** The cached version read; none yet, or too old to show, and the mark carries no version. */
  versionRead?: VersionEntry;
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
 * Whether a release dismissal has ended: the newest release the facts name is newer than the dismissed one.
 * Facts that name none say nothing either way, as a count too old to show does for a ready dismissal.
 */
export const releaseDismissalEnded = (dismissedRelease: string, facts: VersionFacts | null): boolean => {
  const out = facts?.newestRelease?.release;
  return out !== undefined && newer(out, dismissedRelease);
};

/** The dismissed release while its dismissal holds, else undefined: what the report and the `dismiss` reply name. */
export const heldRelease = (input: Pick<MarkInput, "dismissedRelease" | "versionRead" | "now">): string | undefined =>
  input.dismissedRelease !== undefined && !releaseDismissalEnded(input.dismissedRelease, currentFacts(input.versionRead, input.now)) ? input.dismissedRelease : undefined;

/** A tone of the mark's line: `name` the row's sand, `hint` the castle's bright sand in bold. */
export type Tone = "name" | "hint";

/** One coloured piece of the line. The pieces are drawn side by side with a space between them. */
export type MarkPart = { text: string; tone: Tone };

/** The idle mark's line: its coloured parts and the same line as plain text (the parts joined by a space). */
export type Mark = { text: string; parts: MarkPart[] };

const numbers = (release: string): number[] | undefined => (/^\d+\.\d+\.\d+$/.test(release) ? release.split(".").map(Number) : undefined);

/** Whether release `a` is newer than `b`, part by part as numbers (`0.10.0` is newer than `0.9.0`); false for anything that is not `X.Y.Z`. */
const newer = (a: string, b: string): boolean => {
  const [x, y] = [numbers(a), numbers(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

/** The facts of a read that is current - under `COUNT_MS` old - else none: what a version may be shown from. */
const currentFacts = (read: VersionEntry | undefined, now: number | undefined): VersionFacts | null =>
  read !== undefined && now !== undefined && now - read.at >= 0 && now - read.at < COUNT_MS ? read.facts : null;

/** The kit's release, with `+N` when the clone is N commits past its release's own tag: `0.16.0+3`. */
const releaseLabel = (kit: VersionFacts["kit"]): string => `${kit.release}${kit.past > 0 ? `+${kit.past}` : ""}`;

/**
 * The line, or undefined to clear it. A count shows only while the last good read is under an
 * hour old, so a tracker that cannot be reached keeps the number for a while and then goes quiet;
 * the line never says why (`sandcastle queue` and the status view do). A dismissal takes the
 * count off, never the mark; hiding takes both.
 *
 * With version facts the name carries the kit's release, and one hint may follow the count, the
 * first of these that holds (bold, the call to action becomes `/sandcastle update`): `N out` when
 * the newest release tagged on the kit's remote is newer than the kit's own release, else
 * `update needed` when the project has Upgrading notes it has not had or no usable update record.
 * A dismissed release (`dismissedRelease`) quiets `N out` until a newer one is tagged, and the
 * line then falls to `update needed` as if no release were out: that hint has no dismissal.
 * A project that is current says nothing: its recorded release is for the report.
 */
export const markText = (input: MarkInput): Mark | undefined => {
  if (!input.setUp || !input.idleMark || input.hidden) return undefined;
  const { entry, now, dismissed } = input;
  const ids = current(entry, now);
  const quiet = dismissed !== undefined && !dismissalEnded(dismissed, entry, now);
  const count = ids.length > 0 && !quiet ? ids.length : 0;
  const facts = currentFacts(input.versionRead, now);
  const lead = `${facts ? `sandcastle ${releaseLabel(facts.kit)}` : "sandcastle"}${count ? ` · ${count} ready` : ""}`;
  const project = facts?.project;
  const parts: MarkPart[] = [];
  const out = facts?.newestRelease?.release;
  const outQuiet = out !== undefined && input.dismissedRelease !== undefined && !newer(out, input.dismissedRelease);
  if (facts && out && !outQuiet && newer(out, facts.kit.release)) {
    parts.push({ text: `${lead} ·`, tone: "name" }, { text: `${out} out`, tone: "hint" }, { text: "- /sandcastle update", tone: "name" });
  } else if (project && (!project.recorded || project.pendingNotes.length > 0)) {
    parts.push({ text: `${lead} ·`, tone: "name" }, { text: "update needed", tone: "hint" }, { text: "- /sandcastle update", tone: "name" });
  } else parts.push({ text: count ? `${lead} - /sandcastle run` : lead, tone: "name" });
  return { text: parts.map((p) => p.text).join(" "), parts };
};

/** What `/sandcastle-mark` takes. */
export const MARK_USAGE = "Usage: /sandcastle-mark [dismiss|hide|show]";

/** The command's argument, or undefined for one it does not know. Nothing is "no argument": the report. */
export const markAction = (args: string): "dismiss" | "hide" | "show" | "report" | undefined => {
  const word = args.trim().toLowerCase();
  return word === "" ? "report" : word === "dismiss" || word === "hide" || word === "show" ? word : undefined;
};

/** The release a dismissal would quiet: the newest one on the remote, when the facts are current and it is newer than the kit's own. */
const releaseOut = (read: VersionEntry | undefined, now: number | undefined): string | undefined => {
  const facts = currentFacts(read, now);
  const out = facts?.newestRelease?.release;
  return facts && out !== undefined && newer(out, facts.kit.release) ? out : undefined;
};

/**
 * The choice after `dismiss`, `hide` or `show`: the dismissal holds the ids of a count that is current, none otherwise,
 * and the release `N out` names when there is one (else an earlier dismissed release stays). `show` clears both.
 */
export const choiceAfter = (
  action: "dismiss" | "hide" | "show",
  choice: Choice,
  entry: Entry | undefined,
  now: number | undefined,
  versionRead?: VersionEntry,
): Choice => {
  if (action === "show") return { hidden: false };
  if (action === "hide") return { ...choice, hidden: true };
  const dismissedRelease = releaseOut(versionRead, now) ?? choice.dismissedRelease;
  return { ...choice, dismissed: [...current(entry, now)], ...(dismissedRelease !== undefined ? { dismissedRelease } : {}) };
};

/** A stored value as a choice, or undefined when it is not one (the store is shared, so it is checked). */
export const parseChoice = (value: unknown): Choice | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { hidden, dismissed, dismissedRelease } = value as Record<string, unknown>;
  if (typeof hidden !== "boolean") return undefined;
  if (dismissed !== undefined && (!Array.isArray(dismissed) || !dismissed.every((id) => typeof id === "string"))) return undefined;
  // A release the comparison cannot read would quiet `N out` for good, so it is no choice at all.
  if (dismissedRelease !== undefined && (typeof dismissedRelease !== "string" || !numbers(dismissedRelease))) return undefined;
  return {
    hidden,
    ...(dismissed !== undefined ? { dismissed: dismissed as string[] } : {}),
    ...(dismissedRelease !== undefined ? { dismissedRelease: dismissedRelease as string } : {}),
  };
};

const ago = (ms: number): string => {
  const min = Math.floor(Math.max(ms, 0) / 60000);
  return min < 1 ? "under a minute ago" : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
};

/** The reply to a bare `/sandcastle-mark`: whether the mark is shown, and the cached count with its age. */
export const markReport = (input: MarkInput): string => {
  const { entry, now } = input;
  const dismissed = input.dismissed !== undefined && !dismissalEnded(input.dismissed, entry, now);
  const release = heldRelease(input);
  const state = !input.setUp
    ? "not shown: this project is not set up (no .sandcastle/config.ts)"
    : !input.idleMark
      ? `hidden on this machine ("idleMark": false in the personal settings)${input.hidden ? " and in this project" : ""}`
      : input.hidden
        ? "hidden in this project (/sandcastle-mark show brings it back)"
        : dismissed || release
          ? `shown${dismissed ? " without a count" : ""}: ${[
              dismissed ? "dismissed until a new ticket becomes ready" : "",
              release ? `release ${release} dismissed until a newer one is tagged` : "",
            ]
              .filter(Boolean)
              .join(", and ")} (/sandcastle-mark show ends ${dismissed && release ? "both" : "it"})`
          : "shown";
  const count = !entry
    ? "No count read yet."
    : `${entry.ids.length} ready, read ${now === undefined ? "earlier" : ago(now - entry.at)}${entry.ok ? "" : " (the latest read failed)"}${shown(entry, now) ? "" : "; too old to show"}.`;
  return `Idle mark: ${state}.\nCached count: ${count}\n${versionReport(input.versionRead, now)}`;
};

/** The report's version lines: the last facts held, whatever their age, or that none are. */
const versionReport = (read: VersionEntry | undefined, now: number | undefined): string => {
  const facts = read?.facts;
  if (!read || !facts) return "Kit version: not read yet.";
  const { kit, project, newestRelease } = facts;
  const recorded = !project ? "this is not a set-up project" : !project.recorded ? "none (no usable update record on this machine)" : (project.release ?? "none named by the record");
  const notes = !project || project.pendingNotes.length === 0 ? [" none held."] : ["", ...project.pendingNotes.map((n) => `  - ${n}`)];
  return [
    `Kit version: ${kit.version}, read ${now === undefined ? "earlier" : ago(now - read.at)}${read.ok ? "" : " (the latest read failed)"}${currentFacts(read, now) ? "" : "; too old to show"}.`,
    `Project's recorded release: ${recorded}.`,
    `Pending Upgrading notes:${notes.join("\n")}`,
    `Newest release: ${newestRelease ? `${newestRelease.release}, checked ${now === undefined ? "earlier" : ago(now - Date.parse(newestRelease.checkedAt))}` : "not known (the check is off, the remote did not answer or it has no release tag)"}.`,
  ].join("\n");
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
export const due = (entry: Pick<Entry, "tried"> | undefined, now: number, trigger?: Trigger): boolean => {
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

/** The entry after a version read: `facts` is the read's result, or undefined for a failed one. */
export const afterVersionRead = (prior: VersionEntry | undefined, facts: VersionFacts | undefined, now: number): VersionEntry =>
  facts !== undefined ? { at: now, facts, ok: true, tried: now } : { at: prior?.at ?? now, facts: prior?.facts ?? null, ok: false, tried: now };

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * The facts in `sandcastle --version --json`'s stdout, or undefined for output that is not them -
 * a failed read keeps the last good facts, and one that parses to something else must not blank them.
 */
export const parseVersionFacts = (stdout: string): VersionFacts | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { kit, newestRelease, project } = value as Record<string, unknown>;
  if (typeof kit !== "object" || kit === null) return undefined;
  const { version, release, past } = kit as Record<string, unknown>;
  if (!nonEmpty(version) || !nonEmpty(release) || typeof past !== "number" || !Number.isFinite(past)) return undefined;
  let newest: VersionFacts["newestRelease"] = null;
  if (newestRelease !== null && newestRelease !== undefined) {
    if (typeof newestRelease !== "object") return undefined;
    const { release: r, checkedAt } = newestRelease as Record<string, unknown>;
    if (!nonEmpty(r) || !nonEmpty(checkedAt)) return undefined;
    newest = { release: r, checkedAt };
  }
  if (project === null) return { kit: { version, release, past }, newestRelease: newest, project: null };
  if (typeof project !== "object") return undefined;
  const { recorded, release: recordedRelease, pendingNotes } = project as Record<string, unknown>;
  if (typeof recorded !== "boolean" || (recordedRelease !== null && typeof recordedRelease !== "string")) return undefined;
  if (!Array.isArray(pendingNotes) || !pendingNotes.every((n) => typeof n === "string")) return undefined;
  return { kit: { version, release, past }, newestRelease: newest, project: { recorded, release: recordedRelease, pendingNotes: pendingNotes as string[] } };
};

/** A stored value as a version entry, or undefined when it is not one: a store is shared, so it is checked. */
export const parseVersionEntry = (value: unknown): VersionEntry | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { at, facts, ok, tried } = value as Record<string, unknown>;
  if (typeof at !== "number" || !Number.isFinite(at) || typeof tried !== "number" || !Number.isFinite(tried) || typeof ok !== "boolean") return undefined;
  if (facts === null) return { at, facts: null, ok, tried };
  const parsed = parseVersionFacts(JSON.stringify(facts));
  return parsed ? { at, facts: parsed, ok, tried } : undefined;
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
