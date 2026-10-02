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
// status view or the report as a popup over any tab, Ctrl-click on a ticket for its log,
// and "sandboxes first" in the Agents panel - and `configure` adds the sidebar rows that
// show the tokens a run reports (src/herdr.ts).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm } from "./autonomy.ts";
import { CONFIG_PATH } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { herdr, lineText, runCounts, RUNS_DIR } from "./herdr.ts";
import type { TicketRecord } from "./run.ts";
import { KIT } from "./sandbox.ts";

export const PLUGIN_ID = "sandcastle-kit";
export const PLUGIN_DIR = join(KIT, "herdr");

// Where Herdr reads its config: HERDR_CONFIG_PATH, else under XDG_CONFIG_HOME, else ~/.config.
export const herdrConfigPath = (env: NodeJS.ProcessEnv = process.env) =>
  env.HERDR_CONFIG_PATH ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr", "config.toml");

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

# Every live run on this machine, at the right of the tab row.
[[ui.tab_bar_right]]
type = "command"
command = ${JSON.stringify(`${shellQuote(join(kit, "bin/sandcastle"))} herdr line`)}
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
  const own = withoutBlock(text);
  const found: string[] = [];
  if (/^\s*\[\s*ui\.sidebar(\.agents|\.spaces)?\s*\]/m.test(own) || /^\s*sidebar\s*[.=]/m.test(own)) found.push("sidebar rows (ui.sidebar.agents or ui.sidebar.spaces)");
  if (/tab_bar_right/.test(own)) found.push("tab bar entries (ui.tab_bar_right)");
  for (const key of ["prefix+shift+s", "prefix+shift+e", "prefix+shift+a"]) {
    if (own.toLowerCase().includes(`"${key}"`)) found.push(`the key ${key}`);
  }
  return found;
};

type Reload = { ok: true; diagnostics: unknown[] } | { ok: false; reason: string };
const reloadConfig = (): Reload => {
  const r = spawnSync("herdr", ["server", "reload-config"], { encoding: "utf8" });
  const text = (r.stdout || r.stderr).trim();
  try {
    const json = JSON.parse(text);
    if (json.error) return { ok: false, reason: json.error.code === "server_not_running" ? "not running" : json.error.message };
    return { ok: true, diagnostics: json.result?.diagnostics ?? [] };
  } catch {
    return { ok: false, reason: text || `exit ${r.status}` };
  }
};

const linked = () => {
  try {
    const list = JSON.parse(herdr(["plugin", "list", "--json"])).result.plugins as { plugin_id: string; plugin_root?: string }[];
    return list.find((p) => p.plugin_id === PLUGIN_ID);
  } catch {
    return undefined;
  }
};

/** For doctor: whether the plugin is linked from this checkout, and the block is in the config. */
export const pluginState = () => {
  const plugin = linked();
  const path = herdrConfigPath();
  return {
    linkedHere: !!plugin?.plugin_root && realpathSync(plugin.plugin_root) === realpathSync(PLUGIN_DIR),
    linkedFrom: plugin?.plugin_root,
    block: existsSync(path) && readFileSync(path, "utf8").includes(BEGIN),
  };
};

export const configure = async (remove: boolean, yes: boolean) => {
  if (spawnSync("herdr", ["--version"]).status !== 0) throw new OperatorError("Herdr is not installed (https://herdr.dev) - there is nothing to configure.");
  const path = herdrConfigPath();
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";

  if (remove) {
    const after = withoutBlock(before);
    if (after !== before) writeFileSync(path, after);
    const was = linked();
    if (was) herdr(["plugin", "unlink", PLUGIN_ID]);
    if (after === before && !was) {
      console.log(`Nothing to remove: no sandcastle-kit block in ${path}, and the plugin is not linked.`);
      return;
    }
    const reload = reloadConfig();
    console.log(`Removed${after !== before ? ` the sandcastle-kit block from ${path}` : ""}${after !== before && was ? " and" : ""}${was ? " the plugin" : ""}.${reload.ok ? " Herdr reloaded its config." : ""}`);
    return;
  }

  const conflicts = configConflicts(before);
  if (conflicts.length) {
    throw new OperatorError(
      `${path} already sets ${conflicts.join(", ")}. Merge this block into it by hand instead, keeping what you have:\n\n${configBlock()}\n\n` +
        "Then link the plugin: `herdr plugin link " + PLUGIN_DIR + "`.",
    );
  }
  console.log(
    `This will:\n  1. link the sandcastle-kit plugin from ${PLUGIN_DIR} (\`herdr plugin link\`; no build, a \`git pull\` of the kit updates it)\n` +
      `  2. add the block below to the end of ${path}\n  3. reload Herdr's config (nothing restarts; your panes are untouched)\n` +
      `\`sandcastle herdr configure --remove\` undoes all three.\n\n${configBlock()}\n`,
  );
  if (!yes) {
    const answer = await confirm("Go ahead? [y/N] ");
    if (answer === undefined) throw new OperatorError("Not a terminal: run it in one to answer, or pass --yes.");
    if (!answer) {
      console.log("Nothing changed.");
      return;
    }
  }
  const wasLinked = !!linked();
  herdr(["plugin", "link", PLUGIN_DIR]);
  mkdirSync(dirname(path), { recursive: true });
  if (before) writeFileSync(`${path}.sandcastle-kit.bak`, before);
  writeFileSync(path, withBlock(before));
  const reload = reloadConfig();
  if (reload.ok && reload.diagnostics.length) {
    // Herdr found something wrong with the result: put the user's config back as it was.
    writeFileSync(path, before);
    reloadConfig();
    if (!wasLinked) herdr(["plugin", "unlink", PLUGIN_ID]);
    throw new OperatorError(`Herdr refused the new config, so ${path} is back as it was:\n${JSON.stringify(reload.diagnostics, null, 2)}`);
  }
  console.log(
    `Done${reload.ok ? " - Herdr reloaded its config" : reload.reason === "not running" ? " - Herdr reads it when it next starts" : ` - reload failed (${reload.reason}); \`herdr server reload-config\` retries`}.` +
      `\n  prefix+shift+s  status view    prefix+shift+e  last run's report    prefix+shift+a  sandboxes first in Agents` +
      `\n  (the prefix is ctrl+b unless you changed it). Ctrl-click a ticket in the status view for its log.`,
  );
};

// ---------------------------------------------------------------------------
// The tab bar: one line for every live run, from the runs directory src/herdr.ts keeps.
// ---------------------------------------------------------------------------

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

type Run = { root: string; orchestrator?: string; pid?: number; startedAt?: string; finishedAt?: string; tickets?: Record<string, TicketRecord> };

/** Live runs, newest first. A file whose run has ended or died is removed. */
export const liveRuns = (dir = RUNS_DIR): Run[] => {
  const runs: Run[] = [];
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const file = join(dir, f);
    try {
      const root = readFileSync(file, "utf8").trim();
      const run = { root, ...JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")) } as Run;
      if (!run.finishedAt && run.pid && alive(run.pid)) {
        runs.push(run);
        continue;
      }
    } catch {
      /* no record: not a live run */
    }
    rmSync(file, { force: true });
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
};

export const runsLine = (dir = RUNS_DIR) => {
  const runs = liveRuns(dir);
  return runs.length ? `🏰 ${runs.map((r) => lineText(r.orchestrator ?? basename(r.root), runCounts(r.tickets ?? {}))).join("  |  ")}` : "";
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

/** The project the action is about: the focused pane's, else the newest live run's. */
export const contextProject = (context = process.env.HERDR_PLUGIN_CONTEXT_JSON, runs = () => liveRuns()) => {
  const ctx = JSON.parse(context || "{}") as { focused_pane_cwd?: string; workspace_cwd?: string };
  return projectAt(ctx.focused_pane_cwd) ?? projectAt(ctx.workspace_cwd) ?? runs()[0]?.root;
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

// A ticket's log, from a Ctrl-click in the status view. Only a log under some project's
// .sandcastle/logs is opened: the link handler's pattern says the same, and this is the
// check that holds whatever printed the link.
export const logOf = (url: string | undefined) => {
  if (!url?.startsWith("file://")) return undefined;
  const path = fileURLToPath(url);
  return /\/\.sandcastle\/logs\/[^/]+\.log$/.test(path) && existsSync(path) ? path : undefined;
};

// ---------------------------------------------------------------------------
// "Sandboxes first" in the Agents panel. Herdr has one such view at a time and no CLI for
// it, so it goes over the socket. Owned by the plugin: Herdr drops it when the plugin is
// disabled or unlinked, and a restart forgets it, which the startup hook puts back.
// ---------------------------------------------------------------------------

const VIEW = {
  source: `plugin:${PLUGIN_ID}`,
  label: "sandboxes first",
  // A token's missing values sort after present ones: sandboxes (they report `sc_run`)
  // first, then whatever needs attention. Nothing is hidden.
  sort: [
    { field: { token: "sc_run" }, order: "asc" },
    { field: "attention", order: "desc" },
    { field: "state_change_seq", order: "desc" },
  ],
};

const request = (method: string, params: object) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const path = process.env.HERDR_SOCKET_PATH;
    if (!path) return reject(new OperatorError("Not inside Herdr (no HERDR_SOCKET_PATH)."));
    const c = createConnection(path, () => c.write(JSON.stringify({ id: "sandcastle", method, params }) + "\n"));
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      c.end();
      const r = JSON.parse(buf.slice(0, nl));
      if (r.error) reject(new OperatorError(`herdr ${method}: ${r.error.message}`));
      else resolve(r.result);
    });
    c.on("error", reject);
  });

const viewFlag = () => join(process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".cache", "sandcastle-kit"), "sandboxes-first");

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
  switch (verb) {
    case "configure":
      return configure(rest.includes("--remove"), rest.includes("--yes"));
    case "line": {
      const line = runsLine();
      if (line) console.log(line);
      return;
    }
    case "open": {
      const kind = rest[0];
      if (kind !== "status" && kind !== "report") throw new OperatorError("Usage: sandcastle herdr open status|report");
      const root = contextProject();
      if (!root) return notify("No sandcastle project in the focused pane, and no run going.");
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
