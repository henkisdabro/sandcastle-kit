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
// status view (an overlay) or the report (a popup) over any tab, Ctrl-click on a ticket for its log,
// and "sandboxes first" in the Agents panel - and `configure` adds the sidebar rows that
// show the tokens a run reports (src/herdr.ts).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm } from "./autonomy.ts";
import { CONFIG_PATH } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { helpFor, wantsHelp } from "./help.ts";
import { herdr, lineText, runCounts, tellDeadTab } from "./herdr.ts";
import { commandOf, PLUGIN_MARKER, RUNS_DIR } from "./live-runs.ts";
import { liveness, type Probe } from "../mod/hooks/run-live.ts";
import { readTickets, type TicketRecord } from "../mod/hooks/run-record.ts";
import { KIT } from "./sandbox.ts";

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
# Herdr's default sidebar rows, plus one. A row whose tokens nobody reports disappears, so
# other agents and spaces look as before: the extra row is a sandbox's step and how long it
# has been at it, and a run's progress under its space.
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  ["$sc_phase", { token = "$sc_elapsed", dim = true }],
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

/** `byDefault`: the answer when the user just presses Enter (setup offers the plugin as a yes). */
export const configure = async (remove: boolean, yes: boolean, byDefault = false) => {
  if (spawnSync("herdr", ["--version"]).status !== 0) throw new OperatorError("Herdr is not installed (https://herdr.dev) - there is nothing to configure.");
  const path = herdrConfigFile();
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const plugin = pluginState();

  if (remove) {
    // A link from another checkout stays, so the status view's links stay with it.
    if (!plugin.linkedFrom || plugin.linkedHere) rmSync(PLUGIN_MARKER, { force: true });
    const after = withoutBlock(before);
    if (after !== before) writeFileSync(path, after);
    // Only this checkout's link: the one in use may be another clone's or worktree's. Herdr
    // drops the plugin's Agents view with the link, so its "on" flag goes too: left behind,
    // a later link's startup hook put the view back, and the next key turned it off.
    if (plugin.linkedHere) {
      herdr(["plugin", "unlink", PLUGIN_ID]);
      rmSync(viewFlag(), { force: true });
    } else if (plugin.linkedFrom) console.log(`The plugin is linked from another checkout (${plugin.linkedFrom}), so it stays linked: \`sandcastle herdr configure --remove\` there unlinks it.`);
    if (after === before && (before.includes(`"${PLUGIN_ID}.`) || before.includes("herdr line"))) {
      console.log(`${path} has sandcastle-kit entries outside its marker lines (a tool may have rewritten the file): delete them by hand.`);
    }
    const done = [...(after !== before ? [`the sandcastle-kit block from ${path}`] : []), ...(plugin.linkedHere ? ["the plugin"] : [])];
    if (!done.length) {
      console.log(`Nothing to remove from this checkout: no sandcastle-kit block in ${path}, and the plugin is not linked from here.`);
      return;
    }
    const reload = reloadConfig();
    console.log(`Removed ${done.join(" and ")}.${reload.ok ? " Herdr reloaded its config." : ""}`);
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
      `\`sandcastle herdr configure --remove\` undoes all three.\n\n${configBlock()}\n`,
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
  if (elsewhere) herdr(["plugin", "unlink", PLUGIN_ID]);
  herdr(["plugin", "link", PLUGIN_DIR]);
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
    if (!plugin.linkedHere) herdr(["plugin", "unlink", PLUGIN_ID]);
    if (elsewhere) herdr(["plugin", "link", elsewhere]);
    throw new OperatorError(
      `Herdr did not take the new config, so ${path} and the plugin link are back as they were:\n` +
        (reload.ok ? JSON.stringify(reload.diagnostics, null, 2) : reload.reason),
    );
  }
  mkdirSync(dirname(PLUGIN_MARKER), { recursive: true });
  writeFileSync(PLUGIN_MARKER, PLUGIN_DIR);
  console.log(
    `Done${reload.ok ? " - Herdr reloaded its config" : ". Herdr is not running: it reads the block when it starts, and if it reports a problem then, `sandcastle herdr configure --remove` takes the block out"}.` +
      `\n  prefix+shift+s  status view    prefix+shift+e  last run's report    prefix+shift+a  sandboxes first in Agents` +
      `\n  (the prefix is ctrl+b unless you changed it). Ctrl-click a ticket in the status view for its log.`,
  );
};

// ---------------------------------------------------------------------------
// The tab bar: one line for every live run, from the runs directory src/herdr.ts keeps.
// ---------------------------------------------------------------------------

type Run = { root: string; orchestrator?: string; pid?: number; startedAt?: string; finishedAt?: string; share?: number; tickets?: Record<string, TicketRecord> };

/**
 * Live runs, newest first. A file whose run has ended or died - or whose pid is some other process now - is removed,
 * after `ended` has been told the root of a run whose record says so: its file is the last
 * sign of it, and the tab bar does not tick again for a run that is not registered. So `ended`
 * returning true keeps the file, for a tab still waiting to be told (`tellDeadTab`).
 */
export const liveRuns = (dir = RUNS_DIR, probe: Probe = commandOf, ended: (root: string) => boolean | void = () => {}): Run[] => {
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
    try {
      root = readFileSync(file, "utf8").trim();
      seen = readRecord(root);
      const record = JSON.parse(seen ?? "");
      const run = { root, ...record, tickets: readTickets(record) } as Run;
      if (liveness({ record: run }, probe).state === "live") {
        runs.push(run);
        continue;
      }
      if (ended(root)) continue;
    } catch {
      /* no record: not a live run */
    }
    // The file is named by the project, so a new run of it registers under the same name: a record
    // that changed since it was judged is that run's, and its file stays for the next reader.
    if (root !== undefined && readRecord(root) !== seen) continue;
    rmSync(file, { force: true });
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
};

// Whichever reader of the runs directory drops a dead run's file first tells the tab: the tab bar's
// next tick would find no file. A tab whose status view still runs keeps the file until it can be told.
export const replaceDeadTab = (root: string, kit?: string) => tellDeadTab(root, kit) === "showing";

/** The run of the focused pane's project first (Herdr gives the tab bar its cwd), then the newest. */
export const runsLine = (dir = RUNS_DIR, focusedCwd = process.env.HERDR_ACTIVE_PANE_CWD, probe: Probe = commandOf, ended?: (root: string) => boolean | void) => {
  const here = (r: Run) => !!focusedCwd && (focusedCwd === r.root || focusedCwd.startsWith(`${r.root}/`));
  const runs = liveRuns(dir, probe, ended).sort((a, b) => Number(here(b)) - Number(here(a)));
  return runs.length ? `♜ ${runs.map((r) => lineText(r.orchestrator ?? basename(r.root), runCounts(r.tickets ?? {}), Number.isInteger(r.share) ? r.share : undefined)).join("  |  ")}` : "";
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

// A ticket's log, from a Ctrl-click in the status view. Herdr routes a matching link from
// any pane, and an agent's log shown in a sandbox pane can print one, so the link proves
// nothing: what opens is a regular file whose real path, symlinks resolved, is a log under
// some project's .sandcastle/logs. entry.sh pages it with LESSSECURE (no shell, no editor).
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
  switch (verb) {
    case "configure":
      return configure(rest.includes("--remove"), rest.includes("--yes"));
    case "line": {
      const line = runsLine(undefined, undefined, undefined, replaceDeadTab);
      if (line) console.log(line);
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
      openPane("log", dirname(log), { SANDCASTLE_LOG: log });
      return;
    }
    case "view":
      return view(rest[0] === "reapply" ? "reapply" : "toggle");
    case "startup":
      return view("reapply");
    default:
      throw new OperatorError("Usage: sandcastle herdr configure [--remove] [--yes]. The plugin's own verbs: line, open, open-log, view, startup.");
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
