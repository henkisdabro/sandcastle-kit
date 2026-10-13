// Whether the kit has moved past what this project was last brought up to date with. A `git pull`
// of the kit reaches every project that uses it at once, but each project's own steps (a rebuild,
// a new default to decide on, labels to move) wait for `/sandcastle update` in that project, and
// nobody is told to run it. So each project keeps an update record, on this machine only
// (`.sandcastle/.run/`, gitignored): the Upgrading notes it has acted on. Doctor and a run compare
// the kit's own notes with it. The notes themselves, not a kit commit: a commit was unreadable in a
// shallow clone, a kit outside git or another clone of the kit, and the project then heard nothing
// or "no record".

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KIT_CACHE } from "./live-runs.ts";
import { KIT, machineSettings } from "./sandbox.ts";

const updateRecord = (root: string) => join(root, ".sandcastle/.run/kit-updated");

const git = (kit: string, args: string[]) => {
  const r = spawnSync("git", ["-C", kit, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** The release in the kit's package.json. */
export const kitRelease = (kit = KIT): string => JSON.parse(readFileSync(join(kit, "package.json"), "utf8")).version;

/**
 * The kit version: the release, and in a clone that is not exactly at it, how far past it and at
 * which commit - `X.Y.Z`, `X.Y.Z +1 (1c4f46f)`, `X.Y.Z (1c4f46f, local changes)`. Counted from the
 * release's own tag, not the nearest one: between a version bump and its tag, `git describe`
 * counted from the release before and printed the wrong distance. Also the release and the commits
 * past its tag (0 when there is no tag to count from, as in a shallow clone), for `--version --json`.
 */
const kitFacts = (kit: string): { version: string; release: string; past: number } => {
  const release = kitRelease(kit);
  // A kit that is not the top of its own checkout (unpacked or installed inside another repository) would report that repository's commit.
  if (git(kit, ["rev-parse", "--show-cdup"]) !== "") return { version: release, release, past: 0 };
  const head = git(kit, ["rev-parse", "--short", "HEAD"]);
  const tag = git(kit, ["rev-parse", "-q", "--verify", `refs/tags/v${release}^{commit}`]);
  const past = tag ? Number(git(kit, ["rev-list", "--count", `${tag}..HEAD`])) : undefined;
  const changed = !!git(kit, ["status", "--porcelain", "--untracked-files=no"]);
  const counted = past !== undefined && Number.isFinite(past) ? past : 0;
  if (past === 0 && !changed) return { version: release, release, past: 0 };
  return { version: `${release}${past ? ` +${past}` : ""} (${head}${changed ? ", local changes" : ""})`, release, past: counted };
};

export const kitVersion = (kit = KIT): string => kitFacts(kit).version;

/** A good read of the kit's remote holds this long. */
export const NEWEST_FRESH_MS = 6 * 60 * 60 * 1000;
/** A failed read is not tried again sooner than this. */
export const NEWEST_RETRY_MS = 60 * 60 * 1000;
/** `git ls-remote` is killed at this. */
export const LS_REMOTE_MS = 10 * 1000;

/** The newest release as `sandcastle --version --json` carries it: the release and when it was read (ISO 8601). */
export type NewestRelease = { release: string; checkedAt: string };

/**
 * The highest exact `vX.Y.Z` tag in `git ls-remote --tags` output, as `X.Y.Z`, compared as numbers
 * (`v0.10.0` is above `v0.9.0`); null for none. A pre-release or any other tag is no release, and
 * an annotated tag's peeled line (`^{}`) names the same release as its tag.
 */
const highestRelease = (stdout: string): string | null => {
  let best: string | null = null;
  for (const line of stdout.split("\n")) {
    const release = line.split("\t")[1]?.match(/^refs\/tags\/v(\d+\.\d+\.\d+)(?:\^\{\})?$/)?.[1];
    if (release && (best === null || compareReleases(release, best) > 0)) best = release;
  }
  return best;
};

/**
 * The ssh a read uses: the one git would pick (`GIT_SSH_COMMAND`, else `core.sshCommand`, else
 * `GIT_SSH`, else `ssh`) with batch mode on, so a passphrase or host-key question fails the read and
 * never waits for a keyboard. `core.sshCommand` is read here because the variable set for the read
 * overrides it: a remote that needs its own key would never answer.
 */
const batchSsh = (kit: string, env: NodeJS.ProcessEnv): string =>
  `${env.GIT_SSH_COMMAND || git(kit, ["config", "core.sshCommand"]) || (env.GIT_SSH ? `'${env.GIT_SSH.replaceAll("'", "'\\''")}'` : "ssh")} -o BatchMode=yes`;

/**
 * `git ls-remote --tags origin` of the kit checkout: the output, or undefined for a failure. Never
 * a fetch (nothing is written to the checkout), never a prompt (`GIT_TERMINAL_PROMPT=0`, ssh in
 * batch mode) and killed at `LS_REMOTE_MS`. The output goes to a temp file, not a pipe: a remote
 * helper the kill leaves behind would hold a pipe open and keep this call waiting for it.
 */
const lsRemote = (kit: string): string | undefined => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-ls-remote-"));
  const out = join(dir, "out");
  const fd = openSync(out, "w");
  try {
    const r = spawnSync("git", ["-C", kit, "ls-remote", "--tags", "origin"], {
      stdio: ["ignore", fd, "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: batchSsh(kit, process.env) },
      timeout: LS_REMOTE_MS,
      killSignal: "SIGKILL",
    });
    return r.status === 0 && !r.error ? readFileSync(out, "utf8") : undefined;
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
};

type ReleaseCache = { at: number; ok: boolean; release: string | null };

/** The cache file of one kit directory and `origin` URL: a clone elsewhere, or a remote that moved, shares no answer. */
const releaseCache = (kit: string, origin: string): string => {
  let dir = kit;
  try {
    dir = realpathSync(kit);
  } catch {}
  return join(KIT_CACHE, "newest-release", `${createHash("sha256").update(JSON.stringify([dir, origin])).digest("hex").slice(0, 24)}.json`);
};

/** The cache's content, or undefined when the file is missing or is not one (an unparsable cache counts as none). */
const readReleaseCache = (file: string): ReleaseCache | undefined => {
  try {
    const { at, ok, release } = JSON.parse(readFileSync(file, "utf8"));
    if (typeof at !== "number" || !Number.isFinite(at) || typeof ok !== "boolean") return undefined;
    if (release !== null && !(typeof release === "string" && /^\d+\.\d+\.\d+$/.test(release))) return undefined;
    return { at, ok, release };
  } catch {
    return undefined;
  }
};

const named = (c: ReleaseCache): NewestRelease | null => (c.ok && c.release ? { release: c.release, checkedAt: new Date(c.at).toISOString() } : null);

/**
 * The newest tagged release of the kit, from `git ls-remote --tags` on the checkout's `origin`, or
 * null when it is not known: the check is off (`"updateCheck": false` in the personal settings), the
 * kit is not the top of its own checkout, the remote did not answer, or it has no release tag.
 * Cached machine-wide (`releaseCache`): a good read holds six hours, a failure is retried after an
 * hour and never sooner, and a failure gives null - never the last good value, which may be a
 * release the remote no longer shows. `now` is the clock, for a test.
 */
export const newestRelease = (kit = KIT, now = Date.now()): NewestRelease | null => {
  try {
    if (machineSettings().updateCheck === false) return null;
  } catch {
    // A settings file that cannot be read is doctor's to report; it does not stop `--version`.
  }
  if (git(kit, ["rev-parse", "--show-cdup"]) !== "") return null;
  // `--get-url` applies `url.<base>.insteadOf` and prints a bare `origin` when there is no such remote: read nothing from that.
  const origin = git(kit, ["ls-remote", "--get-url", "origin"]);
  if (!origin || origin === "origin") return null;
  const file = releaseCache(kit, origin);
  const cached = readReleaseCache(file);
  // A cache from the future is a clock that moved: read again rather than trust it.
  if (cached && now - cached.at >= 0 && now - cached.at < (cached.ok ? NEWEST_FRESH_MS : NEWEST_RETRY_MS)) return named(cached);
  const stdout = lsRemote(kit);
  const read: ReleaseCache = { at: now, ok: stdout !== undefined, release: stdout === undefined ? null : highestRelease(stdout) };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(read));
    renameSync(tmp, file);
  } catch {
    // An unwritable cache costs a read at the next look, never the answer.
  }
  return named(read);
};

/** The newest release when it is newer than the kit's own release (a clone past its tag included), else undefined. */
export const releaseOut = (newest: NewestRelease | null, release: string): string | undefined =>
  newest && compareReleases(newest.release, release) > 0 ? newest.release : undefined;

/**
 * What `sandcastle --version --json` prints, for the Claude Code mod's idle mark: the kit version,
 * the newest tagged release (null: not known, see `newestRelease`), and the project's update state.
 * `project` is null when `root` is not a set-up project (no `.sandcastle/config.ts` plain file at
 * the git root); `recorded` is false when there is no usable update record, and `release` null when
 * a usable record names none.
 */
export const versionFacts = (root: string | undefined, kit = KIT, newest: NewestRelease | null = newestRelease(kit)) => {
  const setUp = root !== undefined && statSync(join(root, ".sandcastle/config.ts"), { throwIfNoEntry: false })?.isFile() === true;
  if (!setUp) return { kit: kitFacts(kit), newestRelease: newest, project: null };
  const pending = pendingUpgrades(root, kit);
  const release = pending.recorded ? (recordedRelease(root, kit) ?? null) : null;
  return { kit: kitFacts(kit), newestRelease: newest, project: { recorded: pending.recorded, release, pendingNotes: pending.notes } };
};

/** Each bullet under a `### Upgrading` heading, by its bold lead (else its first line). */
export const upgradingNotes = (changelog: string): string[] => {
  const notes: string[] = [];
  let inside = false;
  for (const line of changelog.split("\n")) {
    if (line.startsWith("## ") || line.startsWith("### ")) inside = line.trim() === "### Upgrading";
    else if (inside && line.startsWith("- ")) notes.push(line.match(/^- \*\*(.+?)\*\*/)?.[1] ?? line.slice(2).trim());
  }
  return notes;
};

/**
 * The update record: the release it was written at and the notes acted on. An older record holds
 * the kit commit instead; its notes are read from the changelog there while git still has it.
 * Read, never rewritten: doctor changes nothing, and the next `sandcastle updated` writes the new form.
 */
const readRecord = (root: string, kit: string): { version?: string; commit?: string; notes: string[] } | undefined => {
  if (!existsSync(updateRecord(root))) return undefined;
  const text = readFileSync(updateRecord(root), "utf8").trim();
  if (text.startsWith("{")) {
    try {
      const r = JSON.parse(text);
      if (Array.isArray(r.notes)) return { version: typeof r.version === "string" ? r.version : undefined, notes: r.notes };
    } catch {}
    return undefined;
  }
  const then = text ? git(kit, ["show", `${text}:CHANGELOG.md`]) : undefined;
  return then === undefined ? undefined : { commit: text, notes: upgradingNotes(then) };
};

const kitNotes = (kit: string) => upgradingNotes(readFileSync(join(kit, "CHANGELOG.md"), "utf8"));

/**
 * The release this project last updated at, from its update record (an older record's, from the
 * kit's package.json at its commit); undefined when there is no record or it names no release. What
 * `/sandcastle update` reports as "this project: <release> -> <kit now>": the kit's own pre-pull
 * version is no use there, since another session may have pulled the kit already.
 */
export const recordedRelease = (root: string, kit = KIT): string | undefined => {
  const record = readRecord(root, kit);
  // A project last updated before records named their release would otherwise read as never updated.
  if (record?.version || !record?.commit) return record?.version;
  try {
    const version = JSON.parse(git(kit, ["show", `${record.commit}:package.json`]) ?? "").version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
};

/** What `sandcastle updated` prints: the earlier recorded release (or that there was none) and the kit version now. Call before `markUpdated`, which replaces the record. */
export const updatedLine = (before: string | undefined, now: string): string =>
  `Recorded: this project is up to date with sandcastle-kit ${now} (this project: ${before ?? "no earlier record"} -> ${now}).`;

/**
 * The Upgrading notes this project has not had: those in the kit's changelog and not in its update
 * record. A note is told by its text, so one moved from Unreleased into a release is not new again.
 * `recorded: false` when there is no record, or an older one whose commit this kit cannot read.
 */
export const pendingUpgrades = (root: string, kit = KIT): { recorded: boolean; since?: string; notes: string[] } => {
  const now = kitNotes(kit);
  const record = readRecord(root, kit);
  if (!record) return { recorded: false, notes: now };
  const had = new Set(record.notes);
  return { recorded: true, since: record.version, notes: now.filter((n) => !had.has(n)) };
};

/**
 * The update steps the user declined, each as the release it was declined at. A proposal the user
 * turns down changes nothing in the project, so its check would find the same thing at every update;
 * this is what the update action reads to name it in a line instead of asking again. Empty for no
 * record, the older plain form (a kit commit) or a record without the field.
 */
export const declinedSteps = (root: string): Record<string, string> => {
  if (!existsSync(updateRecord(root))) return {};
  const text = readFileSync(updateRecord(root), "utf8").trim();
  if (!text.startsWith("{")) return {};
  try {
    const declined = JSON.parse(text).declined;
    if (declined === null || typeof declined !== "object" || Array.isArray(declined)) return {};
    return Object.fromEntries(Object.entries(declined).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
};

/**
 * Records every Upgrading note in the kit as acted on by this project, keeps the steps declined
 * before and adds `declined` at this release (a step declined again moves to it); `accepted` takes
 * steps off the declined list. Returns the kit version.
 */
export const markUpdated = (root: string, kit = KIT, declined: string[] = [], accepted: string[] = []): string => {
  const release = kitRelease(kit);
  const steps = { ...declinedSteps(root), ...Object.fromEntries(declined.map((key) => [key, release])) };
  // A step declined at an earlier release that the user has now asked for is no longer declined.
  for (const key of accepted) delete steps[key];
  mkdirSync(dirname(updateRecord(root)), { recursive: true });
  const record = { version: release, notes: kitNotes(kit), ...(Object.keys(steps).length ? { declined: steps } : {}) };
  writeFileSync(updateRecord(root), `${JSON.stringify(record, null, 2)}\n`);
  return kitVersion(kit);
};

/** What doctor and a run print about it: nothing when the project is up to date. */
export const upgradeLines = (root: string, kit = KIT, full = true): string[] => {
  const p = pendingUpgrades(root, kit);
  if (p.recorded && !p.notes.length) return [];
  const fix = "`/sandcastle update` in this project acts on them and records it (by hand: the kit's skill/update.md, then `sandcastle updated`)";
  if (!p.recorded) {
    return [`warn This project has no record of a kit update on this machine, so the kit's upgrading notes may not have been acted on.\n       -> ${fix}`];
  }
  const head = `warn The kit has ${p.notes.length} upgrading note(s) this project has not had since its last update${p.since ? ` (at ${p.since})` : ""}`;
  if (!full) return [`${head}: \`sandcastle doctor\` lists them, ${fix}.`];
  return [`${head}:`, ...p.notes.map((n) => `       - ${n}`), `       -> ${fix}`];
};

const SECTIONS = ["Added", "Changed", "Security", "Fixed", "Upgrading"];

const releaseParts = (v: string) => v.replace(/^v/, "").split(".").map(Number);
/** Negative when release `a` is older than `b`; both `X.Y.Z`. */
const compareReleases = (a: string, b: string) => {
  const [x, y] = [releaseParts(a), releaseParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** A bullet shortened to its bold lead, else its whole first sentence (a bullet runs over several lines). */
const shorten = (bullet: string): string => {
  const text = bullet.replace(/\s+/g, " ").trim();
  return text.match(/^\*\*(.+?)\*\*/)?.[1] ?? text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
};

/** Each release of a changelog, newest first as written: its section names and their shortened bullets. */
export const releaseEntries = (changelog: string): { release: string; date?: string; sections: Map<string, string[]> }[] => {
  const releases: { release: string; date?: string; sections: Map<string, string[]> }[] = [];
  let sections: Map<string, string[]> | undefined;
  let entries: string[] | undefined;
  let bullet: string | undefined;
  const flush = () => {
    if (bullet !== undefined) entries?.push(shorten(bullet));
    bullet = undefined;
  };
  for (const line of changelog.split("\n")) {
    if (line.startsWith("## ") || line.startsWith("### ")) {
      flush();
      if (line.startsWith("## ")) {
        const m = line.match(/^## \[(\d+\.\d+\.\d+)\](?: - (\S+))?/);
        sections = m ? new Map() : undefined;
        if (m && sections) releases.push({ release: m[1]!, date: m[2], sections });
        entries = undefined;
      } else if (sections) {
        entries = [];
        sections.set(line.slice(4).trim(), entries);
      }
    } else if (entries && line.startsWith("- ")) {
      flush();
      bullet = line.slice(2);
    } else if (bullet !== undefined && /^\s+\S/.test(line)) bullet += ` ${line.trim()}`;
    else if (!line.trim()) flush();
  }
  flush();
  return releases;
};

/**
 * `sandcastle changes`: the changelog entries of every release after `since` (default: the project's
 * recorded release) up to the kit's current one, `[Unreleased]` left out, per release grouped by
 * section. With no record and no `since`, the current release's entries and a line saying so.
 */
export const changesLines = (root: string, kit = KIT, since?: string): string[] => {
  const now = kitRelease(kit);
  const from = since ?? readRecord(root, kit)?.version;
  const all = releaseEntries(readFileSync(join(kit, "CHANGELOG.md"), "utf8")).filter((r) => compareReleases(r.release, now) <= 0);
  const shown = from === undefined ? all.filter((r) => r.release === now) : all.filter((r) => compareReleases(r.release, from) > 0);
  const lines: string[] = [];
  if (from === undefined) lines.push(`This project has no record of a kit update on this machine, so there is no release to count from. The entries of the current release (${now}) follow; \`sandcastle changes --since <release>\` shows the ones after an earlier release.`);
  else if (!shown.length) return [`Nothing new: the kit is at ${now}, and ${since ? `${from} was asked for` : `this project's last update was at ${from}`}.`];
  else lines.push(`Changes since ${from}${since ? "" : " (this project's last recorded update)"}, up to ${now}:`);
  for (const r of shown) {
    lines.push("", `## ${r.release}${r.date ? ` - ${r.date}` : ""}`);
    const names = [...SECTIONS.filter((s) => r.sections.get(s)?.length), ...[...r.sections.keys()].filter((s) => !SECTIONS.includes(s) && r.sections.get(s)?.length)];
    if (!names.length) lines.push("", "(no entries)");
    for (const name of names) lines.push("", `### ${name}`, ...r.sections.get(name)!.map((e) => `- ${e}`));
  }
  return lines;
};

const showAt = (kit: string, tag: string, file: string): string | undefined => {
  const r = spawnSync("git", ["-C", kit, "show", `${tag}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 25 });
  return r.status === 0 ? r.stdout : undefined;
};

const tagExists = (kit: string, tag: string) => git(kit, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]) !== undefined;

/** A table row's cells; a `\|` inside a cell stays in it. */
const cells = (row: string) =>
  row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").replace(/\s+/g, " ").trim());

type Surface = { config: Map<string, string>; personal: Map<string, string>; env: Map<string, string>; commands: Map<string, Set<string>> };

/**
 * The README Configuration section's tables, by their first header cell: `Field` (project config
 * keys), `Key` (personal settings) and `Variable` (environment variables), each name -> its default.
 * A row naming several (`` `a` / `b` ``, `` `A`, `B` ``) gives each its own entry, with the same default.
 */
const readmeTables = (readme: string): Pick<Surface, "config" | "personal" | "env"> => {
  const out = { config: new Map<string, string>(), personal: new Map<string, string>(), env: new Map<string, string>() };
  let inside = false;
  let into: Map<string, string> | undefined;
  for (const line of readme.split("\n")) {
    if (line.startsWith("## ")) inside = /^## .*Configuration\s*$/.test(line);
    if (!inside || !line.trimStart().startsWith("|")) {
      into = undefined;
      continue;
    }
    const row = cells(line);
    if (/^-+$/.test(row[0]!.replace(/[:\s]/g, "")) || !row[0]) continue;
    if (row[0] === "Field") into = out.config;
    else if (row[0] === "Key") into = out.personal;
    else if (row[0] === "Variable") into = out.env;
    else if (into) {
      // `NAME=value` and `a`, `b` or `c` name one variable with its values: only a name in capitals is one.
      for (const m of row[0].matchAll(/`([^`]+)`/g)) {
        const name = into === out.env ? m[1]!.replace(/=.*$/, "") : m[1]!;
        if (into !== out.env || /^[A-Z][A-Z0-9_]*$/.test(name)) into.set(name, row[1] ?? "");
      }
    }
  }
  return out;
};

/** The help text's commands (the header comment of `src/cli.ts`), each with the `--flags` its entry names. */
const helpCommands = (cli: string): Map<string, Set<string>> => {
  const commands = new Map<string, Set<string>>();
  let current: Set<string> | undefined;
  for (const line of cli.split("\n")) {
    if (!line.startsWith("//")) break;
    const entry = line.match(/^\/\/ {3}([a-z][a-z-]*)(?:\s|$)/);
    if (entry) commands.set(entry[1]!, (current = new Set()));
    else if (!/^\/\/ {4,}\S/.test(line)) current = undefined;
    if (current) for (const f of line.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) current.add(f[0]);
  }
  return commands;
};

const surfaceAt = (kit: string, tag: string): Surface => ({
  ...readmeTables(showAt(kit, tag, "README.md") ?? ""),
  commands: helpCommands(showAt(kit, tag, "src/cli.ts") ?? ""),
});

const compareMaps = (was: Map<string, string>, now: Map<string, string>): string[] => [
  ...[...now].filter(([k]) => !was.has(k)).map(([k, v]) => `- added \`${k}\` (default: ${v || "none"})`),
  ...[...now].filter(([k, v]) => was.has(k) && was.get(k) !== v).map(([k, v]) => `- changed \`${k}\` default: ${was.get(k) || "none"} -> ${v || "none"}`),
  ...[...was.keys()].filter((k) => !now.has(k)).map((k) => `- removed \`${k}\``),
];

/**
 * `sandcastle changes`, second part: what the changelog's prose can bury. Between the git tags of the
 * release counted from and the kit's own, the README Configuration section's config keys, personal
 * settings and environment variables (added, removed, default changed) and the help text's commands
 * and flags. Nothing when there is no release to count from or nothing new. A missing tag (a shallow
 * clone, a kit outside git) is said, and the changelog part stands alone.
 */
export const changesDiffLines = (root: string, kit = KIT, since?: string): string[] => {
  const now = kitRelease(kit);
  const from = (since ?? readRecord(root, kit)?.version)?.replace(/^v/, "");
  if (from === undefined || compareReleases(from, now) >= 0) return [];
  const missing = [`v${from}`, `v${now}`].filter((t) => !tagExists(kit, t));
  const head = `## Settings and flags, ${from} -> ${now}`;
  if (missing.length) {
    return [head, "", `Not compared: this kit checkout has no git tag ${missing.join(" or ")} (a shallow clone has none; \`git fetch --tags\` in the kit fetches them). Only the changelog above is shown.`];
  }
  const [was, is] = [surfaceAt(kit, `v${from}`), surfaceAt(kit, `v${now}`)];
  const groups: [string, string[]][] = [
    ["Config keys", compareMaps(was.config, is.config)],
    ["Personal settings", compareMaps(was.personal, is.personal)],
    ["Environment variables", compareMaps(was.env, is.env)],
    ["Commands and flags", [
      ...[...is.commands].filter(([c]) => !was.commands.has(c)).map(([c, f]) => `- added command \`${c}\`${f.size ? ` (${[...f].join(", ")})` : ""}`),
      ...[...is.commands].filter(([c]) => was.commands.has(c)).flatMap(([c, f]) => {
        const old = was.commands.get(c)!;
        const [add, del] = [[...f].filter((x) => !old.has(x)), [...old].filter((x) => !f.has(x))];
        return add.length || del.length ? [`- \`${c}\`:${add.length ? ` added ${add.join(", ")}` : ""}${add.length && del.length ? ";" : ""}${del.length ? ` removed ${del.join(", ")}` : ""}`] : [];
      }),
      ...[...was.commands.keys()].filter((c) => !is.commands.has(c)).map((c) => `- removed command \`${c}\``),
    ]],
  ];
  const shown = groups.filter(([, l]) => l.length);
  if (!shown.length) return [head, "", "No config key, environment variable, command or flag was added, removed or changed."];
  return [head, ...shown.flatMap(([name, l]) => ["", `### ${name}`, ...l])];
};
