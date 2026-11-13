// The Herdr app (`herdr-app`): whether the kit's mod (herdr-app/) is installed and current, and the run's mod pane
// (#959). In the app, with the mod current, a run opens the mod pane in place of the terminal status view
// (src/herdr-core.ts `openCoreStatus`); anything else - no app, no window, a caller with no pane, the mod missing or
// older than the kit's, a split that fails - leaves the terminal view as it was.
//
// Light on purpose: src/herdr-core.ts imports it, and the status view imports that. The kit's directory is passed
// in, never read from src/sandbox.ts.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

export const APP_STAMP = ".sandcastle-kit";
/** The folder the mod is copied to, under the app's `mods/`: the mod's own `mods/sandcastle/...` asset paths name it. */
export const MOD_NAME = "sandcastle";

export const onPath = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
export const appInstalled = () => onPath("herdr-app");

/** The app's home: `$HERDR_APP_HOME`, else `~/.config/herdr-app`. */
export const appHome = (env: NodeJS.ProcessEnv = process.env) => env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
export const appModDir = () => join(appHome(), "mods", MOD_NAME);

/**
 * The kit's tracked `herdr-app/` files (relative to it, sorted), not the app's own `jsconfig.json` and
 * `gpui-kit.d.ts` that it writes into a mod folder it loads: `herdr-app/.gitignore` names those. Read from the
 * folder, not from git, so a kit without a `.git` (a release archive) copies the same files.
 */
export const appFiles = (kit: string) => {
  const root = join(kit, "herdr-app");
  const ignored = new Set(
    (existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !ignored.has(entry.name)) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
};

export const appHash = (kit: string, files: string[]) => {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\0${createHash("sha256").update(readFileSync(join(kit, "herdr-app", file))).digest("hex")}\n`);
  return hash.digest("hex");
};

export type AppStamp = { version: string; hash: string; files: string[] };
export const readStamp = (dir: string): AppStamp | undefined => {
  try {
    const stamp = JSON.parse(readFileSync(join(dir, APP_STAMP), "utf8"));
    if (typeof stamp.hash === "string" && Array.isArray(stamp.files) && stamp.files.every((f: unknown) => typeof f === "string")) return stamp;
  } catch {}
  return undefined;
};

/**
 * The mod's state, what doctor's line says: undefined without `herdr-app` on PATH; `absent` (no folder), `foreign`
 * (a folder with no stamp), `stale` (the stamp is not this kit's files) or `current`.
 */
export type ModState = "absent" | "foreign" | "stale" | "current";
export const appModState = (kit: string): ModState | undefined => {
  if (!appInstalled()) return undefined;
  const dir = appModDir();
  if (!existsSync(dir)) return "absent";
  const stamp = readStamp(dir);
  if (!stamp) return "foreign";
  return stamp.hash === appHash(kit, appFiles(kit)) ? "current" : "stale";
};

/** What the run asks of the app; a test passes its own. Each throws, as `execFileSync` does, when the app says no. */
export type AppPorts = {
  /** Doctor's `ok`: `herdr-app` on PATH and the mod current against this kit's files. */
  modCurrent(kit: string): boolean;
  /** The pane the app shows `terminal` (a bare local address) in, or undefined: no window, or no pane for it. */
  paneOf(terminal: string): string | undefined;
  /** The mod pane split beside `pane`, its id. */
  split(pane: string, props: object): string;
  close(pane: string): void;
};

// stderr captured: the app answers `{ "error": ... }` there, which must not leak into the run's output.
const appCli = (args: string[]) => execFileSync("herdr-app", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });

type Listed = { spaces?: { machine?: string | null; tabs?: { terminals?: { terminal?: string; pane?: string }[] }[] }[] };
/** The pane `herdr-app ls` gives `terminal` on this machine (`machine: null`: a remote space's ids carry a prefix). */
export const paneIn = (listed: Listed, terminal: string): string | undefined => {
  for (const space of listed.spaces ?? []) {
    if (space.machine) continue;
    for (const tab of space.tabs ?? []) for (const t of tab.terminals ?? []) if (t.terminal === terminal && typeof t.pane === "string") return t.pane;
  }
  return undefined;
};

export const appCliPorts: AppPorts = {
  modCurrent: (kit) => appModState(kit) === "current",
  paneOf(terminal) {
    if (!appInstalled()) return undefined;
    try {
      return paneIn(JSON.parse(appCli(["ls"])) as Listed, terminal);
    } catch {
      return undefined; // no window, or an answer that is not JSON: not in the app
    }
  },
  split(pane, props) {
    const out = JSON.parse(appCli(["do", "pane.split", JSON.stringify({ direction: "right", pane, mod: MOD_NAME, props })])) as { pane?: unknown; error?: unknown };
    if (typeof out.pane !== "string") throw new Error(`herdr-app pane.split gave no pane: ${JSON.stringify(out).slice(0, 120)}`);
    return out.pane;
  },
  close(pane) {
    appCli(["do", "pane.close", JSON.stringify({ pane })]);
  },
};
