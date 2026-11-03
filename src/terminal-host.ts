// Which terminal host a command runs in: herdr-core (`hc`), Herdr TUI (the `herdr` server), or
// neither. Asked lazily, by the commands that open or report into a host, never at import: the
// Claude Code mod runs `queue --json` and `--version --json` every few seconds and parses their stdout.

import { execFileSync } from "node:child_process";

/** The herdr-core terminal this process runs in, as `hc get` describes it. */
export type CoreTerminal = { address: string; pid: number; labels: Record<string, string> };
export type TerminalHost = { kind: "core"; terminal: CoreTerminal } | { kind: "herdr1" } | { kind: "none" };

export type HostProbe = {
  /** `hc get <id>`: the terminal's address, root pid and labels, or undefined when hc cannot say. */
  core(id: string): CoreTerminal | undefined;
  /** This process's ancestors' pids, nearest first. */
  ancestors(): number[];
};

/**
 * Herdr-core wins only when the terminal `HC_TERMINAL_ID` names is really ours: its root process is one of
 * this process's ancestors. Either host's variables can be stale - a core first started from a Herdr TUI
 * pane hands every terminal `HERDR_*`, and a Herdr TUI server started from a core terminal hands its panes
 * `HC_TERMINAL_ID` - and a stale id can still name a live terminal, so "hc answers" alone proves nothing.
 * Failing that, Herdr TUI by the rule the kit always used.
 */
export const detectHost = (env: NodeJS.ProcessEnv, probe: HostProbe): TerminalHost => {
  const id = env.HC_TERMINAL_ID;
  if (id) {
    const terminal = probe.core(id);
    if (terminal && probe.ancestors().includes(terminal.pid)) return { kind: "core", terminal };
  }
  return env.HERDR_ENV === "1" ? { kind: "herdr1" } : { kind: "none" };
};

// One answer per id: hc and ps are asked once a process, however often a command asks.
const cores = new Map<string, CoreTerminal | undefined>();
let lineage: number[] | undefined;

const hcGet = (id: string): CoreTerminal | undefined => {
  if (cores.has(id)) return cores.get(id);
  let terminal: CoreTerminal | undefined;
  try {
    // stderr captured: hc reports errors there as JSON, which must not leak into a command's output.
    const out = execFileSync("hc", ["get", id, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2000 });
    const t = JSON.parse(out) as { address?: unknown; pid?: unknown; labels?: unknown; state?: unknown };
    if (typeof t.address === "string" && typeof t.pid === "number" && t.state === "live") {
      const labels = t.labels && typeof t.labels === "object" ? (t.labels as Record<string, string>) : {};
      terminal = { address: t.address, pid: t.pid, labels };
    }
  } catch {
    /* no hc, no core, or not that terminal: not core */
  }
  cores.set(id, terminal);
  return terminal;
};

/** One `ps` for the whole table, walked here: a `ps` per generation would cost a spawn each. */
const psAncestors = (): number[] => {
  if (lineage) return lineage;
  lineage = [];
  try {
    const parent = new Map<number, number>();
    for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid > 0 && ppid >= 0) parent.set(pid, ppid);
    }
    const seen = new Set<number>();
    for (let p = parent.get(process.pid); p !== undefined && p > 1 && !seen.has(p); p = parent.get(p)) {
      seen.add(p);
      lineage.push(p);
    }
  } catch {
    /* no ps: no ancestors, so not core */
  }
  return lineage;
};

export const PROBE: HostProbe = { core: hcGet, ancestors: psAncestors };

/**
 * The host a `--detach` parent found, handed to its child: the child is started in a session of its own and
 * outlives the parent, so its ancestors are no longer the core terminal's and its own probe would say Herdr TUI
 * or none. The child takes this once and never probes; anything it starts inherits nothing (`adoptHost`).
 */
export const HOST_ENV = "SANDCASTLE_TERMINAL_HOST";
let adopted: TerminalHost | undefined;

/** A snapshot read back, or undefined when it is not one `JSON.stringify(terminalHost())` wrote. */
export const parseHost = (text: string | undefined): TerminalHost | undefined => {
  try {
    const h = JSON.parse(text ?? "") as { kind?: unknown; terminal?: { address?: unknown; pid?: unknown; labels?: unknown } };
    if (h.kind === "herdr1" || h.kind === "none") return { kind: h.kind };
    const t = h.terminal;
    if (h.kind !== "core" || typeof t?.address !== "string" || !Number.isInteger(t.pid) || !t.labels || typeof t.labels !== "object") return undefined;
    const labels = Object.fromEntries(Object.entries(t.labels).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    return { kind: "core", terminal: { address: t.address, pid: t.pid as number, labels } };
  } catch {
    return undefined;
  }
};

/**
 * Removes the snapshot from `env` whatever it holds, so no process the kit starts inherits it, and in the
 * detached child (`take`) keeps a valid one as this process's host. A snapshot that does not parse is
 * dropped: the child detects for itself, as before the snapshot.
 */
export const adoptHost = (take: boolean, env: NodeJS.ProcessEnv = process.env): void => {
  const text = env[HOST_ENV];
  delete env[HOST_ENV];
  if (take) adopted = parseHost(text);
};

/** The host this process runs in. With no `HC_TERMINAL_ID` nothing is spawned: Herdr TUI and plain terminals decide on `HERDR_ENV` alone, as before. */
export const terminalHost = (env: NodeJS.ProcessEnv = process.env, probe: HostProbe = PROBE): TerminalHost => adopted ?? detectHost(env, probe);

/** Herdr TUI, the `herdr` server: what `IN_HERDR` meant before herdr-core, minus a core terminal's stale `HERDR_*`. */
export const inHerdr1 = (env: NodeJS.ProcessEnv = process.env, probe: HostProbe = PROBE): boolean => terminalHost(env, probe).kind === "herdr1";
