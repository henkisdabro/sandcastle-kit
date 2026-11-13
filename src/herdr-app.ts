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

// Bounded: a run's start asks it, and a hung binary must not hold the start.
export const onPath = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore", timeout: 2_000 }).status === 0;
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
export const appModState = (kit: string, installed = appInstalled): ModState | undefined => {
  if (!installed()) return undefined;
  const dir = appModDir();
  if (!existsSync(dir)) return "absent";
  const stamp = readStamp(dir);
  if (!stamp) return "foreign";
  return stamp.hash === appHash(kit, appFiles(kit)) ? "current" : "stale";
};

/** A `sandcastle` mod pane the app's layout holds on this machine, and the project its props name. */
/** `run`: the instance of the run that opened the pane (`appPane`); none for a pane a person opened by hand. */
export type ModPane = { pane: string; project?: string; run?: string };

/** What the run asks of the app; a test passes its own. Each throws, as `execFileSync` does, when the app says no. */
export type AppPorts = {
  /** Doctor's `ok`: `herdr-app` on PATH and the mod current against this kit's files. */
  modCurrent(kit: string): boolean;
  /** The pane the app shows `terminal` (a bare local address) in, or undefined: no window, or no pane for it. */
  paneOf(terminal: string): string | undefined;
  /** The pane that has the keyboard, or undefined. */
  focused(): string | undefined;
  /** Every `sandcastle` mod pane in this machine's layout; throws when it cannot be read. */
  modPanes(): ModPane[];
  /** The mod pane split beside `pane`, its id. */
  split(pane: string, props: object): string;
  close(pane: string): void;
  focus(pane: string): void;
};

type Listed = { spaces?: { machine?: string | null; tabs?: { terminals?: { terminal?: string; pane?: string }[] }[] }[] };
/** The pane `herdr-app ls` gives `terminal` on this machine (`machine: null`: a remote space's ids carry a prefix). */
export const paneIn = (listed: Listed, terminal: string): string | undefined => {
  for (const space of listed.spaces ?? []) {
    if (space.machine) continue;
    for (const tab of space.tabs ?? []) for (const t of tab.terminals ?? []) if (t.terminal === terminal && typeof t.pane === "string") return t.pane;
  }
  return undefined;
};

type Node = { id?: unknown; content?: { mod?: unknown; props?: { project?: unknown; run?: unknown } }; children?: unknown };
/**
 * The `sandcastle` mod panes in the core's `herdr-app` document: the layout the app keeps there, where a mod pane
 * is a block whose `content` names the mod and its props, and whose `id` is the pane's. `herdr-app ls` lists only
 * terminals, so this is where a pane is told to be the kit's, and which project's.
 */
export const modPanesIn = (doc: unknown): ModPane[] => {
  const out: ModPane[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    if (n.content?.mod === MOD_NAME && typeof n.id === "string") {
      const props = n.content.props;
      out.push({ pane: n.id, ...(typeof props?.project === "string" ? { project: props.project } : {}), ...(typeof props?.run === "string" ? { run: props.run } : {}) });
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
  };
  walk(doc);
  return out;
};

/**
 * The ports over the `herdr-app` and `hc` CLIs, made once per start: whether `herdr-app` is installed is asked once
 * there. `timeoutMs` bounds each call (a test shortens it).
 */
export const appCliPorts = ({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): AppPorts => {
  // stderr captured: the app answers `{ "error": ... }` there, which must not leak into the run's output.
  const cli = (command: string, args: string[], input?: string) =>
    execFileSync(command, args, { encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: timeoutMs, ...(input === undefined ? {} : { input }) });
  const app = (args: string[]) => cli("herdr-app", args);
  let installed: boolean | undefined;
  const isInstalled = () => (installed ??= appInstalled());
  return {
    modCurrent: (kit) => appModState(kit, isInstalled) === "current",
    paneOf(terminal) {
      if (!isInstalled()) return undefined;
      try {
        return paneIn(JSON.parse(app(["ls"])) as Listed, terminal);
      } catch {
        return undefined; // no window, or an answer that is not JSON: not in the app
      }
    },
    focused() {
      try {
        const pane = (JSON.parse(app(["status"])) as { focused_pane?: unknown }).focused_pane;
        return typeof pane === "string" ? pane : undefined;
      } catch {
        return undefined;
      }
    },
    modPanes() {
      const raw = cli("hc", ["connect"], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doc.get", params: { name: "herdr-app" } })}\n`);
      for (const line of raw.split("\n")) {
        let message: { id?: unknown; result?: { value?: unknown }; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 1) continue;
        if (!message.result) throw new Error(`hc doc.get herdr-app: ${JSON.stringify(message.error ?? message).slice(0, 120)}`);
        return modPanesIn(message.result.value);
      }
      throw new Error("hc doc.get herdr-app gave no answer");
    },
    split(pane, props) {
      const out = JSON.parse(app(["do", "pane.split", JSON.stringify({ direction: "right", pane, mod: MOD_NAME, props })])) as { pane?: unknown };
      if (typeof out.pane !== "string") throw new Error(`herdr-app pane.split gave no pane: ${JSON.stringify(out).slice(0, 120)}`);
      return out.pane;
    },
    close(pane) {
      app(["do", "pane.close", JSON.stringify({ pane })]);
    },
    focus(pane) {
      app(["do", "pane.focus", JSON.stringify({ pane })]);
    },
  };
};
