// The status view's snapshot (GLOSSARY.md): everything the view knows at one moment - the run record and
// its tickets, the logs' last activity, the branches, the sandboxes, the machine pool and the queue - read
// from the project's `.sandcastle/`, git, `docker` and `sandcastle queue --json`. Every frame is drawn from a
// snapshot (src/status-rows.ts, src/status-render.ts), never from the sources themselves.
//
// Each source has a collector (GLOSSARY.md): the run record and logs, git, Docker, the queue and the machine
// pool. A collector refreshes its source in the background within a deadline, one refresh at a time, and keeps
// its last good reading when one fails or is given up, marked stale; a result that comes after its deadline is
// dropped. The plan's usage is a field of the run record, so it comes with the record. Every command runs in a
// process group of its own, ended with the refresh that started it: a collector given up or stopped leaves
// nothing running. The queue is a child process: the tracker and blocker code is
// synchronous and is never imported into the view (ADR 0003).
//
// The record is a file in a repository, so each field is read on its own and checked: one a newer or older
// kit wrote in another shape empties only itself.

import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isKit, liveness } from "../mod/hooks/run-live.ts";
import { readTickets, type RunRecord, type TicketRecord, type TicketState } from "../mod/hooks/run-record.ts";
import { KIT_CACHE, PLUGIN_MARKER } from "./live-runs.ts";

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
  /** Lines the branch adds and removes against the base (its merge base with it); absent when git could not say. */
  diff?: { added: number; removed: number };
  /** The branch's tip is on the base: a branch with nothing over it, or one merged by hand. */
  onBase: boolean;
  /** Every commit has an equal patch on the base (a rebased landing); asked only of a branch with commits that the view infers. */
  equalPatches?: boolean;
  /** The kit's merge of the ticket on the base, newest first: when, and its subject. */
  landing?: { at: number; subject: string };
  /** For a branch on the base: its merge (or its tip) is on origin's base too, so the push happened. */
  pushed?: boolean;
};

/** One sandbox container's reading, keyed by the ticket whose worktree it mounts. */
export type ContainerFact = { cpu: string; mem: string; hot: boolean };

/** One queued ticket, as `sandcastle queue --json` lists it. */
export type QueueFact = { id: string; updated?: number; blockedOn: string[] };

/** The run settings the SETTINGS lane draws from, and whose they are: the live run's, the next run's, or the last run's. */
export type SettingsFact = { from: "live" | "next run" | "last run"; settings: Record<string, unknown> | undefined };

/** The sources a snapshot is read from, one collector each (the plan's usage is a field of the run record). */
export type SourceName = "record" | "git" | "docker" | "queue" | "pool";

/** Where a source's reading stands: not answered yet, answered by its last refresh, kept from an earlier one after a failure, or never had. */
export type SourceStatus = "loading" | "current" | "stale" | "unavailable";

export type Snapshot = {
  /** Epoch seconds the snapshot was read at: every age in the frame is measured from it. */
  now: number;
  /** The project root, and its `.sandcastle` directory (links point into it). */
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
  /** Where each source's reading stands; a snapshot without it read every source in full. */
  sources?: Record<SourceName, SourceStatus>;
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
// falls back to the first phase word.
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

// Text from a log, the run record or the tracker reaches the terminal inside a frame: an escape sequence in it
// could set the window title, write the clipboard (OSC 52) or clear the screen, and any control character moves
// the cursor mid-frame. Whole sequences go first, so no `[2J` is left behind; then every other control.
// oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern removes
const SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-_])?/g;
// oxlint-disable-next-line no-control-regex -- the control characters are what the pattern removes
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

/** `s` with no escape sequence or control character left: a tab or line break is a space. */
export const plainText = (s: string): string => s.replace(SEQUENCES, "").replace(/[\t\n\r]/g, " ").replace(CONTROLS, "");

/** Every string in a value read from a file, keys too, as plain text. */
const plainAll = (v: unknown): unknown =>
  typeof v === "string" ? plainText(v) : Array.isArray(v) ? v.map(plainAll) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [plainText(k), plainAll(x)])) : v;

const FRAMING = /^(Agent|Run|Capturing|Collecting|Syncing|Context)/;

/** The last line of a log that says something, made readable: the raw line is agent transcript, not a status. */
export const activityOf = (text: string): string => {
  const lines = text
    .split("\n")
    .map(plainText)
    .filter((l) => !/^\s*$/.test(l) && !FRAMING.test(l));
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
 * tool's output, which can say "usage limit" too, so it is skipped.
 */
export const saysLimit = (text: string): boolean => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-12).filter((l) => !/^! (error|exit -?[0-9]+)(: |$)/.test(l)).slice(-5);
  return /out of usage credits|usage limit|limit reached/i.test(tail.join("\n"));
};

/** A whole number of seconds from a record's field (a number, or digits as text), or undefined. */
export const whole = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return Number(v);
  return undefined;
};

const WORKING: readonly string[] = ["setup", "implement", "resolve", "review", "cross-review", "gates", "repair"];

/**
 * When a live run ends, as the header says it: the queued tickets at a typical issue's length each,
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

// ---------------------------------------------------------------------------
// Commands, each in a process group of its own.
// ---------------------------------------------------------------------------

type Ran = { status: number | null; stdout: string; stderr: string };

/** How long a command given up has to end on TERM before its process group is killed. */
const KILL_AFTER_MS = 2000;

/**
 * Runs a command in a process group of its own and answers what it printed; a command that cannot start answers
 * status null, as spawnSync does. When `signal` aborts, the whole group is ended (a command it waits on too) and
 * the promise rejects: nothing a collector started outlives the refresh that started it.
 */
const run = (command: string, args: string[], signal: AbortSignal, { cwd, env, input }: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Ran> =>
  new Promise((done, fail) => {
    if (signal.aborted) return fail(signal.reason);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    // A command that exits before reading all of its input closes the pipe: its answer, not the write, says how it went.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const end = (name: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        // already gone
      }
    };
    const abort = () => {
      end("SIGTERM");
      // A command that ignores TERM would keep its pipes open, and a one-off frame waiting on them, past the
      // deadline: its group is killed a moment later, or as soon as it exits (what it started goes with it).
      // Its output is not wanted any more, so nothing of it but the kill keeps the process alive.
      const kill = setTimeout(() => end("SIGKILL"), KILL_AFTER_MS);
      child.once("exit", () => {
        clearTimeout(kill);
        end("SIGKILL");
      });
      child.stdout!.destroy();
      child.stderr!.destroy();
      child.unref();
      fail(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", () => {
      signal.removeEventListener("abort", abort);
      done({ status: null, stdout: "", stderr: "" });
    });
    child.on("close", (status) => {
      signal.removeEventListener("abort", abort);
      done({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });

const git = async (dir: string, env: NodeJS.ProcessEnv, args: string[], signal: AbortSignal, input?: string): Promise<string | undefined> => {
  const r = await run("git", args, signal, { cwd: dir, env, input });
  return r.status === 0 ? r.stdout : undefined;
};

/** The command line of a running process (live-runs.ts `commandOf`, without blocking), or undefined when there is none. */
const commandOf = async (pid: number, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | undefined> => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  const r = await run("ps", ["-p", String(pid), "-o", "command="], signal, { env });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
};

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
};

const exists = (path: string) => stat(path).then(() => true, () => false);

// ---------------------------------------------------------------------------
// The sources, one reader each.
// ---------------------------------------------------------------------------

/** The run record and the logs: what `.sandcastle/logs` and the worktrees directory hold, and whether the run is live. */
export type RecordPart = Pick<Snapshot, "hasRecord" | "record" | "tickets" | "live" | "outcomes" | "logs" | "tails" | "worktrees" | "runOutput">;
/** What git says: the base, each ticket's branch, the commits the base's upstream lacks. */
export type GitPart = Pick<Snapshot, "base" | "branches" | "unpushed">;
/** What Docker says: each sandbox container's CPU and memory, against the host's cores. */
export type DockerPart = Pick<Snapshot, "containers" | "cpus">;
/** The machine pool's slots in use. */
export type PoolPart = Snapshot["pool"];

// The end of a log is what a row shows; a log can be megabytes of transcript, so only its end is read.
const TAIL_BYTES = 64 * 1024;
export const readTail = async (file: string): Promise<string | undefined> => {
  try {
    const { size } = await stat(file);
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(file, { start: Math.max(0, size - TAIL_BYTES) })) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return undefined;
  }
};

const readOutcomes = async (file: string): Promise<Record<string, OutcomeFact>> => {
  const raw = plainAll(await readJson(file));
  if (!isObject(raw)) return {};
  const text = (v: unknown) => (v === undefined || v === null || v === false ? "" : typeof v === "string" ? v : JSON.stringify(v));
  return Object.fromEntries(
    Object.entries(raw).map(([id, e]) => {
      const o = isObject(e) ? e : {};
      return [id, { run: text(o.run), kind: text(o.kind), text: text(o.text) || text(o.outcome) }];
    }),
  );
};

const readRunOutput = async (file: string): Promise<string[]> => {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => !/^\s*$/.test(l))
    .slice(-3)
    .map((l) => plainText(l.replace(/\r/g, "")));
};

/** The tickets a live run records, and those only the logs name (inferred): which branches git is asked about. */
const ticketIds = (part: RecordPart) => {
  const logIds = new Set(part.logs.map((l) => logTicket(l.name)).filter((id): id is string => !!id));
  const recorded = part.live ? new Set(Object.keys(part.tickets)) : new Set<string>();
  return { logIds, recorded, inferred: new Set([...logIds].filter((id) => !recorded.has(id))) };
};

/** Reads the run record, the outcomes, the logs and their last lines, and the worktrees. `dir` is the project's `.sandcastle`. */
export const readRecord = async (dir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<RecordPart> => {
  const logsDir = join(dir, "logs");
  const recordFile = join(logsDir, "run.json");
  const hasRecord = await exists(recordFile);
  const raw = hasRecord ? plainAll(await readJson(recordFile)) : undefined;
  const record = (isObject(raw) ? raw : {}) as RunRecord;
  const tickets = readTickets(raw);
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
  const command = pid !== undefined ? await commandOf(pid, env, signal) : undefined;
  const live = hasRecord && liveness({ record }, (p) => (p === pid ? command : undefined)).state === "live";

  let logs: LogFact[] = [];
  try {
    const names = (await readdir(logsDir)).filter((n) => n.startsWith("agent-issue-") && n.endsWith(".log") && plainText(n) === n);
    logs = (
      await Promise.all(
        names.map(async (name) => {
          try {
            return [{ name, mtime: Math.floor((await stat(join(logsDir, name))).mtimeMs / 1000) }];
          } catch {
            return [];
          }
        }),
      )
    ).flat();
  } catch {
    // no logs yet
  }

  let worktrees: string[] = [];
  try {
    worktrees = (await readdir(join(dir, "worktrees"))).filter((n) => n.startsWith("agent-issue-") && plainText(n) === n).map((n) => n.slice("agent-issue-".length));
  } catch {
    // none
  }

  const part: RecordPart = {
    hasRecord,
    record,
    tickets,
    live,
    outcomes: await readOutcomes(join(logsDir, "outcomes.json")),
    logs,
    tails: {},
    worktrees,
    runOutput: live ? await readRunOutput(join(logsDir, "run-output.log")) : [],
  };

  // The logs a row may show: a recorded ticket's current step, an inferred ticket's newest phase.
  const shown = new Set<string>();
  for (const [id, t] of Object.entries(tickets)) if (live && WORKING.includes(t.state ?? "") && t.state !== "setup") shown.add(phaseLog(id, t.state as TicketState));
  for (const id of ticketIds(part).inferred) {
    const log = latestPhaseLog(logs, id);
    if (log) shown.add(log.name);
  }
  for (const name of shown) {
    const text = await readTail(join(logsDir, name));
    if (text !== undefined) part.tails[name] = { activity: activityOf(text), limit: saysLimit(text) };
  }
  return part;
};

// The kit's merge of a ticket is named for it ("Merge agent/issue-12 (closes #12)", or "(part of #12)" when a
// criterion was left undone): one log of the base finds every ticket's, newest first.
type Landing = { at: number; parents: string[]; subject: string; message: string };
const readLandings = async (dir: string, env: NodeJS.ProcessEnv, base: string, signal: AbortSignal): Promise<Landing[]> =>
  ((await git(dir, env, ["log", base, "--fixed-strings", "--grep=Merge agent/issue-", "--format=%x1e%ct%x1f%P%x1f%s%x1f%B"], signal)) ?? "")
    .split("\x1e")
    .filter(Boolean)
    .map((entry) => {
      const [at = "0", parents = "", subject = "", message = ""] = entry.split("\x1f");
      return { at: Number(at) || 0, parents: parents.split(" ").filter(Boolean), subject, message };
    });

/** An agent branch: whether its tip is on the base, its commits over the base (absent when git could not count them), its tip. */
type Head = { onBase: boolean; ahead?: number; tip?: string };

/**
 * Every agent branch's tip and commits over the base, from one `for-each-ref` (`%(ahead-behind)`, git 2.41): a
 * `rev-list --count` per branch was most of a frame's processes. Undefined from an older git (macOS's own
 * /usr/bin/git can be), or for a base the format cannot name, and the caller asks branch by branch as before.
 */
const readHeads = async (dir: string, env: NodeJS.ProcessEnv, base: string, signal: AbortSignal): Promise<Map<string, Head> | undefined> => {
  if (!base || /[)%]/.test(base)) return undefined;
  const out = await git(dir, env, ["for-each-ref", `--format=%(refname) %(objectname) %(ahead-behind:${base})`, "refs/heads/agent/"], signal);
  if (out === undefined) return undefined;
  const heads = new Map<string, Head>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref = "", tip = "", ahead = ""] = line.split(" ");
    if (!/^\d+$/.test(ahead)) return undefined;
    // On the base is no commit over it: what `for-each-ref --merged` lists.
    heads.set(ref, { onBase: ahead === "0", ahead: Number(ahead), tip });
  }
  return heads;
};

/** The same, branch by branch: the refs, those on the base, and a `rev-list --count` each; no tip, which is asked when wanted. */
const readHeadsByBranch = async (dir: string, env: NodeJS.ProcessEnv, base: string, ids: Set<string>, signal: AbortSignal): Promise<Map<string, Head>> => {
  const refs = async (args: string[]) => new Set(((await git(dir, env, ["for-each-ref", ...args, "--format=%(refname)", "refs/heads/agent/"], signal)) ?? "").split("\n").filter(Boolean));
  const all = await refs([]);
  const onBase = await refs([`--merged=${base}`]);
  const heads = new Map<string, Head>();
  for (const id of ids) {
    const ref = `refs/heads/agent/issue-${id}`;
    if (!all.has(ref)) continue;
    const n = (await git(dir, env, ["rev-list", "--count", `${base}..agent/issue-${id}`], signal))?.trim();
    heads.set(ref, { onBase: onBase.has(ref), ahead: n !== undefined && /^\d+$/.test(n) ? Number(n) : undefined });
  }
  return heads;
};

/**
 * Each branch's lines added and removed against the base, as `git diff --numstat base...branch` counts them - from
 * its first merge base with the base, as that diff takes it - for all of them in two commands: one `rev-parse` of
 * every `base...branch` (each range's tip, the base's, then its merge bases) and one `diff-tree --stdin`, which
 * prints a pair's tip before its lines and nothing for a pair with no change. `-M` and `--textconv` are what the
 * porcelain diff does by default. A branch with no merge base has no entry, as its diff failed. A binary file
 * counts `-` for both and adds no line.
 */
const readDiffs = async (dir: string, env: NodeJS.ProcessEnv, base: string, ids: string[], signal: AbortSignal): Promise<Map<string, { added: number; removed: number }>> => {
  const diffs = new Map<string, { added: number; removed: number }>();
  if (!ids.length) return diffs;
  const parsed = await git(dir, env, ["rev-parse", ...ids.map((id) => `${base}...agent/issue-${id}`)], signal);
  if (parsed === undefined) return diffs;
  const lines = parsed.split("\n").filter(Boolean);
  const pairs: { id: string; tip: string; mergeBase: string }[] = [];
  for (const id of ids) {
    const tip = lines.shift() ?? "";
    lines.shift(); // the base's tip
    const mergeBase = lines[0]?.startsWith("^") ? lines[0].slice(1) : undefined;
    while (lines[0]?.startsWith("^")) lines.shift();
    if (mergeBase) pairs.push({ id, tip, mergeBase });
  }
  if (!pairs.length) return diffs;
  const stat = await git(dir, env, ["diff-tree", "--stdin", "-r", "--numstat", "-M", "--textconv", "--no-ext-diff"], signal, pairs.map((p) => `${p.tip} ${p.mergeBase}\n`).join(""));
  if (stat === undefined) return diffs;
  // Two branches with one tip have one merge base and one diff, so a pair's figures are its tip's.
  const byTip = new Map<string, { added: number; removed: number }>();
  let counting: { added: number; removed: number } | undefined;
  for (const line of stat.split("\n")) {
    if (/^[0-9a-f]+$/.test(line)) byTip.set(line, (counting = { added: 0, removed: 0 }));
    const m = /^(\d+)\t(\d+)\t/.exec(line);
    if (m && counting) [counting.added, counting.removed] = [counting.added + Number(m[1]), counting.removed + Number(m[2])];
  }
  for (const p of pairs) diffs.set(p.id, byTip.get(p.tip) ?? { added: 0, removed: 0 });
  return diffs;
};

const readBranches = async (dir: string, env: NodeJS.ProcessEnv, base: string, ids: Set<string>, inferred: Set<string>, signal: AbortSignal): Promise<Record<string, BranchFact>> => {
  const heads = (await readHeads(dir, env, base, signal)) ?? (await readHeadsByBranch(dir, env, base, ids, signal));
  const landings = await readLandings(dir, env, base, signal);
  const originBase = (await git(dir, env, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], signal)) !== undefined;
  const diffs = await readDiffs(dir, env, base, [...ids].filter((id) => (heads.get(`refs/heads/agent/issue-${id}`)?.ahead ?? 0) > 0), signal);
  const out: Record<string, BranchFact> = {};
  for (const id of ids) {
    const ref = `refs/heads/agent/issue-${id}`;
    const head = heads.get(ref);
    const fact: BranchFact = { exists: !!head, onBase: !!head?.onBase };
    if (head) {
      if (head.ahead !== undefined) fact.commits = head.ahead;
      if (fact.commits === 0) fact.diff = { added: 0, removed: 0 };
      else if (diffs.has(id)) fact.diff = diffs.get(id);
      if (inferred.has(id) && (fact.commits ?? 0) > 0) fact.equalPatches = !/^\+/m.test((await git(dir, env, ["cherry", base, `agent/issue-${id}`], signal)) ?? "+");
    }
    const shown = shownId(id);
    const landing = landings.find((l) => l.message.includes(`Merge agent/issue-${id} (closes ${shown})`) || l.message.includes(`Merge agent/issue-${id} (part of ${shown})`));
    if (landing) fact.landing = { at: landing.at, subject: landing.subject };
    // A branch on the base, merged by hand: the merge that took its tip in (or the tip itself, for a fast-forward)
    // being on origin's base says the push happened. No fetch here - no network.
    if (fact.onBase && originBase) {
      const tip = head?.tip ?? (await git(dir, env, ["rev-parse", "--verify", "--quiet", ref], signal))?.trim();
      if (tip) {
        const merges = (await git(dir, env, ["rev-list", "--merges", "--ancestry-path", "--parents", `${tip}..refs/heads/${base}`], signal)) ?? "";
        const merge = merges
          .split("\n")
          .map((l) => l.split(" "))
          .find((f) => f.slice(2).includes(tip))?.[0];
        fact.pushed = (await git(dir, env, ["merge-base", "--is-ancestor", merge || tip, `refs/remotes/origin/${base}`], signal)) !== undefined;
      }
    }
    out[id] = fact;
  }
  return out;
};

/** Reads the base, the branches of the tickets `part` names (none before the record is read) and the unpushed commits. */
export const readGit = async (dir: string, env: NodeJS.ProcessEnv, part: RecordPart | undefined, signal: AbortSignal): Promise<GitPart> => {
  const base = env.SANDCASTLE_BASE || ((await git(dir, env, ["rev-parse", "--abbrev-ref", "HEAD"], signal)) ?? "").trim();
  const { logIds, recorded, inferred } = part ? ticketIds(part) : { logIds: new Set<string>(), recorded: new Set<string>(), inferred: new Set<string>() };
  const branches = await readBranches(dir, env, base, new Set([...logIds, ...recorded]), inferred, signal);
  let unpushed = 0;
  const upstream = (await git(dir, env, ["rev-parse", "--abbrev-ref", `${base}@{upstream}`], signal))?.trim();
  if (upstream) unpushed = Number((await git(dir, env, ["rev-list", "--count", `${upstream}..${base}`], signal))?.trim()) || 0;
  return { base, branches, unpushed };
};

// docker reports CPU against one core, so 1399% is ~14 cores: shown as cores against the host's. Asked once, and
// kept apart from docker's answer: a docker that is not running or hangs leaves the host's cores known.
let cores: number | undefined;
const hostCpus = async (env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<number> => {
  if (cores) return cores;
  for (const [command, args] of [["sysctl", ["-n", "hw.ncpu"]], ["nproc", []]] as const) {
    const r = await run(command, [...args], signal, { env });
    const n = Number(r.stdout.trim());
    if (r.status === 0 && Number.isFinite(n) && n > 0) return (cores = n);
  }
  return 1;
};

// The container name is a bare UUID with no labels, so the only thing tying it to a ticket is the worktree it
// bind-mounts - and only a worktree of this project: another project's run can have the same ticket number.
// A docker call that fails fails the reading: the containers last seen are kept, marked stale.
export const readDocker = async (dir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<DockerPart> => {
  const docker = async (args: string[]) => {
    const r = await run("docker", args, signal, { env });
    if (r.status !== 0) throw new Error(`docker ${args[0]} failed`);
    return r.stdout;
  };
  // The cores are asked to the end even when docker fails, so the snapshot of a failed reading has them too.
  const [counted, listed] = await Promise.allSettled([hostCpus(env, signal), docker(["ps", "-q", "--filter", "name=sandcastle-"])]);
  if (counted.status === "rejected") throw counted.reason;
  if (listed.status === "rejected") throw listed.reason;
  const cpus = counted.value;
  const ids = listed.value.split("\n").filter(Boolean);
  if (!ids.length) return { containers: {}, cpus };
  const owner = new Map<string, string>();
  const prefix = `${dir}/worktrees/agent-issue-`;
  for (const line of (await docker(["inspect", ...ids, "--format", "{{.Name}}{{range .Mounts}}|{{.Source}}{{end}}"])).split("\n")) {
    const [name, ...mounts] = line.split("|");
    if (!name) continue;
    const mount = mounts.find((m) => m.includes(prefix));
    const ticket = mount?.match(/.*\/worktrees\/agent-issue-([a-z0-9][a-z0-9-]*)/)?.[1];
    if (ticket) owner.set(name.replace(/^\//, ""), ticket);
  }
  const containers: Record<string, ContainerFact> = {};
  for (const line of (await docker(["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}", ...ids])).split("\n")) {
    const [name, cpu = "", mem = ""] = line.split("|");
    const ticket = name ? owner.get(name) : undefined;
    if (!ticket) continue;
    // "275.8MiB / 11.73GiB" -> "276M"; a GiB figure under 10 keeps a decimal: "2.1GiB" -> "2.1G".
    const used = (mem.split("/")[0] ?? "").trim().replace(/iB$/, "");
    const unit = used.slice(-1);
    const amount = parseFloat(used.slice(0, -1)) || 0;
    // "1399.02%" -> "14.0c", hot past 80% of the host's cores.
    const n = (parseFloat(cpu.replace(/%$/, "")) || 0) / 100;
    containers[ticket] = { cpu: `${n.toFixed(1)}c`, mem: `${unit === "G" && amount < 10 ? amount.toFixed(1) : amount.toFixed(0)}${unit}`, hot: n >= cpus * 0.8 };
  }
  return { containers, cpus };
};

// Machine-wide slots (src/pool.ts): one lock file per slot, its owner's pid first. A slot counts while its owner
// is a process of the kit (pool.ts `holderRunning`); when `ps` cannot say, while the process exists.
export const readPool = async (env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<PoolPart> => {
  const dir = join(KIT_CACHE, "slots");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => (f.startsWith("sandboxes-") || f.startsWith("gates-")) && f.endsWith(".lock"));
  } catch {
    // no slots taken yet
  }
  const owners = new Map<string, number>();
  for (const f of files) {
    try {
      const pid = (await readFile(join(dir, f), "utf8")).split(" ")[0]!.trim();
      if (/^[0-9]+$/.test(pid)) owners.set(f, Number(pid));
    } catch {
      // released meanwhile
    }
  }
  const alive = new Map<number, boolean>();
  for (const pid of new Set(owners.values())) {
    const command = await commandOf(pid, env, signal);
    let exists = command !== undefined;
    if (!exists) {
      try {
        process.kill(pid, 0);
        exists = true;
      } catch (error) {
        exists = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    alive.set(pid, command !== undefined ? isKit(command) : exists);
  }
  const used = (pool: string) => [...owners].filter(([f, pid]) => f.startsWith(`${pool}-`) && alive.get(pid)).length;
  return {
    sandboxes: { used: used("sandboxes"), limit: env.SANDCASTLE_MAX_SANDBOXES || "6" },
    gates: { used: used("gates"), limit: env.SANDCASTLE_MAX_GATES || "2" },
  };
};

// The queue is every open ticket the project's ready label is on, with each one's open blockers, read by the
// kit the way a run reads it. stderr is kept apart from the JSON: a warning on a good read must not spoil it,
// and on a failed one it is the reason to show - the reading's error.
export const readQueue = async (env: NodeJS.ProcessEnv, dir: string, signal: AbortSignal): Promise<QueueFact[]> => {
  const r = await run(env.SANDCASTLE_BIN || "sandcastle", ["queue", "--json"], signal, { cwd: dir, env });
  if (r.status !== 0) {
    // The first line that says something, as plain text.
    const said = r.stderr.split("\n").map(plainText).find((l) => /\S/.test(l));
    throw new Error(said || "sandcastle queue failed");
  }
  let list: unknown;
  try {
    list = plainAll(JSON.parse(r.stdout));
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) throw new Error("the queue was not a list of tickets");
  return list
    .filter(isObject)
    .filter((t) => t.id !== undefined && t.id !== null)
    .map((t): QueueFact => ({
      id: String(t.id),
      ...(typeof t.updated === "number" ? { updated: t.updated } : {}),
      blockedOn: Array.isArray(t.blockedOn) ? t.blockedOn.map(String) : [],
    }))
    .sort((a, b) => versionOrder(a.id, b.id));
};

/** A ticket id as the view shows it: "#12", a suffixed branch's "#12", or a slug such as "checkout-03" as it is. */
export const shownId = (id: string): string => (/^[0-9]+(-[a-z]+)*$/.test(id) ? `#${id.split("-")[0]}` : id);

// ---------------------------------------------------------------------------
// Collectors.
// ---------------------------------------------------------------------------

/** A source's reading: its last good value (none before the first), whether it is current, and why the last refresh failed. */
export type Reading<T> = { status: SourceStatus; value?: T; error?: string };

export type Collector<T> = {
  /** The reading now: `loading` until the first refresh ends, then `current`, or after a failure `stale` (the last good value kept) or `unavailable` (none yet). */
  readonly reading: Reading<T>;
  /** Whether a refresh is in flight. */
  readonly busy: boolean;
  /** Starts a refresh, unless one is in flight: then that one is the answer. Settles when it ends or is given up at its deadline. */
  refresh: () => Promise<void>;
  /** Gives up the refresh in flight and starts none again. */
  stop: () => void;
};

const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
const same = <T>(a: Reading<T>, b: Reading<T>) => a.status === b.status && a.error === b.error && JSON.stringify(a.value) === JSON.stringify(b.value);

/**
 * A collector of one source: `read` within `deadline` ms. At most one refresh is in flight. One that fails keeps
 * the last good value, marked stale; one still out at its deadline is given up - its signal aborts, which ends
 * what it started - and failed, and whatever it answers after is dropped. `onChange` is told when the reading
 * changes, never when a refresh reads what it had.
 */
export const createCollector = <T>({ read, deadline, onChange }: { read: (signal: AbortSignal) => Promise<T>; deadline: number; onChange?: () => void }): Collector<T> => {
  let reading: Reading<T> = { status: "loading" };
  let flight: Promise<void> | undefined;
  let giveUp: ((why: string) => void) | undefined;
  let stopped = false;
  const set = (next: Reading<T>) => {
    if (stopped || same(reading, next)) return;
    reading = next;
    onChange?.();
  };
  const fail = (error: string) => set(reading.value !== undefined ? { status: "stale", value: reading.value, error } : { status: "unavailable", error });
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (flight) return flight;
    const controller = new AbortController();
    flight = new Promise<void>((settle) => {
      let over = false;
      /** Ends this refresh once: false when it already ended, and what it answers then is late. */
      const end = () => {
        if (over) return false;
        over = true;
        clearTimeout(timer);
        flight = undefined;
        giveUp = undefined;
        settle();
        return true;
      };
      giveUp = (why) => {
        if (!end()) return;
        controller.abort(new Error(why));
        fail(why);
      };
      const timer = setTimeout(() => giveUp?.(`no answer in ${deadline / 1000} s`), deadline);
      read(controller.signal).then(
        (value) => end() && set({ status: "current", value }),
        (error: unknown) => end() && fail(said(error)),
      );
    });
    return flight;
  };
  return {
    get reading() {
      return reading;
    },
    get busy() {
      return flight !== undefined;
    },
    refresh,
    stop: () => {
      stopped = true;
      giveUp?.("stopped");
    },
  };
};

/** How long each source's refresh may take before it is given up: the queue asks a tracker over the network. */
export const DEADLINES: Record<SourceName, number> = { record: 10_000, git: 30_000, docker: 30_000, queue: 60_000, pool: 10_000 };

/** The queue is read at most once a minute, unless the run record's run or stage changed (a run starting, landing or ending changes the queue). */
export const QUEUE_CACHE_MS = 60_000;

export type Readings = {
  record: Reading<RecordPart>;
  git: Reading<GitPart>;
  docker: Reading<DockerPart>;
  queue: Reading<QueueFact[]>;
  pool: Reading<PoolPart>;
};

export type Sources = {
  /** Each source's reading now. */
  readings: () => Readings;
  /** Whether every source has answered once (a failure is an answer). */
  answered: () => boolean;
  /**
   * Refreshes every source not already refreshing: the record and then git (which asks about the record's
   * tickets), Docker and the pool at once, and the queue when its minute is up or the record's run or stage changed since.
   */
  refresh: () => Promise<void>;
  /** Gives up every refresh in flight, ending what each started; nothing starts after. */
  stop: () => void;
};

/** The collectors of a project's sources. `dir` is its `.sandcastle`; `onChange` is told whenever a reading changes. */
export const createSources = (dir: string, env: NodeJS.ProcessEnv, onChange?: () => void): Sources => {
  const record = createCollector({ read: (signal) => readRecord(dir, env, signal), deadline: DEADLINES.record, onChange });
  const gitSource = createCollector({ read: (signal) => readGit(dir, env, record.reading.value, signal), deadline: DEADLINES.git, onChange });
  const docker = createCollector({ read: (signal) => readDocker(dir, env, signal), deadline: DEADLINES.docker, onChange });
  const queue = createCollector({ read: (signal) => readQueue(env, dir, signal), deadline: DEADLINES.queue, onChange });
  const pool = createCollector({ read: (signal) => readPool(env, signal), deadline: DEADLINES.pool, onChange });
  const all = { record, git: gitSource, docker, queue, pool };
  // What the queue cache keys on besides its minute: the run record's run and where it stands. A run rewrites the
  // record every few seconds while it works, but starts, lands (its stage) and exits, having closed what it
  // landed, far less often - only those change the queue.
  const recordState = () => {
    try {
      const r = JSON.parse(readFileSync(join(dir, "logs/run.json"), "utf8")) as Record<string, unknown>;
      return JSON.stringify([r.startedAt, r.finishedAt, r.stage, r.pid]);
    } catch {
      return "";
    }
  };
  let queuedAt: number | undefined;
  let queuedFor = "";
  return {
    readings: () => ({ record: record.reading, git: gitSource.reading, docker: docker.reading, queue: queue.reading, pool: pool.reading }),
    answered: () => Object.values(all).every((c) => c.reading.status !== "loading"),
    refresh: () => {
      const waits = [record.refresh().then(() => gitSource.refresh()), docker.refresh(), pool.refresh()];
      const t = performance.now();
      const changed = recordState();
      if (!queue.busy && (queuedAt === undefined || t - queuedAt >= QUEUE_CACHE_MS || changed !== queuedFor)) {
        [queuedAt, queuedFor] = [t, changed];
        waits.push(queue.refresh());
      }
      return Promise.all(waits).then(() => undefined);
    },
    stop: () => Object.values(all).forEach((c) => c.stop()),
  };
};

/** Whether ticket ids link to their logs: inside Herdr with the kit's plugin linked, on a terminal; `SANDCASTLE_LINKS` 1 or 0 overrides. */
const linksOn = (env: NodeJS.ProcessEnv, terminal: boolean): boolean => {
  const given = env.SANDCASTLE_LINKS || "";
  if (!given && env.HERDR_ENV === "1" && terminal) return existsSync(PLUGIN_MARKER);
  return given === "1";
};

const NO_RECORD: RecordPart = { hasRecord: false, record: {} as RunRecord, tickets: {}, live: false, outcomes: {}, logs: [], tails: {}, worktrees: [], runOutput: [] };

/**
 * The snapshot of the readings at `now` (epoch seconds; a redraw passes the clock, so ages count up between
 * refreshes). A source with no value yet draws as empty, and `sources` says which are loading.
 */
export const snapshotOf = (dir: string, readings: Readings, { env = process.env, terminal = false, now = Math.floor(Date.now() / 1000) }: { env?: NodeJS.ProcessEnv; terminal?: boolean; now?: number } = {}): Snapshot => {
  const { hasRecord, record, tickets, live, outcomes, logs, tails, worktrees, runOutput } = readings.record.value ?? NO_RECORD;
  const { base, branches, unpushed } = readings.git.value ?? { base: env.SANDCASTLE_BASE || "", branches: {}, unpushed: 0 };
  const { containers, cpus } = readings.docker.value ?? { containers: {}, cpus: cores ?? 1 };
  const pool = readings.pool.value ?? { sandboxes: { used: 0, limit: env.SANDCASTLE_MAX_SANDBOXES || "6" }, gates: { used: 0, limit: env.SANDCASTLE_MAX_GATES || "2" } };
  const queue = { tickets: readings.queue.value ?? [], ...(readings.queue.error ? { error: readings.queue.error } : {}) };

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
    root: resolve(dir, ".."),
    dir,
    name: env.SANDCASTLE_NAME || "",
    base,
    hasRecord,
    record,
    tickets,
    live,
    outcomes,
    logs,
    tails,
    worktrees,
    branches,
    containers,
    cpus,
    pool,
    queue,
    unpushed,
    settings,
    models,
    runOutput,
    links: linksOn(env, terminal),
    clickMod: env.SANDCASTLE_CLICK_MOD || "",
    sources: { record: readings.record.status, git: readings.git.status, docker: readings.docker.status, queue: readings.queue.status, pool: readings.pool.status },
  };
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

/** Reads every source once, each within its deadline, and the snapshot of what they answered: a one-off frame's. */
export const readSnapshot = async (dir: string, { env = process.env, terminal = false }: { env?: NodeJS.ProcessEnv; terminal?: boolean } = {}): Promise<Snapshot> => {
  const sources = createSources(dir, env);
  await sources.refresh();
  return snapshotOf(dir, sources.readings(), { env, terminal });
};
