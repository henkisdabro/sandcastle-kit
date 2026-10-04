// The status view's click hint: which modifier opens a ticket's card in the terminal outside Herdr.
//
// A pane cannot see that terminal: Herdr's server gives every pane TERM_PROGRAM=herdr, and any
// terminal may attach to the long-lived server. The attached Herdr client process carries the
// terminal's environment, and a process of the same user can read it - so `sandcastle status`
// senses it once when it starts a view and hands status.sh one word (SANDCASTLE_CLICK_MOD). In
// iTerm2 Ctrl-click is macOS's right-click and never reaches Herdr; Cmd-click works there.
// Anything uncertain gets the fallback, which names both.

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { machineSettings, USER_CONFIG } from "./sandbox.ts";

export type ClickMod = "ctrl" | "cmd" | "fallback";
export type ClickSetting = "auto" | "ctrl" | "cmd";
export const CLICK_SETTINGS: readonly ClickSetting[] = ["auto", "ctrl", "cmd"];

// The note band's words for each; status.sh draws its own copy, which a test holds to these. Ctrl-click
// reaches Herdr, which opens the ticket's card; iTerm2 takes Cmd-click itself and opens the link, the raw log.
export const HINT_TEXT: Record<ClickMod, string> = {
  ctrl: "ctrl-click a ticket for its card",
  cmd: "cmd-click a ticket for its log",
  fallback: "ctrl-click a ticket for its card (iTerm2: cmd-click for its log)",
};

// The variables a terminal leaves in the environment of what it starts.
export const TERMINAL_KEYS = ["TERM_PROGRAM", "LC_TERMINAL", "VTE_VERSION", "KITTY_WINDOW_ID", "WEZTERM_EXECUTABLE"] as const;
export type TerminalEnv = Partial<Record<(typeof TERMINAL_KEYS)[number], string>>;

/** One client's terminal: its name where known, and the modifier only for those surveyed. */
export const terminalOf = (env: TerminalEnv): { name?: string; mod: ClickMod } => {
  const program = env.TERM_PROGRAM ?? "";
  if (env.LC_TERMINAL === "iTerm2" || program === "iTerm.app") return { name: "iTerm2", mod: "cmd" };
  if (program === "Apple_Terminal") return { name: "Terminal.app", mod: "ctrl" };
  if (program === "ghostty") return { name: "Ghostty", mod: "ctrl" };
  // Not yet surveyed: named, so doctor can say which, but given the fallback.
  if (env.WEZTERM_EXECUTABLE || program === "WezTerm") return { name: "WezTerm", mod: "fallback" };
  if (env.KITTY_WINDOW_ID || program === "kitty") return { name: "Kitty", mod: "fallback" };
  if (env.VTE_VERSION) return { name: "a VTE terminal", mod: "fallback" };
  return { name: program || undefined, mod: "fallback" };
};

export type Sensed = { mod: ClickMod; terminal?: string; why: string };

/** Every attached client's terminal in, one modifier out: only when they all call for the same one. */
export const sensedHint = (envs: TerminalEnv[]): Sensed => {
  if (!envs.length) return { mod: "fallback", why: "no Herdr client attached to this server was found" };
  const terminals = envs.map(terminalOf);
  const names = [...new Set(terminals.map((t) => t.name ?? "an unknown terminal"))];
  const mods = new Set(terminals.map((t) => t.mod));
  const terminal = names.join(", ");
  if (mods.size > 1) return { mod: "fallback", terminal, why: `clients attached from terminals that disagree (${terminal})` };
  const [mod] = mods;
  if (mod === "fallback") return { mod, terminal, why: `sensed ${terminal}, whose click the kit has not surveyed` };
  return { mod, terminal, why: `sensed ${terminal}` };
};

// ---------------------------------------------------------------------------
// The sensor: this user's Herdr clients attached to the view's server, and their environments.
// ---------------------------------------------------------------------------

/**
 * The session a client process attaches to: null for the default session (a bare `herdr`), its
 * name, or undefined when the process is no client. `herdr server` is excluded on purpose: its
 * environment is the terminal that first started it, not one looking at it now; so are `--remote`,
 * `remote-client-bridge` and every other subcommand.
 */
export const clientSession = (argv: string[]): string | null | undefined => {
  if (basename(argv[0] ?? "") !== "herdr") return undefined;
  if (argv.length === 1) return null;
  if (argv.length === 3 && argv[1] === "--session" && argv[2]) return argv[2];
  if (argv.length === 4 && argv[1] === "session" && argv[2] === "attach" && argv[3]) return argv[3];
  return undefined;
};

export type Proc = { argv: string[]; env: TerminalEnv };

const pickEnv = (pairs: Iterable<string>): TerminalEnv => {
  const env: TerminalEnv = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = pair.slice(0, eq) as (typeof TERMINAL_KEYS)[number];
    if (eq > 0 && TERMINAL_KEYS.includes(key)) env[key] = pair.slice(eq + 1);
  }
  return env;
};

/**
 * macOS's `ps -E -ww -o pid=,command=`: each line is the pid, the argv and then the environment,
 * all joined by spaces. The argv ends at the first NAME=value word; a client's argv has none.
 */
export const parsePsEnv = (out: string): Proc[] =>
  out.split("\n").flatMap((line) => {
    const words = line.trim().split(/\s+/).slice(1);
    const at = words.findIndex((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const argv = at < 0 ? words : words.slice(0, at);
    return argv.length ? [{ argv, env: pickEnv(at < 0 ? [] : words.slice(at)) }] : [];
  });

/** `herdr session list --json`: each session's name and socket path, and which is the default. */
export const parseSessions = (out: string): { name: string; socket: string; isDefault: boolean }[] => {
  const json = JSON.parse(out);
  const list = json?.result?.sessions ?? json?.sessions ?? json?.result ?? json;
  if (!Array.isArray(list)) return [];
  return list.flatMap((s) =>
    s && typeof s.name === "string" && typeof s.socket_path === "string"
      ? [{ name: s.name, socket: s.socket_path, isDefault: s.is_default === true || s.default === true || (s.is_default === undefined && s.default === undefined && s.name === "default") }]
      : [],
  );
};

const samePath = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
};

/** The clients attached to the server at `socket`, from the processes and the session list. */
export const attachedClients = (procs: Proc[], sessions: ReturnType<typeof parseSessions>, socket: string): TerminalEnv[] =>
  procs.flatMap((p) => {
    const session = clientSession(p.argv);
    if (session === undefined) return [];
    const entry = sessions.find((s) => (session === null ? s.isDefault : s.name === session));
    return entry && samePath(entry.socket, socket) ? [p.env] : [];
  });

// Short: the view waits on these before its first frame, and an answer that slow is no answer.
// `ps -E` lists every process's environment: over 1 MiB on a busy Mac, past spawnSync's default
// buffer, which cuts the listing and silently misses the Herdr client.
const QUICK: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] };

/**
 * Linux: procps prints no environment, so `ps -u <uid> -o pid=,args=` gives the pids and /proc
 * the exact argv and the environment of each that may be a client (a process of this user).
 */
export const linuxProcesses = (out: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): Proc[] =>
  out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!m || basename(m[2]) !== "herdr") return [];
    try {
      const argv = read(`/proc/${m[1]}/cmdline`).split("\0").filter(Boolean);
      return [{ argv, env: pickEnv(read(`/proc/${m[1]}/environ`).split("\0")) }];
    } catch {
      return []; // gone meanwhile
    }
  });

/** This user's processes, from one listing, with their argv and terminal variables. */
const herdrProcesses = (platform = process.platform): Proc[] => {
  const uid = String(process.getuid?.() ?? "");
  if (platform === "linux") return linuxProcesses(spawnSync("ps", ["-u", uid, "-o", "pid=,args="], QUICK).stdout ?? "");
  return parsePsEnv(spawnSync("ps", ["-E", "-ww", "-U", uid, "-o", "pid=,command="], QUICK).stdout ?? "");
};

/** The environments of the Herdr clients attached to this view's server; empty on any doubt. */
export const senseClients = (env: NodeJS.ProcessEnv = process.env): TerminalEnv[] => {
  const socket = env.HERDR_SOCKET_PATH;
  if (!socket) return [];
  const procs = herdrProcesses().filter((p) => clientSession(p.argv) !== undefined);
  if (!procs.length) return [];
  return attachedClients(procs, parseSessions(spawnSync("herdr", ["session", "list", "--json"], QUICK).stdout ?? ""), socket);
};

// ---------------------------------------------------------------------------
// The override, and the one answer status, doctor and configure share.
// ---------------------------------------------------------------------------

const isSetting = (v: unknown): v is ClickSetting => CLICK_SETTINGS.includes(v as ClickSetting);

/** What is wrong with config.json's `herdr` value, or undefined when it is absent or right. */
export const herdrSettingProblem = (value: unknown, file = "config.json"): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `"herdr" in ${file} is ${JSON.stringify(value)}, not an object like {"clickHint": "auto"}.`;
  const other = Object.keys(value).find((k) => k !== "clickHint");
  if (other) return `"herdr" in ${file} holds \`${other}\`; its only key is "clickHint".`;
  const hint = (value as { clickHint?: unknown }).clickHint;
  if (hint !== undefined && !isSetting(hint)) return `"herdr" in ${file} has "clickHint": ${JSON.stringify(hint)}, not "auto", "ctrl" or "cmd".`;
  return undefined;
};

export type ClickHint = Sensed & { source: string };

/**
 * The hint a status view shows. SANDCASTLE_CLICK_HINT wins over config.json's herdr.clickHint
 * (default auto); only auto senses. A bad value or a file that cannot be read gives the fallback,
 * never an error: the view must open whatever the settings hold.
 */
export const resolveClickHint = (
  env: NodeJS.ProcessEnv = process.env,
  machine: () => Record<string, unknown> = machineSettings,
  sense: (env: NodeJS.ProcessEnv) => TerminalEnv[] = senseClients,
): ClickHint => {
  try {
    const fromEnv = env.SANDCASTLE_CLICK_HINT;
    if (fromEnv) {
      if (!isSetting(fromEnv)) return { mod: "fallback", why: `SANDCASTLE_CLICK_HINT=${fromEnv} is not auto, ctrl or cmd`, source: "SANDCASTLE_CLICK_HINT" };
      if (fromEnv !== "auto") return { mod: fromEnv, why: `set by SANDCASTLE_CLICK_HINT=${fromEnv}`, source: "SANDCASTLE_CLICK_HINT" };
    } else {
      let herdr: unknown;
      try {
        herdr = machine().herdr;
      } catch {
        return { mod: "fallback", why: `${join(USER_CONFIG, "config.json")} could not be read`, source: "config.json" };
      }
      if (herdrSettingProblem(herdr)) return { mod: "fallback", why: `config.json's "herdr" value is not valid`, source: "config.json" };
      const hint = (herdr as { clickHint?: ClickSetting } | undefined)?.clickHint ?? "auto";
      if (hint !== "auto") return { mod: hint, why: `set by "herdr": {"clickHint": "${hint}"} in config.json`, source: "config.json" };
    }
    if (!env.HERDR_SOCKET_PATH) return { mod: "fallback", why: "not inside Herdr (no HERDR_SOCKET_PATH)", source: "sensor" };
    return { ...sensedHint(sense(env)), source: "sensor" };
  } catch (error) {
    return { mod: "fallback", why: `the sensor failed (${(error as Error).message})`, source: "sensor" };
  }
};

/** doctor's and configure's one line: what the view will show, why, and how to change it. */
export const clickHintLine = (hint: ClickHint) =>
  `info status view's click hint: "${HINT_TEXT[hint.mod]}" - ${hint.why}. ` +
  `Override: SANDCASTLE_CLICK_HINT=ctrl or cmd, or "herdr": {"clickHint": "ctrl" | "cmd"} in ${join(USER_CONFIG, "config.json")} ("auto" senses).`;
