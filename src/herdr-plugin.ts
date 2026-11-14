// `sandcastle herdr <verb>`: the kit's Herdr plugin (herdr/), and `configure`, the opt-in
// that sets it up.
//
// herdr/herdr-plugin.toml sends every action, pane and hook through herdr/entry.sh, which
// hands all but its two pagers to this file, so the logic stays in TypeScript and under
// test. Herdr's plugin API is its CLI, so this calls `herdr` like src/herdr.ts does; only
// the Agents view has no CLI command and goes over the socket.
//
// Nothing here is needed for a run: without the plugin, or outside Herdr, a run and its
// status view work as before. The plugin adds what only Herdr can host - keys that open the
// status view (an overlay) or the report (a popup) over any tab, Ctrl-click on a ticket for its card,
// and "sandboxes first" in the Agents panel - and `configure` adds the sidebar rows that
// show the tokens a run reports (src/herdr.ts).

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { confirm } from "./autonomy.ts";
import { clickHintLine, resolveClickHint } from "./click-hint.ts";
import { CONFIG_PATH } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { helpFor, wantsHelp } from "./help.ts";
import { herdr, lineText, restartStatusView, runCounts, tellDeadTab } from "./herdr.ts";
import { awaitedTooLong, awaitingDir, awaitReport, commandOf, PLUGIN_MARKER, RUNS_DIR } from "./live-runs.ts";
import { liveness, type Probe } from "../mod/hooks/run-live.ts";
import { readTickets, retriedNextTurn, type TicketRecord, type TicketState, WORDS } from "../mod/hooks/run-record.ts";
import type { TicketPass } from "./report.ts";
import { KIT } from "./sandbox.ts";
import { terminalHost } from "./terminal-host.ts";
import { APP_STAMP, appFiles, appHash, appHome, appInstalled, appModDir, appModState, onPath, readStamp } from "./herdr-app.ts";

export const PLUGIN_ID = "sandcastle-kit";
export const PLUGIN_DIR = join(KIT, "herdr");

// Where Herdr reads its config. Herdr's help names it (`Config: <path>`), following
// HERDR_CONFIG_PATH and, undocumented, XDG_CONFIG_HOME; so the help is the authority and
// this order only the fallback for a Herdr whose help does not say.
export const herdrConfigPath = (env: NodeJS.ProcessEnv = process.env) =>
  env.HERDR_CONFIG_PATH ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr", "config.toml");
const herdrConfigFile = () => /^Config:\s+(.+?)\s*$/m.exec(spawnSync("herdr", ["--help"], { encoding: "utf8" }).stdout ?? "")?.[1] ?? herdrConfigPath();

// The tab bar runs its command through `sh -lc`, and the kit's path may hold a space.
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

const BEGIN = "# >>> sandcastle-kit: added by `sandcastle herdr configure`; `sandcastle herdr configure --remove` takes it out";
const END = "# <<< sandcastle-kit";

// Appended whole at the end of the user's config. Every table in it is one the user has not
// defined (configConflicts checks), and `[[ui.tab_bar_right]]` extends `[ui]` from anywhere,
// so the block is valid TOML after any config - a plain `tab_bar_right = [...]` would have
// to go inside the user's own `[ui]` table.
export const configBlock = (kit = KIT) => `${BEGIN}
# Herdr's default sidebar rows, plus two. A row whose tokens nobody reports disappears, so
# other agents and spaces look as before: the extra rows are a sandbox's step and how long it
# has been at it, the plan's usage under a run's own agent (amber from 75%, red from 90%, which
# the run's text marks with ▲ and ■), and a run's progress under its space.
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  ["$sc_phase", { token = "$sc_elapsed", dim = true }],
  [{ token = "$sc_usage", rules = [{ contains = "■", fg = "#e8796a", bold = true }, { contains = "▲", fg = "#e8c36a" }] }],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [{ token = "$sandcastle", rules = [{ contains = "needs you", fg = "#e8796a", bold = true }] }],
]

# Every live run on this machine, at the right of the tab row. With no run registered the
# check fails before node starts, and Herdr hides a failed entry.
[[ui.tab_bar_right]]
type = "command"
command = ${JSON.stringify(`[ -n "$(ls -A "\${XDG_CACHE_HOME:-$HOME/.cache}/sandcastle-kit/runs" 2>/dev/null)" ] && ${shellQuote(join(kit, "bin/sandcastle"))} herdr line`)}
interval_seconds = 10
timeout_seconds = 5

[[keys.command]]
key = "prefix+shift+s"
type = "plugin_action"
command = "${PLUGIN_ID}.status"
description = "sandcastle: status view"

[[keys.command]]
key = "prefix+shift+e"
type = "plugin_action"
command = "${PLUGIN_ID}.report"
description = "sandcastle: last run's report"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "${PLUGIN_ID}.sandboxes"
description = "sandcastle: sandboxes first in Agents"
${END}`;

/** The config without this kit's block (and the blank line before it). */
export const withoutBlock = (text: string) => {
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END, from);
  if (from < 0 || to < 0) return text;
  const before = text.slice(0, from).trimEnd();
  const after = text.slice(to + END.length).replace(/^\n+/, "");
  if (!before) return after;
  return after ? `${before}\n\n${after}` : `${before}\n`;
};

export const withBlock = (text: string, kit = KIT) => {
  const rest = withoutBlock(text).replace(/\s*$/, "");
  return `${rest ? `${rest}\n\n` : ""}${configBlock(kit)}\n`;
};

// What the user's own config already sets that the block would set again: a second
// `[ui.sidebar.agents]` is a TOML error, and a second `tab_bar_right` or key would quietly
// fight theirs. Each is theirs to merge by hand.
export const configConflicts = (text: string): string[] => {
  const found: string[] = [];
  // One marker line without the other: withoutBlock would find no block, and the next
  // configure would append a second copy.
  if (text.includes(BEGIN) !== text.includes(END)) found.push("a sandcastle-kit block with one of its two marker lines missing");
  // Comment lines set nothing: `herdr --default-config` writes every key commented out.
  const own = withoutBlock(text)
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  // The kit's own entries without their markers, as left by a tool that rewrote the file.
  if (own.includes(`"${PLUGIN_ID}.`) || own.includes("herdr line")) found.push("sandcastle-kit's own entries outside its marker lines (delete them, then run configure again)");
  // An inline `ui = {...}` or `keys = {...}` cannot be extended by a table header at all.
  if (/^\s*(ui|keys)\s*=/m.test(own)) found.push("an inline `ui` or `keys` table");
  // An inline `command = [...]` of key bindings cannot take `[[keys.command]]` entries.
  if (/^\s*(keys\s*\.\s*)?command\s*=\s*\[/m.test(own)) found.push("key bindings written as an inline array (keys.command = [...])");
  if (/^\s*\[\s*ui\.sidebar(\.agents|\.spaces)?\s*\]/m.test(own) || /^\s*(ui\s*\.\s*)?sidebar\s*[.=]/m.test(own)) found.push("sidebar rows (ui.sidebar.agents or ui.sidebar.spaces)");
  if (/tab_bar_right/.test(own)) found.push("tab bar entries (ui.tab_bar_right)");
  const lower = own.toLowerCase();
  for (const key of ["prefix+shift+s", "prefix+shift+e", "prefix+shift+a"]) {
    if (lower.includes(`"${key}"`) || lower.includes(`'${key}'`)) found.push(`the key ${key}`);
  }
  return found;
};

type Reload = { ok: true; status: string; diagnostics: unknown[] } | { ok: false; reason: string };
const reloadConfig = (): Reload => {
  const r = spawnSync("herdr", ["server", "reload-config"], { encoding: "utf8" });
  const text = (r.stdout || r.stderr).trim();
  try {
    const json = JSON.parse(text);
    if (json.error) return { ok: false, reason: json.error.code === "server_not_running" ? "not running" : json.error.message };
    return { ok: true, status: json.result?.status ?? "", diagnostics: json.result?.diagnostics ?? [] };
  } catch {
    return { ok: false, reason: text || `exit ${r.status}` };
  }
};

/**
 * Whether a reload after the write took the block: Herdr applied the file whole, and said
 * nothing it had not already said about the config before it (a user's own old warning is
 * not the block's doing). Herdr not running is fine: it reads the file when it starts.
 */
export const reloadTook = (after: Reload, before: Reload) => {
  if (!after.ok) return after.reason === "not running";
  const known = new Set(before.ok ? before.diagnostics.map((d) => JSON.stringify(d)) : []);
  return after.status === "applied" && after.diagnostics.every((d) => known.has(JSON.stringify(d)));
};

const linked = () => {
  try {
    const list = JSON.parse(herdr(["plugin", "list", "--json"])).result.plugins as { plugin_id: string; plugin_root?: string }[];
    return list.find((p) => p.plugin_id === PLUGIN_ID);
  } catch {
    return undefined;
  }
};

// A plugin root that no longer exists (a deleted worktree) compares as written.
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** For doctor: whether the plugin is linked from this checkout, and the block is in the config. */
export const pluginState = () => {
  const plugin = linked();
  const path = herdrConfigFile();
  return {
    linkedHere: !!plugin?.plugin_root && real(plugin.plugin_root) === real(PLUGIN_DIR),
    linkedFrom: plugin?.plugin_root,
    block: existsSync(path) && readFileSync(path, "utf8").includes(BEGIN),
  };
};

// ---------------------------------------------------------------------------
// The Herdr app mod (herdr-app/): copied, never linked. The app reloads a mod folder on save, but not through a
// symlink (a linked folder kept its old code after two saves, a copied one showed the edit at once), so the kit
// copies it into the app's mods directory and copies it again when the kit's files change.
// ---------------------------------------------------------------------------

const kitVersionOf = (kit: string) => {
  try {
    return JSON.parse(readFileSync(join(kit, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
};

// A listed file is a path inside the mod folder, whatever the stamp says: a stamp edited by hand never reaches out.
const inside = (dir: string, file: string) => {
  const rel = relative(dir, join(dir, file));
  return !!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !file.startsWith("/");
};

/** For doctor: the app mod's line, or nothing when the Herdr app is not installed. */
export const appModLine = (kit = KIT): string | undefined => {
  const state = appModState(kit);
  const dir = appModDir();
  if (state === undefined) return undefined;
  if (state === "absent") return "opt  Herdr app mod (optional: the status view in the app's own look)\n       -> `sandcastle herdr configure --app` (shows what it copies and asks first).";
  if (state === "foreign") return `warn Herdr app mod: ${dir} is not the kit's (no ${APP_STAMP} stamp in it).\n       -> Move it or remove it, then run \`sandcastle herdr configure --app --yes\`.`;
  if (state === "stale") return "warn Herdr app mod: the copy is older than this kit's herdr-app/.\n       -> `sandcastle herdr configure --app --yes` copies it again.";
  return `ok   Herdr app mod: ${dir} is current`;
};

const removeEmptyDirs = (dir: string, stop: string) => {
  for (let d = dir; d.startsWith(stop) && d !== stop; d = dirname(d)) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
  }
};

/**
 * Copies (or with `remove`, takes out) the app mod. Returns true when it stopped for want of a terminal or `--yes`
 * (it has printed what it would do), so `configure` can say so once for both halves.
 */
const configureAppMod = async (remove: boolean, yes: boolean, byDefault: boolean, kit: string): Promise<boolean> => {
  const dir = appModDir();
  const stamp = existsSync(dir) ? readStamp(dir) : undefined;
  if (remove) {
    if (!stamp) {
      if (existsSync(dir)) console.log(`${dir} is not the kit's (no ${APP_STAMP} stamp in it), so it stays.`);
      return false;
    }
    const listed = [...stamp.files, APP_STAMP].filter((f) => inside(dir, f));
    for (const file of listed) rmSync(join(dir, file), { force: true });
    for (const file of listed) removeEmptyDirs(dirname(join(dir, file)), dir);
    // The folder goes only when nothing else is in it.
    removeEmptyDirs(dir, join(appHome(), "mods"));
    console.log(`Removed the Herdr app mod from ${dir}. \`sandcastle herdr configure --app\` copies it again.`);
    return false;
  }
  if (existsSync(dir) && !stamp) {
    throw new OperatorError(`${dir} exists and is not the kit's (no ${APP_STAMP} stamp in it), so nothing was copied. Move it or remove it, then run \`sandcastle herdr configure --app --yes\` again.`);
  }
  const files = appFiles(kit);
  if (!files.length) return false;
  const hash = appHash(kit, files);
  if (stamp?.hash === hash && files.every((f) => existsSync(join(dir, f)))) {
    console.log(`The Herdr app mod in ${dir} is current: nothing copied.`);
    return false;
  }
  console.log(`This will copy the Herdr app mod (${files.length} files from ${join(kit, "herdr-app")}) to ${dir}.\n\`sandcastle herdr configure --remove --app\` takes it out again. It is copied, not linked: the app does not reload a mod through a symlink.\n`);
  if (!yes) {
    const answer = await confirm(`Copy the Herdr app mod? ${byDefault ? "[Y/n]" : "[y/N]"} `, undefined, undefined, byDefault);
    if (answer === undefined) return true;
    if (!answer) {
      console.log("Nothing copied.");
      return false;
    }
  }
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), readFileSync(join(kit, "herdr-app", file)));
  }
  // A file the kit dropped since the last copy goes too.
  for (const old of stamp?.files ?? []) if (!files.includes(old) && inside(dir, old)) rmSync(join(dir, old), { force: true });
  for (const old of stamp?.files ?? []) removeEmptyDirs(dirname(join(dir, old)), dir);
  writeFileSync(join(dir, APP_STAMP), `${JSON.stringify({ version: kitVersionOf(kit), hash, files }, null, 2)}\n`);
  console.log(`Copied the Herdr app mod to ${dir}. The app reloads it on its own.`);
  return false;
};

/** `configure`'s two halves, named: `--app` the Herdr app mod, `--tui` the Herdr TUI plugin. Neither: see `configure`. */
export type Halves = { app?: boolean; tui?: boolean };
export const CONFIGURE_USAGE = "Usage: sandcastle herdr configure [--app] [--tui] [--remove] [--yes].";

/**
 * Which halves a `configure` with no `--app` or `--tui` sets up, and the line it says about a half it leaves alone.
 * With one of Herdr TUI and the Herdr app installed, that one, as before the two were separable: a Linux machine has
 * no Herdr app, and its users' documented command is the bare one. With both, the app mod, and the TUI plugin only
 * where it is already set up from this checkout (linked here, or its block present with nothing linked elsewhere):
 * Herdr TUI on PATH beside the app is often left from before the app, and linking a plugin and editing its config
 * there was a change nobody asked for. A link from another checkout is that checkout's, so it is left alone too.
 */
export const defaultHalves = (app: boolean, tui: boolean, plugin: { linkedHere: boolean; linkedFrom?: string; block: boolean }): { app: boolean; tui: boolean; skipped?: string } => {
  if (!(app && tui)) return { app, tui };
  if (plugin.linkedFrom && !plugin.linkedHere) {
    return { app, tui: false, skipped: `Herdr TUI plugin: linked from another checkout (${plugin.linkedFrom}), so left alone - \`sandcastle herdr configure --tui\` here links this one in its place.` };
  }
  if (plugin.linkedHere || plugin.block) return { app, tui: true };
  return { app, tui: false, skipped: "Herdr TUI plugin: not set up here, so left alone - `sandcastle herdr configure --tui` adds it (the Herdr app does not need it)." };
};

/**
 * `byDefault`: the answer when the user just presses Enter (setup offers the plugin as a yes). The app mod (when
 * `herdr-app` is on PATH) and the Herdr TUI plugin are independent: `pick` names one or both, and with neither
 * `defaultHalves` decides. Adding a half needs its program; removing one needs only what the kit left, so a mod or a
 * block outlives an uninstalled app or Herdr and can still be taken out. `--remove` takes the plugin out first, its
 * unlink before anything else: a Herdr that refuses the unlink (its server not running) leaves both halves as found.
 * Adding copies the mod first, so a plugin step that fails never takes back the mod copy.
 */
export const configure = async (remove: boolean, yes: boolean, byDefault = false, kit = KIT, pick: Halves = {}) => {
  const app = appInstalled();
  const tui = onPath("herdr");
  const named = !!(pick.app || pick.tui);
  if (remove) {
    // A half with nothing of the kit's in it says nothing: no plugin line for a machine that never had Herdr TUI.
    const plugin = pick.tui || (!named && (tui || pluginState().block));
    const mod = pick.app || (!named && (app || existsSync(appModDir())));
    if (!plugin && !mod) throw new OperatorError("Nothing of the kit's to remove: no Herdr TUI plugin or block, and no Herdr app mod.");
    if (plugin) await configurePlugin(true, yes, byDefault);
    if (mod) await configureAppMod(true, yes, byDefault, kit);
    return;
  }
  if (pick.app && !app) throw new OperatorError("`herdr-app --version` did not answer: the Herdr app is not installed here (or did not start in time), so there is no mod to copy.");
  if (pick.tui && !tui) throw new OperatorError("`herdr --version` did not answer: Herdr TUI is not installed here (or did not start in time), so there is no plugin to link.");
  if (!named && !tui && !app) throw new OperatorError("Herdr is not installed (https://herdr.dev) - there is nothing to configure.");
  const halves = named ? { app: !!pick.app, tui: !!pick.tui } : defaultHalves(app, tui, tui && app ? pluginState() : { linkedHere: false, block: false });
  const needsAnswer = halves.app ? await configureAppMod(false, yes, byDefault, kit) : false;
  if ("skipped" in halves && halves.skipped) console.log(halves.skipped);
  if (halves.tui) await configurePlugin(false, yes, byDefault);
  if (needsAnswer) throw new OperatorError("Not a terminal: run it in one to answer, or pass --yes.");
};

/**
 * A `herdr` call that failed, as words the operator acts on rather than a stack trace. Herdr answers `{ "error": ... }`;
 * the one failure with a fix the kit can name is a stopped server, which `plugin unlink` needs (`plugin link` and
 * `plugin list` do not). `after` says what state that leaves.
 */
export const herdrFailure = (error: unknown, args: string[], after: string): OperatorError => {
  const e = error as { stdout?: string; stderr?: string; message?: string };
  const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  const said = (() => {
    for (const line of out.split("\n")) {
      try {
        const json = JSON.parse(line) as { error?: { code?: string; message?: string } };
        if (json.error) return json.error;
      } catch {
        // not Herdr's JSON
      }
    }
    return undefined;
  })();
  const command = `herdr ${args.join(" ")}`;
  if (said?.code === "server_not_running") {
    return new OperatorError(
      `Herdr TUI's server is not running, and \`${command}\` needs it: run \`herdr server\` in another terminal (or open \`herdr\`), run this again, then \`herdr server stop\` if you started it for this. ${after}`,
    );
  }
  const why = said?.message ?? (out.trim().split("\n")[0] || String(e.message ?? error).split("\n")[0]);
  return new OperatorError(`\`${command}\` failed: ${why}. ${after}`);
};

const configurePlugin = async (remove: boolean, yes: boolean, byDefault: boolean) => {
  const path = herdrConfigFile();
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const plugin = pluginState();

  if (remove) {
    // Only this checkout's link: the one in use may be another clone's or worktree's. Herdr
    // drops the plugin's Agents view with the link, so its "on" flag goes too: left behind,
    // a later link's startup hook put the view back, and the next key turned it off.
    // The unlink goes first: Herdr refuses it with its server stopped, and the block and marker
    // deleted before it left a plugin still linked with its keys and rows gone.
    if (plugin.linkedHere) {
      try {
        herdr(["plugin", "unlink", PLUGIN_ID]);
      } catch (error) {
        throw herdrFailure(error, ["plugin", "unlink", PLUGIN_ID], "Nothing was changed.");
      }
      rmSync(viewFlag(), { force: true });
    } else if (plugin.linkedFrom) console.log(`The plugin is linked from another checkout (${plugin.linkedFrom}), so it stays linked: \`sandcastle herdr configure --remove --tui\` there unlinks it.`);
    // A link from another checkout stays, so the status view's links stay with it.
    if (!plugin.linkedFrom || plugin.linkedHere) rmSync(PLUGIN_MARKER, { force: true });
    const after = withoutBlock(before);
    if (after !== before) {
      try {
        writeFileSync(path, after);
      } catch (error) {
        // Nothing to roll back: run again, it finds the plugin unlinked and strips the block.
        throw new OperatorError(
          `${plugin.linkedHere ? "The plugin is unlinked, but" : "Could not take the block out:"} ${path} could not be written (${(error as Error).message}), so the sandcastle-kit block is still in it. Run \`sandcastle herdr configure --remove --tui\` again once it is writable: it finishes the job.`,
        );
      }
    }
    if (after === before && (before.includes(`"${PLUGIN_ID}.`) || before.includes("herdr line"))) {
      console.log(`${path} has sandcastle-kit entries outside its marker lines (a tool may have rewritten the file): delete them by hand.`);
    }
    const done = [...(after !== before ? [`the sandcastle-kit block from ${path}`] : []), ...(plugin.linkedHere ? ["the plugin"] : [])];
    if (!done.length) {
      console.log(`Nothing to remove from this checkout: no sandcastle-kit block in ${path}, and the plugin is not linked from here.`);
      return;
    }
    const reload = reloadConfig();
    console.log(`Removed ${done.join(" and ")}.${reload.ok ? " Herdr reloaded its config." : ""} \`sandcastle herdr configure --tui\` adds it again.`);
    return;
  }

  const conflicts = configConflicts(before);
  if (conflicts.length) {
    throw new OperatorError(
      `${path} already sets ${conflicts.join(", ")}. Merge this block into it by hand instead, keeping what you have:\n\n${configBlock()}\n\n` +
        "Then link the plugin: `herdr plugin link " + PLUGIN_DIR + "`.",
    );
  }
  const elsewhere = plugin.linkedFrom && !plugin.linkedHere ? plugin.linkedFrom : undefined;
  console.log(
    `This will:\n  1. link the sandcastle-kit plugin from ${PLUGIN_DIR} (\`herdr plugin link\`; no build, a \`git pull\` of the kit updates it)` +
      (elsewhere ? `,\n     in place of the link to ${elsewhere}` : "") +
      `\n  2. add the block below to the end of ${path}\n  3. reload Herdr's config (nothing restarts; your panes are untouched)\n` +
      `\`sandcastle herdr configure --remove --tui\` undoes all three.\n\n${configBlock()}\n`,
  );
  if (!yes) {
    const answer = await confirm(`Go ahead? ${byDefault ? "[Y/n]" : "[y/N]"} `, undefined, undefined, byDefault);
    if (answer === undefined) throw new OperatorError("Not a terminal: run it in one to answer, or pass --yes.");
    if (!answer) {
      console.log("Nothing changed.");
      return;
    }
  }
  // What Herdr already says about the config as it is, so its old warnings are not blamed on the block.
  const baseline = reloadConfig();
  // A failed `herdr` call is the operator's to act on, never a stack trace. The other checkout's link goes first, so a
  // refused unlink has changed nothing; a link that fails after it puts that link back if Herdr lets it.
  if (elsewhere) {
    try {
      herdr(["plugin", "unlink", PLUGIN_ID]);
    } catch (error) {
      throw herdrFailure(error, ["plugin", "unlink", PLUGIN_ID], "Nothing was changed.");
    }
  }
  try {
    herdr(["plugin", "link", PLUGIN_DIR]);
  } catch (error) {
    let after = "Nothing in the config was changed.";
    if (elsewhere) {
      try {
        herdr(["plugin", "link", elsewhere]);
        after += ` The link to ${elsewhere} is back.`;
      } catch {
        after += ` The link to ${elsewhere} could not be put back: \`herdr plugin link ${elsewhere}\` restores it.`;
      }
    }
    throw herdrFailure(error, ["plugin", "link", PLUGIN_DIR], after);
  }
  mkdirSync(dirname(path), { recursive: true });
  if (before) writeFileSync(`${path}.sandcastle-kit.bak`, before);
  writeFileSync(path, withBlock(before));
  const reload = reloadConfig();
  // Herdr is the only full check of the result, so anything short of a clean reload - new
  // diagnostics, a partial apply, an error, an answer that would not parse - puts everything
  // back. Only a Herdr that is not running keeps the block: it reads the file when it starts.
  if (!reloadTook(reload, baseline)) {
    if (before) writeFileSync(path, before);
    else rmSync(path, { force: true });
    reloadConfig();
    // The roll-back's own `herdr` calls may fail too (a server that stopped meanwhile): said, not thrown over the cause.
    const undone: string[] = [];
    const undo = (args: string[]) => {
      try {
        herdr(args);
      } catch {
        undone.push(`\`herdr ${args.join(" ")}\``);
      }
    };
    if (!plugin.linkedHere) undo(["plugin", "unlink", PLUGIN_ID]);
    if (elsewhere) undo(["plugin", "link", elsewhere]);
    throw new OperatorError(
      `Herdr did not take the new config, so ${path} ${undone.length ? `is back as it was; the plugin link could not be put back (run ${undone.join(" and ")})` : "and the plugin link are back as they were"}:\n` +
        (reload.ok ? JSON.stringify(reload.diagnostics, null, 2) : reload.reason),
    );
  }
  mkdirSync(dirname(PLUGIN_MARKER), { recursive: true });
  writeFileSync(PLUGIN_MARKER, PLUGIN_DIR);
  console.log(
    `Done${reload.ok ? " - Herdr reloaded its config" : ". Herdr is not running: it reads the block when it starts, and if it reports a problem then, `sandcastle herdr configure --remove --tui` takes the block out"}.` +
      `\n  prefix+shift+s  status view    prefix+shift+e  last run's report    prefix+shift+a  sandboxes first in Agents` +
      `\n  (the prefix is ctrl+b unless you changed it). A click on a ticket in the status view opens its card (its passes, and a key for each one's log), with the key below.`,
  );
  // Ctrl-click is macOS's right-click in iTerm2: which key the view will name, said where the plugin is set up.
  console.log(clickHintLine(resolveClickHint()));
};

// ---------------------------------------------------------------------------
// The tab bar: one line for every live run, from the runs directory src/herdr.ts keeps.
// ---------------------------------------------------------------------------

type Run = { root: string; orchestrator?: string; pid?: number; startedAt?: string; finishedAt?: string; share?: number; paused?: unknown; tickets?: Record<string, TicketRecord> };

/**
 * Live runs, newest first. A file whose run has ended or died - or whose pid is some other process now - is removed,
 * after `ended` has been told the root of a run whose record says so: its file is the last
 * sign of it, and the tab bar does not tick again for a run that is not registered. So `ended`
 * returning true moves the file to the awaiting directory (`awaitReport`), for a tab still waiting to be
 * told (`tellDeadTab`), held by another Herdr server, or not reachable (`retry`): kept here, it held the tab bar's gate open.
 * `live` is told the root of each live run (the tab bar restarts its status view, `restartStatusView`).
 */
export const liveRuns = (dir = RUNS_DIR, probe: Probe = commandOf, ended: (root: string) => boolean | void = () => {}, live: (root: string) => void = () => {}): Run[] => {
  const runs: Run[] = [];
  const readRecord = (root: string) => {
    try {
      return readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8");
    } catch {
      return undefined;
    }
  };
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const file = join(dir, f);
    let root: string | undefined;
    let seen: string | undefined;
    let awaits = false;
    try {
      root = readFileSync(file, "utf8").trim();
      seen = readRecord(root);
      const record = JSON.parse(seen ?? "");
      const run = { root, ...record, tickets: readTickets(record) } as Run;
      if (liveness({ record: run }, probe).state === "live") {
        live(root);
        runs.push(run);
        continue;
      }
      awaits = !!ended(root);
    } catch {
      /* no record: not a live run */
    }
    // The file is named by the project, so a new run of it registers under the same name: a record
    // that changed since it was judged is that run's, and its file stays for the next reader.
    if (root !== undefined && readRecord(root) !== seen) continue;
    if (awaits && root !== undefined) awaitReport(root, dir, file);
    else rmSync(file, { force: true });
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
};

/**
 * The awaiting directory's files (`awaitReport`), as `[file, root]`, after removing those that no
 * longer await anything: a run that ended more than `AWAIT_REPORT_DAYS` ago (`awaitedTooLong`), and a
 * project running again, whose own file in the runs directory is the new run's (its view record is the
 * new run's too, and a report typed into its tab would be a live run's).
 */
const awaiting = (dir: string, probe: Probe, now: number): [string, string][] => {
  const parked = awaitingDir(dir);
  const left: [string, string][] = [];
  for (const f of existsSync(parked) ? readdirSync(parked) : []) {
    const file = join(parked, f);
    try {
      const root = readFileSync(file, "utf8").trim();
      if (!awaitedTooLong(root, now) && liveness({ record: JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")) }, probe).state !== "live") {
        left.push([file, root]);
        continue;
      }
    } catch {
      /* no root or no record: nothing to tell */
    }
    rmSync(file, { force: true });
  }
  return left;
};

/**
 * The tab bar, while live runs keep it ticking, tells the awaiting tabs too: `tell` is `replaceDeadTab`,
 * and its true (the status view still showing, the tab on another server, or herdr failing) keeps the file.
 */
export const tellAwaiting = (dir = RUNS_DIR, tell: (root: string) => boolean = replaceDeadTab, probe: Probe = commandOf, now = Date.now()) => {
  for (const [file, root] of awaiting(dir, probe, now)) if (!tell(root)) rmSync(file, { force: true });
};

/**
 * The plugin's startup hook: a Herdr restart is what leaves a showing status view a bare shell, so each
 * awaiting file goes back to the runs directory and the first tick tells its tab, from a session Herdr has
 * restored (the hook need not wait for that). A tab still showing, or another server's, comes back here on that tick.
 * `wx`: a file a new run of the project wrote meanwhile stays the new run's.
 */
export const requeueAwaiting = (dir = RUNS_DIR, probe: Probe = commandOf, now = Date.now()) => {
  for (const [file, root] of awaiting(dir, probe, now)) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, basename(file)), root, { flag: "wx" });
    } catch {
      /* the new run's file, or a directory that cannot be written: the tab bar has nothing to tell */
    }
    rmSync(file, { force: true });
  }
};

// Whichever reader of the runs directory drops a dead run's file first tells the tab: the tab bar's
// next tick would find no file. A tab whose status view still runs has its file moved to the awaiting
// directory until it can be told; a tab on another Herdr server too: that server has yet to tell it.
// A run's exit moves its file there while its own tab is unreported (live-runs.ts). From there the
// startup hook after a Herdr restart (`requeueAwaiting`), and the tab bar while live runs keep it
// ticking (`tellAwaiting`), tell the tab, until it is reported or `AWAIT_REPORT_DAYS` old: a closed tab
// is a herdr error (`retry`), as a server not yet restored may answer, so it waits out the expiry too.
export const replaceDeadTab = (root: string, kit?: string) => {
  const told = tellDeadTab(root, kit);
  return told === "showing" || told === "elsewhere" || told === "retry";
};

/** The run of the focused pane's project first (Herdr gives the tab bar its cwd), then the newest. */
export const runsLine = (dir = RUNS_DIR, focusedCwd = process.env.HERDR_ACTIVE_PANE_CWD, probe: Probe = commandOf, ended?: (root: string) => boolean | void, live?: (root: string) => void) => {
  const here = (r: Run) => !!focusedCwd && (focusedCwd === r.root || focusedCwd.startsWith(`${r.root}/`));
  const runs = liveRuns(dir, probe, ended, live).sort((a, b) => Number(here(b)) - Number(here(a)));
  return runs.length ? `♜ ${runs.map((r) => lineText(r.orchestrator ?? basename(r.root), runCounts(r.tickets ?? {}, !!r.paused && typeof r.paused === "object", retriedNextTurn(r, true)), Number.isInteger(r.share) ? r.share : undefined)).join("  |  ")}` : "";
};

// ---------------------------------------------------------------------------
// Popups: the action finds the project, then asks Herdr to open the pane on it.
// ---------------------------------------------------------------------------

const projectAt = (cwd: string | undefined) => {
  if (!cwd) return undefined;
  const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const root = top.status === 0 ? top.stdout.trim() : undefined;
  return root && existsSync(join(root, CONFIG_PATH)) ? root : undefined;
};

// The workspace a run's Herdr tab is in, from the record src/herdr.ts keeps (`w1:t2` is in `w1`).
const runWorkspace = (root: string) => {
  try {
    return (JSON.parse(readFileSync(join(root, ".sandcastle/logs/herdr-view.json"), "utf8")).tab as string).split(":")[0];
  } catch {
    return undefined;
  }
};

/**
 * The project an action is about: the focused pane's (or its workspace's), else the only live
 * run, else the one live run whose tab is in this workspace. With several runs and none here,
 * `why` asks the user to pick by focus: showing one at random reads as the right one.
 */
export const contextProject = (context = process.env.HERDR_PLUGIN_CONTEXT_JSON, runs = () => liveRuns(undefined, undefined, replaceDeadTab)): { root?: string; why?: string } => {
  const ctx = JSON.parse(context || "{}") as { focused_pane_cwd?: string; workspace_cwd?: string; workspace_id?: string };
  const here = projectAt(ctx.focused_pane_cwd) ?? projectAt(ctx.workspace_cwd);
  if (here) return { root: here };
  const live = runs();
  if (live.length === 0) return { why: "No sandcastle project in the focused pane, and no run going." };
  if (live.length === 1) return { root: live[0].root };
  const inWorkspace = live.filter((r) => runWorkspace(r.root) === ctx.workspace_id);
  if (inWorkspace.length === 1) return { root: inWorkspace[0].root };
  return { why: `${live.length} runs going (${live.map((r) => r.orchestrator ?? basename(r.root)).join(", ")}): focus a pane in the project you mean.` };
};

const notify = (body: string) => {
  try {
    herdr(["notification", "show", "Sandcastle", "--body", body]);
  } catch {
    /* nothing else to tell it with */
  }
};

const openPane = (entrypoint: string, cwd: string, env: Record<string, string> = {}) =>
  herdr(["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", entrypoint, "--cwd", cwd, ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`])]);

// A ticket's latest log, from a Ctrl-click in the status view: the card opens for its ticket. Herdr
// routes a matching link from any pane, and an agent's log shown in a sandbox pane can print one,
// so the link proves nothing: what the card is built from is a regular file whose real path,
// symlinks resolved, is a log under some project's .sandcastle/logs. entry.sh pages each log with
// LESSSECURE (no shell, no editor).
export const logOf = (url: string | undefined) => {
  if (!url?.startsWith("file://")) return undefined;
  try {
    const path = realpathSync(fileURLToPath(url));
    return /\/\.sandcastle\/logs\/[^/]+\.log$/.test(path) && statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// The ticket card: what a Ctrl-click on a ticket opens. The link is still the ticket's latest log
// (logOf vouches for it), and the card is built for the ticket and project that log belongs to: its
// state from run.json, its passes from timings.jsonl, and a digit for each pass's log, paged as
// the log popup always was. Nothing here asks git or the tracker, but `t` asks git for the remote.
// ---------------------------------------------------------------------------

/** The log each kind of pass writes (burndown's agentLogging names); a landing gate writes the gates log. */
const PASS_LOG: Record<string, string> = {
  implement: "impl",
  resolve: "resolve",
  review: "review",
  "cross-review": "review-codex",
  gates: "gates",
  repair: "repair",
  "landing gates": "gates",
  landing: "gates",
};
const LOG_ORDER = ["impl", "resolve", "review", "review-codex", "repair", "gates"];
// A ticket's state while one of its passes runs: that pass has no timings line until it ends.
const RUNNING = new Set(["implement", "resolve", "review", "cross-review", "gates", "repair", "landing"]);

// Titles, notes and logs are written by agents and trackers: a control sequence in one must not
// drive the terminal the card is drawn on.
// oxlint-disable-next-line no-control-regex -- matching escape sequences and control characters is the point: it strips them
const printable = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export type CardFacts = {
  id: string;
  /** run.json's entry for the ticket; undefined when the last run did not take it. */
  ticket?: TicketRecord;
  /** Its passes in that run (ticketPasses in src/report.ts). */
  passes: TicketPass[];
  /** The file names of its logs in .sandcastle/logs. */
  logs: string[];
  /** The last lines of its gates log, read when it is red. */
  gateTail?: string[];
  /** Seconds since the epoch. */
  now: number;
  /** What `t` found, once pressed. */
  tracker?: string;
};

/**
 * What the card says, as data: the terminal card (`ticketCard`) and the Herdr app mod's (`sandcastle herdr card
 * --json`, #960) draw the same facts. Every text an agent or tracker wrote is made printable here. `passes[].log`
 * is the pass's log when it exists; `logs` is every log of the ticket, by kind.
 */
export type CardData = {
  id: string;
  ref: string;
  title?: string;
  /** Whether the last run's record has the ticket. */
  inRun: boolean;
  /** Its state and for how long (`implementing for 3m 02s`), when the run has it. */
  status?: string;
  passes: { pass: string; outcome: string; time: string; log?: string }[];
  /** Why it stopped where it is: a hold's or a conflict's reason, as the record keeps it. */
  why: string[];
  gateTail?: string[];
  logs: string[];
  tracker?: string;
};

export const cardData = (f: CardFacts): CardData => {
  const ref = /^\d+$/.test(f.id) ? `#${f.id}` : f.id;
  const t = f.ticket;
  const own = (kind: string) => `agent-issue-${f.id}-${kind}-${f.id}.log`;
  const exists = (file: string) => (f.logs.includes(file) ? file : undefined);
  const kinds = (name: string) => LOG_ORDER.findIndex((k) => name.endsWith(`-${k}-${f.id}.log`));
  const logs = [...f.logs].sort((a, b) => kinds(a) - kinds(b) || a.localeCompare(b)).map(printable);
  const tracker = f.tracker ? { tracker: printable(f.tracker) } : {};
  if (!t) return { id: f.id, ref, inRun: false, passes: [], why: [], logs, ...tracker };
  const word = t.state ? (WORDS[t.state] ?? t.state) : "state not recorded";
  const passes: CardData["passes"] = f.passes.map((p) => {
    const gate = p.phase === "gates" || p.phase === "landing gates";
    const outcome = gate ? (p.ok ? "green" : `red${p.red?.length ? `: ${p.red.join(", ")}` : ""}`) : p.ok ? "ok" : "failed";
    const log = exists(own(PASS_LOG[p.phase]));
    return { pass: printable(WORDS[p.phase as TicketState] ?? p.phase), outcome: printable(outcome), time: duration(p.ms), ...(log ? { log } : {}) };
  });
  if (t.state && RUNNING.has(t.state)) {
    const log = exists(own(PASS_LOG[t.state]));
    passes.push({ pass: printable(WORDS[t.state] ?? t.state), outcome: "running", time: t.since ? duration((f.now - t.since) * 1000) : "", ...(log ? { log } : {}) });
  }
  const why = [
    ...(t.note ? [printable(t.note)] : []),
    ...(t.files?.length ? [`files: ${t.files.map(printable).join(", ")}`] : []),
    ...(t.failing?.length ? [`failing: ${t.failing.map(printable).join(", ")}`] : []),
    ...(t.requeued ? [printable(t.requeued)] : []),
  ];
  return {
    id: f.id,
    ref,
    ...(t.title ? { title: printable(t.title) } : {}),
    inRun: true,
    status: printable(t.since ? `${word} for ${duration((f.now - t.since) * 1000)}` : word),
    passes,
    why,
    ...(f.gateTail?.length ? { gateTail: f.gateTail.map(printable) } : {}),
    logs,
    ...tracker,
  };
};

/** The card's text, and the log each digit opens (`logs[0]` is 1). Pure: a test gives it made-up records. */
export const ticketCard = (f: CardFacts): { text: string; logs: string[] } => {
  const d = cardData(f);
  const out: string[] = [];
  const logs: string[] = [];
  // A digit for a log that exists, up to 9: the card reads one key at a time.
  const key = (file: string | undefined) => {
    if (!file || logs.length >= 9) return "   ";
    logs.push(file);
    return `${logs.length}  `;
  };
  if (!d.inRun) {
    out.push(d.ref, "Not in the last run: run.json has no entry for this ticket.");
    out.push("", d.logs.length ? "Its logs:" : "It has no logs here.");
    for (const file of d.logs) out.push(`  ${key(file)}${file}`);
  } else {
    out.push(`${d.ref}${d.title ? `  ${d.title}` : ""}`, d.status ?? "");
    const keys = d.passes.map((p) => key(p.log));
    out.push("");
    if (!d.passes.length) out.push("No pass of it is timed in this run yet.");
    const w0 = Math.max(0, ...d.passes.map((p) => p.pass.length));
    const w1 = Math.max(0, ...d.passes.map((p) => p.outcome.length));
    d.passes.forEach((p, i) => out.push(`  ${keys[i]}${p.pass.padEnd(w0)}  ${p.outcome.padEnd(w1)}  ${p.time}`.trimEnd()));
    if (d.why.length) out.push("", ...d.why);
    if (d.gateTail?.length) out.push("", "The gates log ends:", ...d.gateTail.map((l) => `  ${l}`));
  }
  const n = logs.length;
  out.push("", [...(n ? [`${n === 1 ? "1" : `1-${n}`} log`] : []), "t tracker", "q close"].join(" · "));
  if (d.tracker) out.push(`tracker: ${d.tracker}`);
  return { text: out.join("\n"), logs };
};

export type CardKey = { kind: "page"; index: number } | { kind: "tracker" } | { kind: "close" };

/** What a key read in raw mode does on a card with `logs` numbered logs; undefined does nothing. */
export const cardKey = (data: string, logs: number): CardKey | undefined => {
  // A lone Esc closes; an arrow or other escape sequence starts with one and does nothing.
  if (data === "\x1b" || data === "\x03") return { kind: "close" };
  if (data.startsWith("\x1b")) return undefined;
  const c = data[0];
  if (c === "q" || c === "Q") return { kind: "close" };
  if (c === "t" || c === "T") return { kind: "tracker" };
  const d = Number(c);
  return c >= "1" && c <= "9" && d <= logs ? { kind: "page", index: d - 1 } : undefined;
};

/** A GitHub issue's page from the origin remote's URL, in any of the forms git takes; undefined when it is not github.com. */
export const githubIssueUrl = (remote: string, id: string) => {
  const m = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  if (!m || !/^(?:.+\.)?github\.com$/i.test(m[1])) return undefined;
  return `https://github.com/${m[2]}/${m[3]}/issues/${id}`;
};

/** A ticket file's path among a repository's files: a files-tracker id is its feature folder's slug and its number. */
export const ticketFileOf = (paths: string[], id: string, slug: (s: string) => string) => {
  const m = /^(.+)-(\d+)$/.exec(id);
  if (!m) return undefined;
  return paths.find((p) => {
    const f = /(?:^|\/)([^/]+)\/issues\/(\d+)-[^/]+\.md$/.exec(p);
    return !!f && slug(f[1]) === m[1] && Number(f[2]) === Number(m[2]);
  });
};

// `t`: no network call. The GitHub URL comes from the origin remote, a ticket file from git's own list
// of the repository's files - the card does not load the project's config.ts to learn its tracker.
// The root comes from the clicked log's path, and an agent can print a link to a log in a repo of
// its own making under its worktree: that repo's config must not run anything on the host, so its
// fsmonitor and hooks are switched off on the command line, which outranks any config file.
export const trackerLink = (root: string, id: string, slug: (s: string) => string) => {
  const git = (args: string[]) =>
    spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (/^\d+$/.test(id)) {
    const remote = git(["remote", "get-url", "origin"]);
    const url = remote.status === 0 ? githubIssueUrl(remote.stdout, id) : undefined;
    return url ?? `no GitHub origin remote to link #${id} to`;
  }
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const file = listed.status === 0 ? ticketFileOf(listed.stdout.split("\0"), id, slug) : undefined;
  return file ? join(root, file) : `no ticket file for ${id} in this repository`;
};

// The red gate's last lines: the end of a gates log is the failure, and the log can be long.
const tailOf = (file: string, lines = 12) => {
  try {
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(Math.min(size, 64 * 1024));
    try {
      readSync(fd, buf, 0, buf.length, size - buf.length);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8").replace(/\s+$/, "").split("\n").slice(-lines);
  } catch {
    return undefined;
  }
};

/** A reader of ticket `id`'s card facts from a project's logs folder, read afresh at each call. */
const cardFactsOf = async (logsDir: string, id: string) => {
  // Loaded here, not at the top: the tab bar runs this file every 10 seconds and needs none of them.
  const [{ ticketPasses }, { logOwner }] = await Promise.all([import("./report.ts"), import("./run.ts")]);
  const read = (file: string) => {
    try {
      return readFileSync(join(logsDir, file), "utf8");
    } catch {
      return "";
    }
  };
  return (): CardFacts => {
    let record: unknown;
    try {
      record = JSON.parse(read("run.json"));
    } catch {
      record = undefined;
    }
    const ticket = readTickets(record)[id];
    const runId = (record as { startedAt?: unknown } | undefined)?.startedAt;
    const logs = readdirSync(logsDir).filter((f) => f.endsWith(".log") && logOwner(f) === id);
    return {
      id,
      ticket,
      passes: ticket && typeof runId === "string" ? ticketPasses(read("timings.jsonl"), id, runId) : [],
      logs,
      gateTail: ticket?.state === "red" ? tailOf(join(logsDir, `agent-issue-${id}-gates-${id}.log`)) : undefined,
      now: Math.floor(Date.now() / 1000),
    };
  };
};

/**
 * `sandcastle herdr card --json <root> <id>`: the ticket card as `CardData`, with its tracker link, for the Herdr app
 * mod (#960). The root must hold a `.sandcastle/logs` folder and the id be a ticket id's characters: the mod passes
 * a row's id, and nothing here runs the project's config.
 */
export const cardJson = async (root: string | undefined, id: string | undefined): Promise<CardData> => {
  if (!root || !id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new OperatorError("Usage: sandcastle herdr card --json <project root> <ticket id>");
  const logsDir = join(root, ".sandcastle", "logs");
  if (!existsSync(logsDir) || !statSync(logsDir).isDirectory()) throw new OperatorError(`No .sandcastle/logs in ${root}.`);
  const { slug } = await import("./tracker.ts");
  const facts = await cardFactsOf(logsDir, id);
  return cardData({ ...facts(), tracker: trackerLink(root, id, slug) });
};

/** The card pane (`entry.sh card`): draws the card for SANDCASTLE_LOG's ticket and reads keys until it closes. */
const cardPane = async (logPath: string | undefined) => {
  const log = logPath ? logOf(pathToFileURL(logPath).href) : undefined;
  if (!log) {
    console.error("That is not a sandcastle log.");
    process.exitCode = 1;
    return;
  }
  const [{ logOwner }, { slug }] = await Promise.all([import("./run.ts"), import("./tracker.ts")]);
  const logsDir = dirname(log);
  const root = dirname(dirname(logsDir));
  const id = logOwner(basename(log));
  // The pager the log popup has always used, with its options and words (entry.sh's `log`).
  const page = (file: string, fromCard = true) =>
    spawnSync("sh", [join(PLUGIN_DIR, "entry.sh"), "log"], { stdio: "inherit", env: { ...process.env, SANDCASTLE_LOG: file, ...(fromCard ? { SANDCASTLE_FROM_CARD: "1" } : {}) } });
  // A log named by hand, or no terminal to read keys from: the log itself, as before.
  if (!id || !process.stdin.isTTY) {
    page(log, false);
    return;
  }
  let tracker: string | undefined;
  const facts = await cardFactsOf(logsDir, id);
  const stdin = process.stdin;
  let card = ticketCard({ ...facts(), tracker });
  const draw = () => {
    card = ticketCard({ ...facts(), tracker });
    process.stdout.write(`\x1b[?25l\x1b[H\x1b[2J${card.text}\n`);
  };
  // Ctrl-C closes the pager (less -K) and reaches this process too: the card must outlive it.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  await new Promise<void>((done) => {
    const onKey = (data: Buffer) => {
      const action = cardKey(data.toString("utf8"), card.logs.length);
      if (!action) return;
      if (action.kind === "close") {
        stdin.off("data", onKey);
        process.stdout.off("resize", draw);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\x1b[?25h");
        return done();
      }
      if (action.kind === "tracker") tracker = trackerLink(root, id, slug);
      else {
        // The pager reads the terminal alone: this process reads nothing while spawnSync waits.
        stdin.off("data", onKey);
        stdin.setRawMode(false);
        stdin.pause();
        page(join(logsDir, card.logs[action.index]));
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onKey);
      }
      draw();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
    process.stdout.on("resize", draw);
    draw();
  });
  process.off("SIGINT", ignore);
};

// ---------------------------------------------------------------------------
// "Sandboxes first" in the Agents panel. Herdr has one such view at a time and no CLI for
// it, so it goes over the socket. Owned by the plugin: Herdr drops it when the plugin is
// disabled or unlinked, and a restart forgets it, which the startup hook puts back.
// ---------------------------------------------------------------------------

const VIEW = {
  source: `plugin:${PLUGIN_ID}`,
  label: "sandboxes first",
  // What needs attention first, as Herdr's own order has it - a blocked agent of any kind
  // above an idle sandbox - and within that, sandboxes (a token's missing values sort after
  // present ones, and only sandboxes report `sc_run`). Nothing is hidden.
  sort: [
    { field: "attention", order: "desc" },
    { field: { token: "sc_run" }, order: "asc" },
    { field: "state_change_seq", order: "desc" },
  ],
};

// A handoff can close the socket without an answer, and a hung server never sends one: the
// startup hook and the key must not wait forever.
const request = (method: string, params: object, timeoutMs = 5000) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const path = process.env.HERDR_SOCKET_PATH;
    if (!path) return reject(new OperatorError("Not inside Herdr (no HERDR_SOCKET_PATH)."));
    const c = createConnection(path, () => c.write(JSON.stringify({ id: "sandcastle", method, params }) + "\n"));
    const timer = setTimeout(() => {
      c.destroy();
      reject(new OperatorError(`herdr ${method}: no answer in ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      c.end();
      try {
        const r = JSON.parse(buf.slice(0, nl));
        if (r.error) reject(new OperatorError(`herdr ${method}: ${r.error.message}`));
        else resolve(r.result);
      } catch {
        reject(new OperatorError(`herdr ${method}: an answer that is not JSON.`));
      }
    });
    // After an answer this rejects a settled promise, which does nothing.
    c.on("close", () => {
      clearTimeout(timer);
      reject(new OperatorError(`herdr ${method}: the connection closed without an answer.`));
    });
    c.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

// In the plugin's state directory, which Herdr keeps under its state home; `configure
// --remove` finds it there without Herdr's environment.
const viewFlag = () =>
  join(process.env.HERDR_PLUGIN_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "herdr/plugins", PLUGIN_ID), "sandboxes-first");

const view = async (how: "toggle" | "reapply") => {
  const flag = viewFlag();
  if (how === "reapply") {
    if (existsSync(flag)) await request("agent.view.set", VIEW);
    return;
  }
  if (existsSync(flag)) {
    // Only ours: a view another plugin set since stays.
    await request("agent.view.clear", { source: VIEW.source });
    rmSync(flag, { force: true });
  } else {
    await request("agent.view.set", VIEW);
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(flag, "");
  }
};

export const herdrCommand = async (args: string[]) => {
  const [verb, ...rest] = args;
  // Before any verb: `configure --help` must not edit Herdr's config.
  if (wantsHelp(args)) return console.log(helpFor("herdr"));
  // The plugin's verbs answer Herdr TUI (its tab bar, actions and popups), which runs them from its own
  // daemonised server, never under a core terminal. Typed in a herdr-core terminal they have nothing to act on;
  // `configure` still links the plugin for Herdr TUI's tabs.
  // `card --json` answers the Herdr app mod, which runs it from the app: no terminal host is involved.
  const appVerb = verb === "card" && rest[0] === "--json";
  if (verb && verb !== "configure" && !appVerb && terminalHost().kind === "core") {
    return console.log(`\`sandcastle herdr ${verb}\` is a Herdr TUI plugin verb, and this is a herdr-core terminal: nothing to do here.`);
  }
  switch (verb) {
    case "configure": {
      // Every argument checked: a flag a kit does not know was ignored, so `--app --yes` did both halves.
      const unknown = rest.filter((a) => !["--app", "--tui", "--remove", "--yes"].includes(a));
      if (unknown.length) throw new OperatorError(`Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(" ")}. ${CONFIGURE_USAGE}`);
      return configure(rest.includes("--remove"), rest.includes("--yes"), false, KIT, { app: rest.includes("--app"), tui: rest.includes("--tui") });
    }
    case "line": {
      // A live run's own tab after a Herdr restart gets its status view back on the next tick.
      const line = runsLine(undefined, undefined, undefined, replaceDeadTab, (root) => void restartStatusView(root));
      if (!line) return;
      console.log(line);
      // Only while live runs keep the tab bar ticking: with none, it does not start the kit at all.
      tellAwaiting();
      return;
    }
    case "open": {
      const kind = rest[0];
      if (kind !== "status" && kind !== "report") throw new OperatorError("Usage: sandcastle herdr open status|report");
      const { root, why } = contextProject();
      if (!root) return notify(why ?? "No sandcastle project here.");
      openPane(kind, root);
      return;
    }
    case "open-log": {
      const log = logOf(process.env.HERDR_PLUGIN_CLICKED_URL);
      if (!log) return notify("That link is not a sandcastle log.");
      openPane("log", dirname(dirname(dirname(log))), { SANDCASTLE_LOG: log });
      return;
    }
    case "card":
      if (appVerb) return console.log(JSON.stringify(await cardJson(rest[1], rest[2])));
      return cardPane(process.env.SANDCASTLE_LOG);
    case "view":
      return view(rest[0] === "reapply" ? "reapply" : "toggle");
    case "startup":
      // First: putting the Agents view back throws outside Herdr, or on a server slow to answer.
      requeueAwaiting();
      return view("reapply");
    default:
      throw new OperatorError(`${CONFIGURE_USAGE} The plugin's own verbs: line, open, open-log, card, view, startup.`);
  }
};

// bin/sandcastle runs `sandcastle herdr ...` here, not through cli.ts: the tab bar asks for
// a line every 10 seconds, and the whole CLI takes three times as long to load.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await herdrCommand(process.argv.slice(3));
  } catch (error) {
    if (!(error instanceof OperatorError)) throw error;
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}
