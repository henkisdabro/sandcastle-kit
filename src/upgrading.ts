// Whether the kit has moved past what this project was last brought up to date with. A `git pull`
// of the kit reaches every project that uses it at once, but each project's own steps (a rebuild,
// a new default to decide on, labels to move) wait for `/sandcastle update` in that project, and
// nobody is told to run it. So each project keeps an update record, on this machine only
// (`.sandcastle/.run/`, gitignored): the Upgrading notes it has acted on. Doctor and a run compare
// the kit's own notes with it. The notes themselves, not a kit commit: a commit was unreadable in a
// shallow clone, a kit outside git or another clone of the kit, and the project then heard nothing
// or "no record".

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KIT } from "./sandbox.ts";

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
 * counted from the release before and printed the wrong distance.
 */
export const kitVersion = (kit = KIT): string => {
  const release = kitRelease(kit);
  // A kit that is not the top of its own checkout (unpacked or installed inside another repository) would report that repository's commit.
  if (git(kit, ["rev-parse", "--show-cdup"]) !== "") return release;
  const head = git(kit, ["rev-parse", "--short", "HEAD"]);
  const tag = git(kit, ["rev-parse", "-q", "--verify", `refs/tags/v${release}^{commit}`]);
  const past = tag ? Number(git(kit, ["rev-list", "--count", `${tag}..HEAD`])) : undefined;
  const changed = !!git(kit, ["status", "--porcelain", "--untracked-files=no"]);
  if (past === 0 && !changed) return release;
  return `${release}${past ? ` +${past}` : ""} (${head}${changed ? ", local changes" : ""})`;
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
const readRecord = (root: string, kit: string): { version?: string; notes: string[] } | undefined => {
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
  return then === undefined ? undefined : { notes: upgradingNotes(then) };
};

const kitNotes = (kit: string) => upgradingNotes(readFileSync(join(kit, "CHANGELOG.md"), "utf8"));

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

/** Records every Upgrading note in the kit as acted on by this project. Returns the kit version. */
export const markUpdated = (root: string, kit = KIT): string => {
  mkdirSync(dirname(updateRecord(root)), { recursive: true });
  writeFileSync(updateRecord(root), `${JSON.stringify({ version: kitRelease(kit), notes: kitNotes(kit) }, null, 2)}\n`);
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
