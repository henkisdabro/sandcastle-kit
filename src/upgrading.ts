// Whether the kit has moved past what this project was last brought up to date with. A `git pull`
// of the kit reaches every project that uses it at once, but each project's own steps (a rebuild,
// a new default to decide on, labels to move) wait for `/sandcastle update` in that project, and
// nobody is told to run it. So each project keeps the kit commit it was last updated to, on this
// machine only (`.sandcastle/.run/`, gitignored), and doctor and a run compare the changelog's
// Upgrading notes there with the kit's own.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KIT } from "./sandbox.ts";

const marker = (root: string) => join(root, ".sandcastle/.run/kit-updated");

const git = (kit: string, args: string[]) => {
  const r = spawnSync("git", ["-C", kit, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout : undefined;
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
 * The Upgrading notes this project has not had: those in the kit's changelog now and not in the
 * one at the recorded commit. A note is told by its text, so one moved from Unreleased into a
 * release is not new again. `recorded: false` when there is no record, or its commit is gone (a
 * fresh clone of the kit); undefined when the kit is not a git checkout and cannot say.
 */
export const pendingUpgrades = (root: string, kit = KIT): { recorded: boolean; notes: string[] } | undefined => {
  if (!git(kit, ["rev-parse", "HEAD"])) return undefined;
  const now = upgradingNotes(readFileSync(join(kit, "CHANGELOG.md"), "utf8"));
  const at = existsSync(marker(root)) ? readFileSync(marker(root), "utf8").trim() : "";
  const then = at ? git(kit, ["show", `${at}:CHANGELOG.md`]) : undefined;
  if (then === undefined) return { recorded: false, notes: now };
  const had = new Set(upgradingNotes(then));
  return { recorded: true, notes: now.filter((n) => !had.has(n)) };
};

/** Records the kit's commit as the one this project is up to date with. Returns it, or undefined outside a git checkout. */
export const markUpdated = (root: string, kit = KIT): string | undefined => {
  const head = git(kit, ["rev-parse", "HEAD"])?.trim();
  if (!head) return undefined;
  mkdirSync(dirname(marker(root)), { recursive: true });
  writeFileSync(marker(root), `${head}\n`);
  return head;
};

/** What doctor and a run print about it: nothing when the project is up to date, or the kit cannot say. */
export const upgradeLines = (root: string, kit = KIT, full = true): string[] => {
  const p = pendingUpgrades(root, kit);
  if (!p || (p.recorded && !p.notes.length)) return [];
  const fix = "`/sandcastle update` in this project acts on them and records it (by hand: the kit's skill/update.md, then `sandcastle updated`)";
  if (!p.recorded) {
    return [`warn This project has no record of a kit update on this machine, so the kit's upgrading notes may not have been acted on.\n       -> ${fix}`];
  }
  const head = `warn The kit has ${p.notes.length} upgrading note(s) this project has not had since its last update`;
  if (!full) return [`${head}: \`sandcastle doctor\` lists them, ${fix}.`];
  return [`${head}:`, ...p.notes.map((n) => `       - ${n}`), `       -> ${fix}`];
};
