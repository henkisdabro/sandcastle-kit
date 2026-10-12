// The status view's snapshot (GLOSSARY.md): everything the view knows at one moment - the run record and
// its tickets, the logs' last activity, the branches, the sandboxes, the machine pool and the queue - read
// from the project's `.sandcastle/`, git, `docker` and `sandcastle queue --json`. Every frame is drawn from a
// snapshot (src/status-rows.ts, src/status-render.ts), never from the sources themselves.
//
// Read synchronously, one source after another, for now: the collectors that refresh each source in the
// background come later (#706). The queue is a child process, as status.sh runs it: the tracker and blocker
// code is synchronous and is never imported into the view (ADR 0003).
//
// The record is a file in a repository, so each field is read on its own and checked: one a newer or older
// kit wrote in another shape empties only itself, as status.sh's one-jq read does.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isKit, liveness } from "../mod/hooks/run-live.ts";
import { readTickets, type RunRecord, type TicketRecord, type TicketState } from "../mod/hooks/run-record.ts";
import { commandOf, KIT_CACHE, PLUGIN_MARKER } from "./live-runs.ts";

/** One outcome of outcomes.json, as the view reads it: the run that wrote it, its kind (none from an older kit) and its line. */
export type OutcomeFact = { run: string; kind: string; text: string };

/** One agent log: its file name under `logs/` and when it last changed (epoch seconds). */
export type LogFact = { name: string; mtime: number };

/** What a log the view shows says: its last line worth reading, and whether it ends saying the plan's allowance is spent. */
export type LogTail = { activity: string; limit: boolean };

/** One ticket's branch, `agent/issue-<id>`, as git has it. */
export type BranchFact = {
  exists: boolean;
  /** Commits over the base; absent when git could not count them (no branch). */
  commits?: number;
  /** The branch's tip is on the base: a branch with nothing over it, or one merged by hand. */
  onBase: boolean;
  /** Every commit has an equal patch on the base (a rebased landing); asked only of a branch with commits that the view infers. */
  equalPatches?: boolean;
  /** The kit's merge of the ticket on the base, newest first: when, its subject, and the commits it landed (a squash is one). */
  landing?: { at: number; subject: string; commits?: number };
  /** For a branch on the base: its merge (or its tip) is on origin's base too, so the push happened. */
  pushed?: boolean;
};

/** One sandbox container's reading, keyed by the ticket whose worktree it mounts. */
export type ContainerFact = { cpu: string; mem: string; hot: boolean };

/** One queued ticket, as `sandcastle queue --json` lists it. */
export type QueueFact = { id: string; updated?: number; blockedOn: string[] };

/** The run settings a settings row draws from, and whose they are: the live run's, the next run's, or the last run's. */
export type SettingsFact = { from: "live" | "next run" | "last run"; settings: Record<string, unknown> | undefined };

export type Snapshot = {
  /** Epoch seconds the snapshot was read at: every age in the frame is measured from it. */
  now: number;
  /** The project root, and its `.sandcastle` directory as status.sh's `$PWD` (links point into it). */
  root: string;
  dir: string;
  name: string;
  base: string;
  /** Whether a run record exists, and what it holds (an unreadable one is an empty record). */
  hasRecord: boolean;
  record: RunRecord;
  /** The record's tickets, each state checked against the closed set. */
  tickets: Record<string, TicketRecord>;
  /** The run's process is running and its record has not finished (mod/hooks/run-live.ts). */
  live: boolean;
  outcomes: Record<string, OutcomeFact>;
  logs: LogFact[];
  /** What the logs a row may show say, by file name. */
  tails: Record<string, LogTail>;
  /** Tickets whose worktree directory exists. */
  worktrees: string[];
  branches: Record<string, BranchFact>;
  containers: Record<string, ContainerFact>;
  /** The host's cores, against which a container's CPU is shown. */
  cpus: number;
  pool: { sandboxes: { used: number; limit: string }; gates: { used: number; limit: string } };
  /** The queue's tickets, in version order; `error` says why it could not be read (and then it is empty). */
  queue: { tickets: QueueFact[]; error?: string };
  /** Commits on the base that its upstream lacks, by the last fetch. */
  unpushed: number;
  settings?: SettingsFact;
  /** The models line: a live run's, else the next run's (`SANDCASTLE_MODELS`), else the last run's. */
  models: string;
  /** The last lines of a detached run's output, while it is live. */
  runOutput: string[];
  /** Whether ticket ids link to their logs (OSC 8), and the click hint's modifier. */
  links: boolean;
  clickMod: string;
};

const git = (dir: string, args: string[]): string | undefined => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `sort -V` on ticket ids: digit runs compared as numbers, the rest as text. */
export const versionOrder = (a: string, b: string): number => {
  const parts = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [p, q] = [x[i]!, y[i]!];
    const numeric = /^\d/.test(p) && /^\d/.test(q);
    const c = numeric ? Number(p) - Number(q) : p < q ? -1 : p > q ? 1 : 0;
    if (c !== 0) return c;
  }
  return x.length - y.length;
};

// A log is agent-issue-<id>-<phase>-<id>.log: the id appears twice, and the repeat tells a ticket called
// "code-review-01" from the phase "review". A hand-suffixed branch's log (agent-issue-12-closeout-impl-12)
// falls back to the first phase word. status.sh `log_ids`.
const PHASE_REPEAT = /^-(impl|resolve|review-codex|review|repair|gates)-/;
/** The ticket id of a log's file name, or undefined when it is not an agent log. */
export const logTicket = (name: string): string | undefined => {
  if (!name.startsWith("agent-issue-") || !name.endsWith(".log")) return undefined;
  const s = name.slice("agent-issue-".length, -".log".length);
  for (let i = 1; i < s.length; i++) {
    const rest = s.slice(i);
    const m = PHASE_REPEAT.exec(rest);
    if (m && rest.slice(m[0].length) === s.slice(0, i)) return s.slice(0, i);
  }
  const m = /-(impl|resolve|review|repair|gates)-/.exec(s);
  return m && m.index > 0 ? s.slice(0, m.index) : undefined;
};

const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** The logs matching shell globs, newest first (`ls -t`: ties by name). */
export const newestLogs = (logs: LogFact[], patterns: string[]): LogFact[] => {
  const res = patterns.map(glob);
  return logs.filter((l) => res.some((re) => re.test(l.name))).sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** The log a step of the record writes (burndown.ts, herdr.ts). */
export const phaseLog = (id: string, state: string) => `agent-issue-${id}-${state === "implement" ? "impl" : state === "cross-review" ? "review-codex" : state}-${id}.log`;

/** The newest log of a ticket's pipeline phases: what an inferred row is read from. */
export const latestPhaseLog = (logs: LogFact[], id: string): LogFact | undefined =>
  newestLogs(logs, ["impl", "resolve", "review", "repair", "gates"].map((p) => `agent-issue-${id}-${p}-*.log`))[0];

/** The newest log of any kind of a ticket: what its link opens. */
export const latestLog = (logs: LogFact[], id: string): LogFact | undefined => newestLogs(logs, [`agent-issue-${id}-*-${id}.log`])[0];

const FRAMING = /^(Agent|Run|Capturing|Collecting|Syncing|Context)/;

/** The last line of a log that says something, made readable: the raw line is agent transcript, not a status. status.sh `log_activity`. */
export const activityOf = (text: string): string => {
  const lines = text.split("\n").filter((l) => !/^\s*$/.test(l) && !FRAMING.test(l));
  const last = lines.at(-1);
  if (last === undefined) return "";
  const said = last
    .replace(/^<promise>COMPLETE<\/promise>$/, "agent finished")
    .replace(/^<promise>.*<\/promise>$/, "agent reported back")
    .replace(/^No commits to sync out.*/, "nothing to sync out")
    .replace(/^Bash\((.*)/, "$ $1")
    .replace(/^(Read|Edit|Write|Grep|Glob)\((.*)/, "$1 $2")
    .replace(/\)$/, "")
    .replace(/^[-*|>\s]+/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .replace(/^ /, "");
  return [...said].slice(0, 200).join("");
};

/**
 * Whether a log ends saying the plan's allowance is spent. A `! error` or `! exit N` line quotes a failed
 * tool's output, which can say "usage limit" too, so it is skipped. status.sh `log_says_limit`.
 */
export const saysLimit = (text: string): boolean => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-12).filter((l) => !/^! (error|exit -?[0-9]+)(: |$)/.test(l)).slice(-5);
  return /out of usage credits|usage limit|limit reached/i.test(tail.join("\n"));
};

// The end of a log is what a row shows; a log can be megabytes of transcript.
const TAIL_BYTES = 64 * 1024;
const readTail = (file: string): string | undefined => {
  try {
    const text = readFileSync(file);
    return text.subarray(Math.max(0, text.length - TAIL_BYTES)).toString("utf8");
  } catch {
    return undefined;
  }
};

/** A whole number of seconds from a record's field (a number, or digits as text), or undefined. */
export const whole = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return Number(v);
  return undefined;
};

const WORKING: readonly string[] = ["setup", "implement", "resolve", "review", "cross-review", "gates", "repair"];

/**
 * When a live run ends, as status.sh's header says it: the queued tickets at a typical issue's length each,
 * the working ones at what is left of theirs (a minute at least), over the sandboxes the run uses at once; and
 * no earlier than the tickets not yet landed times a ticket's usual landing gates. Only while the run is
 * running and has a typical issue.
 */
export const runEnds = (record: RunRecord, tickets: Record<string, TicketRecord>, now: number): number | undefined => {
  const typical = isObject(record.typical) ? record.typical : {};
  const t = typical.issue;
  if (typeof t !== "number" || record.stage !== "running") return undefined;
  const all = Object.values(tickets);
  const q = all.filter((x) => x.state === "queued").length;
  const a = all
    .filter((x) => WORKING.includes(x.state ?? "") && typeof (x.attemptStarted ?? x.started) === "number")
    .reduce((sum, x) => sum + Math.max(t - (now - (x.attemptStarted ?? x.started)!), 60), 0);
  const n = all.filter((x) => [...WORKING, "queued", "ready", "landing"].includes(x.state ?? "")).length;
  const concurrency = typeof record.concurrency === "number" ? record.concurrency : 1;
  const landingGates = typeof typical["landing gates"] === "number" ? (typical["landing gates"] as number) : 0;
  return Math.floor(Math.max(now + (q * t + a) / Math.max(concurrency, 1), now + n * landingGates));
};

/** Sandboxes a live run has yet to fill: queued tickets that fit in them start at once. */
export const freeSlots = (record: RunRecord, tickets: Record<string, TicketRecord>): number => {
  const concurrency = typeof record.concurrency === "number" ? record.concurrency : 1;
  return Math.max(concurrency - Object.values(tickets).filter((t) => WORKING.includes(t.state ?? "")).length, 0);
};

const readOutcomes = (file: string): Record<string, OutcomeFact> => {
  const raw = readJson(file);
  if (!isObject(raw)) return {};
  const text = (v: unknown) => (v === undefined || v === null || v === false ? "" : typeof v === "string" ? v : JSON.stringify(v));
  return Object.fromEntries(
    Object.entries(raw).map(([id, e]) => {
      const o = isObject(e) ? e : {};
      return [id, { run: text(o.run), kind: text(o.kind), text: text(o.text) || text(o.outcome) }];
    }),
  );
};

// The container name is a bare UUID with no labels, so the only thing tying it to a ticket is the worktree it
// bind-mounts - and only a worktree of this project: another project's run can have the same ticket number.
const readContainers = (dir: string, cpus: number): Record<string, ContainerFact> => {
  const docker = (args: string[]) => {
    const r = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
    return r.status === 0 ? r.stdout : "";
  };
  const ids = docker(["ps", "-q", "--filter", "name=sandcastle-"]).split("\n").filter(Boolean);
  if (!ids.length) return {};
  const owner = new Map<string, string>();
  const prefix = `${dir}/worktrees/agent-issue-`;
  for (const line of docker(["inspect", ...ids, "--format", "{{.Name}}{{range .Mounts}}|{{.Source}}{{end}}"]).split("\n")) {
    const [name, ...mounts] = line.split("|");
    if (!name) continue;
    const mount = mounts.find((m) => m.includes(prefix));
    const ticket = mount?.match(/.*\/worktrees\/agent-issue-([a-z0-9][a-z0-9-]*)/)?.[1];
    if (ticket) owner.set(name.replace(/^\//, ""), ticket);
  }
  const out: Record<string, ContainerFact> = {};
  for (const line of docker(["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}", ...ids]).split("\n")) {
    const [name, cpu = "", mem = ""] = line.split("|");
    const ticket = name ? owner.get(name) : undefined;
    if (!ticket) continue;
    // "275.8MiB / 11.73GiB" -> "276M"; a GiB figure under 10 keeps a decimal: "2.1GiB" -> "2.1G".
    const used = (mem.split("/")[0] ?? "").trim().replace(/iB$/, "");
    const unit = used.slice(-1);
    const amount = parseFloat(used.slice(0, -1)) || 0;
    // "1399.02%" -> "14.0c", hot past 80% of the host's cores.
    const cores = (parseFloat(cpu.replace(/%$/, "")) || 0) / 100;
    out[ticket] = { cpu: `${cores.toFixed(1)}c`, mem: `${unit === "G" && amount < 10 ? amount.toFixed(1) : amount.toFixed(0)}${unit}`, hot: cores >= cpus * 0.8 };
  }
  return out;
};

// docker reports CPU against one core, so 1399% is ~14 cores: shown as cores against the host's.
const hostCpus = (): number => {
  for (const [command, args] of [["sysctl", ["-n", "hw.ncpu"]], ["nproc", []]] as const) {
    const r = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const n = Number(r.stdout?.trim());
    if (r.status === 0 && Number.isFinite(n) && n > 0) return n;
  }
  return 1;
};

// Machine-wide slots (src/pool.ts): one lock file per slot, its owner's pid first. A slot counts while its owner
// is a process of the kit (pool.ts `holderRunning`); when `ps` cannot say, while the process exists.
const readPool = (env: NodeJS.ProcessEnv): Snapshot["pool"] => {
  const dir = join(KIT_CACHE, "slots");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    // no slots taken yet
  }
  const seen = new Map<number, boolean>();
  const alive = (pid: number) => {
    if (!seen.has(pid)) {
      const command = commandOf(pid);
      let exists = command !== undefined;
      if (!exists) {
        try {
          process.kill(pid, 0);
          exists = true;
        } catch (error) {
          exists = (error as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      seen.set(pid, command !== undefined ? isKit(command) : exists);
    }
    return seen.get(pid)!;
  };
  const used = (pool: string) =>
    files
      .filter((f) => f.startsWith(`${pool}-`) && f.endsWith(".lock"))
      .filter((f) => {
        let pid = "";
        try {
          pid = readFileSync(join(dir, f), "utf8").split(" ")[0]!.trim();
        } catch {
          return false;
        }
        return /^[0-9]+$/.test(pid) && alive(Number(pid));
      }).length;
  return {
    sandboxes: { used: used("sandboxes"), limit: env.SANDCASTLE_MAX_SANDBOXES || "6" },
    gates: { used: used("gates"), limit: env.SANDCASTLE_MAX_GATES || "2" },
  };
};

// The queue is every open ticket the project's ready label is on, with each one's open blockers, read by the
// kit the way a run reads it. stderr is kept apart from the JSON: a warning on a good read must not spoil it,
// and on a failed one it is the reason to show.
const readQueue = (env: NodeJS.ProcessEnv, dir: string): Snapshot["queue"] => {
  const r = spawnSync(env.SANDCASTLE_BIN || "sandcastle", ["queue", "--json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    // The first line that says something; control characters out, so an escape code cannot move the cursor mid-frame.
    // oxlint-disable-next-line no-control-regex -- the control characters are what the pattern removes
    const said = (r.stderr ?? "").replace(/[\x00-\x08\x0b-\x1f]/g, "").split("\n").find((l) => /\S/.test(l));
    return { tickets: [], error: said || "sandcastle queue failed" };
  }
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) return { tickets: [], error: "the queue was not a list of tickets" };
  const tickets = list
    .filter(isObject)
    .filter((t) => t.id !== undefined && t.id !== null)
    .map((t): QueueFact => ({
      id: String(t.id),
      ...(typeof t.updated === "number" ? { updated: t.updated } : {}),
      blockedOn: Array.isArray(t.blockedOn) ? t.blockedOn.map(String) : [],
    }))
    .sort((a, b) => versionOrder(a.id, b.id));
  return { tickets };
};

// The kit's merge of a ticket is named for it ("Merge agent/issue-12 (closes #12)", or "(part of #12)" when a
// criterion was left undone): one log of the base finds every ticket's, newest first.
type Landing = { at: number; parents: string[]; subject: string; message: string };
const readLandings = (dir: string, base: string): Landing[] =>
  (git(dir, ["log", base, "--fixed-strings", "--grep=Merge agent/issue-", "--format=%x1e%ct%x1f%P%x1f%s%x1f%B"]) ?? "")
    .split("\x1e")
    .filter(Boolean)
    .map((entry) => {
      const [at = "0", parents = "", subject = "", message = ""] = entry.split("\x1f");
      return { at: Number(at) || 0, parents: parents.split(" ").filter(Boolean), subject, message };
    });

/** A ticket id as the view shows it: "#12", a suffixed branch's "#12", or a slug such as "checkout-03" as it is. */
export const shownId = (id: string): string => (/^[0-9]+(-[a-z]+)*$/.test(id) ? `#${id.split("-")[0]}` : id);

const readBranches = (dir: string, base: string, ids: Set<string>, inferred: Set<string>): Record<string, BranchFact> => {
  const heads = new Set((git(dir, ["for-each-ref", "--format=%(refname)", "refs/heads/agent/"]) ?? "").split("\n").filter(Boolean));
  const onBase = new Set((git(dir, ["for-each-ref", `--merged=${base}`, "--format=%(refname)", "refs/heads/agent/"]) ?? "").split("\n").filter(Boolean));
  const landings = readLandings(dir, base);
  const originBase = git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]) !== undefined;
  const out: Record<string, BranchFact> = {};
  for (const id of ids) {
    const ref = `refs/heads/agent/issue-${id}`;
    const exists = heads.has(ref);
    const fact: BranchFact = { exists, onBase: onBase.has(ref) };
    if (exists) {
      const n = git(dir, ["rev-list", "--count", `${base}..agent/issue-${id}`]);
      if (n !== undefined && /^\d+$/.test(n.trim())) fact.commits = Number(n.trim());
      if (inferred.has(id) && (fact.commits ?? 0) > 0) fact.equalPatches = !/^\+/m.test(git(dir, ["cherry", base, `agent/issue-${id}`]) ?? "+");
    }
    const shown = shownId(id);
    const landing = landings.find((l) => l.message.includes(`Merge agent/issue-${id} (closes ${shown})`) || l.message.includes(`Merge agent/issue-${id} (part of ${shown})`));
    if (landing) {
      let commits: number | undefined;
      if (landing.parents.length >= 2) {
        // --no-merges, as the kit counts a branch's own commits: a base merge or a resolution is not one.
        const n = git(dir, ["rev-list", "--count", "--no-merges", `${landing.parents[0]}..${landing.parents[1]}`, ...landing.parents.slice(2)]);
        if (n !== undefined && /^\d+$/.test(n.trim())) commits = Number(n.trim());
      } else if (landing.parents.length === 1) commits = 1;
      fact.landing = { at: landing.at, subject: landing.subject, ...(commits !== undefined ? { commits } : {}) };
    }
    // A branch on the base, merged by hand: the merge that took its tip in (or the tip itself, for a fast-forward)
    // being on origin's base says the push happened. No fetch here - no network.
    if (fact.onBase && originBase) {
      const tip = git(dir, ["rev-parse", "--verify", "--quiet", ref])?.trim();
      if (tip) {
        const merges = git(dir, ["rev-list", "--merges", "--ancestry-path", "--parents", `${tip}..refs/heads/${base}`]) ?? "";
        const merge = merges
          .split("\n")
          .map((l) => l.split(" "))
          .find((f) => f.slice(2).includes(tip))?.[0];
        fact.pushed = git(dir, ["merge-base", "--is-ancestor", merge || tip, `refs/remotes/origin/${base}`]) !== undefined;
      }
    }
    out[id] = fact;
  }
  return out;
};

const readRunOutput = (file: string): string[] => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => !/^\s*$/.test(l))
    .slice(-3)
    .map((l) =>
      l
        .replace(/\r/g, "")
        .replace(/\t/g, " ")
        // oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern removes
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""),
    );
};

/** Whether ticket ids link to their logs: inside Herdr with the kit's plugin linked, on a terminal; `SANDCASTLE_LINKS` 1 or 0 overrides. */
const linksOn = (env: NodeJS.ProcessEnv, terminal: boolean): boolean => {
  const given = env.SANDCASTLE_LINKS || "";
  if (!given && env.HERDR_ENV === "1" && terminal) return existsSync(PLUGIN_MARKER);
  return given === "1";
};

/** The project's `.sandcastle` directory, or undefined when it has none: the view then has nothing to show. */
export const sandcastleDir = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const dir = resolve(env.SANDCASTLE_PROJECT || process.cwd(), ".sandcastle");
  try {
    return statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
};

/** Reads everything one frame shows. `dir` is the project's `.sandcastle`; `terminal` whether stdout is one. */
export const readSnapshot = (dir: string, { env = process.env, terminal = false }: { env?: NodeJS.ProcessEnv; terminal?: boolean } = {}): Snapshot => {
  const now = Math.floor(Date.now() / 1000);
  const root = resolve(dir, "..");
  const logsDir = join(dir, "logs");
  const base = env.SANDCASTLE_BASE || (git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "").trim();
  const queue = readQueue(env, dir);
  const cpus = hostCpus();
  const containers = readContainers(dir, cpus);

  const recordFile = join(logsDir, "run.json");
  const hasRecord = existsSync(recordFile);
  const raw = hasRecord ? readJson(recordFile) : undefined;
  const record = (isObject(raw) ? raw : {}) as RunRecord;
  const tickets = readTickets(raw);
  const live = hasRecord && liveness({ record }, commandOf).state === "live";

  let logs: LogFact[] = [];
  try {
    logs = readdirSync(logsDir)
      .filter((n) => n.startsWith("agent-issue-") && n.endsWith(".log"))
      .flatMap((name) => {
        try {
          return [{ name, mtime: Math.floor(statSync(join(logsDir, name)).mtimeMs / 1000) }];
        } catch {
          return [];
        }
      });
  } catch {
    // no logs yet
  }
  const logIds = new Set(logs.map((l) => logTicket(l.name)).filter((id): id is string => !!id));
  const recorded = live ? new Set(Object.keys(tickets)) : new Set<string>();
  const inferred = new Set([...logIds].filter((id) => !recorded.has(id)));

  // The logs a row may show: a recorded ticket's current step, an inferred ticket's newest phase.
  const tails: Record<string, LogTail> = {};
  const tail = (name: string) => {
    if (tails[name]) return;
    const text = readTail(join(logsDir, name));
    if (text !== undefined) tails[name] = { activity: activityOf(text), limit: saysLimit(text) };
  };
  for (const [id, t] of Object.entries(tickets)) if (live && WORKING.includes(t.state ?? "") && t.state !== "setup") tail(phaseLog(id, t.state as TicketState));
  for (const id of inferred) {
    const log = latestPhaseLog(logs, id);
    if (log) tail(log.name);
  }

  let worktrees: string[] = [];
  try {
    worktrees = readdirSync(join(dir, "worktrees"))
      .filter((n) => n.startsWith("agent-issue-"))
      .map((n) => n.slice("agent-issue-".length));
  } catch {
    // none
  }

  let unpushed = 0;
  const upstream = git(dir, ["rev-parse", "--abbrev-ref", `${base}@{upstream}`])?.trim();
  if (upstream) unpushed = Number(git(dir, ["rev-list", "--count", `${upstream}..${base}`])?.trim()) || 0;

  let settings: SettingsFact | undefined;
  const group = (v: unknown) => (isObject(v) ? v : undefined);
  if (live) settings = { from: "live", settings: group(record.settings) };
  else if (env.SANDCASTLE_SETTINGS !== undefined) {
    let parsed: unknown = null;
    try {
      parsed = env.SANDCASTLE_SETTINGS ? JSON.parse(env.SANDCASTLE_SETTINGS) : null;
    } catch {
      parsed = undefined;
    }
    // Set but empty is the next run's settings being none: an empty group, no row; one that does not parse is no row either.
    settings = { from: "next run", settings: parsed === null ? {} : group(parsed) };
  } else if (hasRecord) settings = { from: "last run", settings: group(record.settings) };

  const modelsOf = () => (typeof record.models === "string" ? record.models : record.models === undefined || record.models === null ? "" : JSON.stringify(record.models));
  const models = live ? modelsOf() : env.SANDCASTLE_MODELS ? `next run: ${env.SANDCASTLE_MODELS}` : hasRecord ? `last run: ${modelsOf()}` : "";

  return {
    now,
    root,
    dir,
    name: env.SANDCASTLE_NAME || "",
    base,
    hasRecord,
    record,
    tickets,
    live,
    outcomes: readOutcomes(join(logsDir, "outcomes.json")),
    logs,
    tails,
    worktrees,
    branches: readBranches(dir, base, new Set([...logIds, ...recorded]), inferred),
    containers,
    cpus,
    pool: readPool(env),
    queue,
    unpushed,
    settings,
    models,
    runOutput: live ? readRunOutput(join(logsDir, "run-output.log")) : [],
    links: linksOn(env, terminal),
    clickMod: env.SANDCASTLE_CLICK_MOD || "",
  };
};
