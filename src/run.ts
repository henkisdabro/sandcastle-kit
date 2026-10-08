// Everything around a run that is not the pipeline itself: preconditions,
// preflight, prompts, the run record, the log archive and the status pane.

import { type ChildProcess, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IterationUsage, LoggingOption } from "@ai-hero/sandcastle";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, REVIEW_MODEL } from "./agents.ts";
import type { Project } from "./config.ts";
import { type Gate, LANDING, LANDING_GATES } from "./gates.ts";
import { refOf, type Tracker } from "./tracker.ts";
import { herdr, herdrJson, IN_HERDR, runsStatus, STATUS_COMMAND, statusPaneRecord } from "./herdr.ts";
import { credentials, credentialSource, KIT, machineSettings, MAX_OUTPUT, sh } from "./sandbox.ts";
import { OperatorError } from "./errors.ts";
import { localStamp } from "./stamp.ts";
import { commandOf } from "./live-runs.ts";
import { liveness } from "../mod/hooks/run-live.ts";
import { GROUPS, isOutcomeKind, type Outcome, type OutcomeEntry, type RunRecord, sessionId, type TicketRecord } from "../mod/hooks/run-record.ts";

// How the run was ended, for the record `recordRun` writes at its exit: a SIGINT of a detached
// run is `sandcastle stop`'s, one in a terminal is Ctrl-C; a SIGTERM or SIGHUP is named as it is.
let endedBy: string | undefined;

// Node's default action on SIGHUP, SIGINT and SIGTERM ends the process without
// running exit handlers, so a closed pane or a Ctrl-C lost the end line, run.json's
// finishedAt and the lock releases. The library handles only SIGINT and SIGTERM, and
// only while a sandbox is live: while it listens, leave the teardown to it (a SIGHUP
// is handed over as a SIGTERM); otherwise run the exit handlers once and die by the signal.
// Not `process.exit`: on Node 24 it can deadlock joining V8's platform workers (a concurrent
// Sparkplug or Maglev compile waits for a GC the main thread never runs), after which no signal
// reaches JS again and only SIGKILL ends the process (nodejs/node#66171, open). A signal the
// process re-raises on itself, with its default action back, is ended by the kernel with no join,
// and the shell still sees 129, 130 or 143.
// A detached run (`--detach`) has no terminal to hang up, and a SIGHUP it still gets (the
// shell that started it closing, on a system that sends one to the session) must not end it:
// it stops on `sandcastle stop`, which is a SIGINT.
export const exitOnSignal = () => {
  const mapped = { SIGHUP: "SIGTERM", SIGINT: "SIGINT", SIGTERM: "SIGTERM" } as const;
  const detached = process.env.SANDCASTLE_DETACHED === "1";
  for (const sig of Object.keys(mapped) as (keyof typeof mapped)[]) {
    if (detached && sig === "SIGHUP") {
      process.on(sig, () => {});
      continue;
    }
    const onSignal = () => {
      // Before the library's teardown can end the process: its exit still writes the record.
      // `sandcastle stop` sends SIGINT to any live run: in a terminal it cannot be told from Ctrl-C.
      endedBy ??= sig === "SIGINT" ? (detached ? "sandcastle stop" : "Ctrl-C or `sandcastle stop`") : sig;
      if (process.listenerCount(mapped[sig]) > 1) {
        if (sig === "SIGHUP") process.emit("SIGTERM", "SIGTERM");
        return;
      }
      const code = 128 + osConstants.signals[sig];
      process.exitCode = code;
      process.emit("exit", code);
      // With no listener left Node restores the signal's default action, which ends the process.
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
};

// Lines the library prints that are untrue or off-script for a kit run, reworded.
// Agent branches are never pushed, so its "Could not fetch from origin" showed on
// every resumed branch and read as a network fault; and a kept worktree is the
// kit's to clean, which a hand-run `git worktree remove` bypasses.
const REWORDED: [RegExp, string][] = [
  [/^Could not fetch from origin \(reusing worktree at (.+) as-is, branch '(.+)'\)$/, "Resuming branch '$2' in its kept worktree ($1)"],
  [/^( *)To clean up: git worktree remove --force .+$/, "$1To clean up: `sandcastle clean` - or leave it, and the next `sandcastle run` resumes it"],
];
export const reword = (line: string) => REWORDED.reduce((l, [re, to]) => l.replace(re, to), line);
export const rewordLibraryLines = () => {
  for (const method of ["log", "error"] as const) {
    const write = console[method].bind(console);
    console[method] = (...args: unknown[]) => write(...args.map((a) => (typeof a === "string" ? a.split("\n").map(reword).join("\n") : a)));
  }
};

// ---------------------------------------------------------------------------
// `sandcastle run` arguments - aliases for the TICKETS, DRY_RUN and CONCURRENCY
// variables, which stay the one mechanism. Anything else is refused: a
// silently ignored `run 12 14` burned down the whole queue.
// ---------------------------------------------------------------------------

/**
 * The tickets the environment names: `TICKETS`, or `ISSUES` as the older name it replaced. When
 * both are set `TICKETS` wins, and `note` says so - the run prints it once, so a stale `ISSUES`
 * in a shell profile is not mistaken for the list in use.
 */
export const namedTicketsFromEnv = (env: NodeJS.ProcessEnv = process.env): { list?: string; note?: string } => {
  if (env.TICKETS && env.ISSUES) return { list: env.TICKETS, note: "TICKETS and ISSUES are both set; using TICKETS (ISSUES is the older name)." };
  const list = env.TICKETS || env.ISSUES;
  return list ? { list } : {};
};

const RUN_USAGE = "Usage: sandcastle run [TICKET ...] [--dry] [--concurrency N] [--detach] [--api-key]";

// `detach` and `apiKey` are only present when asked for, so the common result keeps its shape.
export const parseRunArgs = (args: string[]): { issues?: string[]; dry: boolean; concurrency?: number; detach?: true; apiKey?: true } => {
  const out: { issues?: string[]; dry: boolean; concurrency?: number; detach?: true; apiKey?: true } = { dry: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry") out.dry = true;
    else if (arg === "--detach") out.detach = true;
    else if (arg === "--api-key") out.apiKey = true;
    else if (arg === "--concurrency") {
      const n = args[++i];
      if (n === undefined || !/^[1-9]\d*$/.test(n)) throw new OperatorError(`--concurrency needs a whole number of 1 or more. ${RUN_USAGE}`);
      out.concurrency = Number(n);
    } else if (arg.startsWith("-")) throw new OperatorError(`Unknown argument "${arg}" for sandcastle run. ${RUN_USAGE}`);
    // Ticket-file ids are slugs, so an id is not required to be numeric.
    else (out.issues ??= []).push(arg);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Keep awake - a machine that idles to sleep freezes every sandbox mid-turn,
// and an unattended run is the one nobody is there to wake. On by default;
// KEEP_AWAKE=0 for one run, or "keepAwake": false in the machine's
// config.json, leaves it to the energy settings. It is a machine setting, not
// a project one: a committed config.ts would decide it for every teammate's
// laptop. The helper is tied to this process's pid, so it ends with the run
// even when the run is killed. A closed laptop lid still sleeps.
// ---------------------------------------------------------------------------

// How long the inhibitor must survive to count as on. `-h` alone passes where the real call fails
// at once (systemd with no system bus, as in WSL without systemd or a container; BusyBox's tail
// with no --pid), so the start line said on for an inhibitor already gone. Short, as it holds up
// the run's start.
const KEEP_AWAKE_SETTLE_MS = 250;

// The latest inhibitor this process started, if it is still held, and whether a pause let it go.
let inhibitor: ChildProcess | undefined;
// The inhibitor still settling (its first KEEP_AWAKE_SETTLE_MS), so a release in that window ends it too.
let settling: ChildProcess | undefined;
let released = false;

/**
 * The start line that tells the operator the base is the run's. The guard cannot tell a person's
 * commit on the base from a sandbox's, so one made mid-run stops the run (pipelines in flight
 * finish, nothing more lands) and the tokens spent on them buy nothing until a re-run. Worktrees share
 * `.git/config`, and a person told to use another worktree gave a branch an upstream there and
 * stopped a drain run (#451): the guard reads the file by key now and lets that one through, so the
 * line says what still stops it.
 */
export const baseIsTheRunsLine = (base: string) =>
  `Do not commit, pull or merge on ${base} in this checkout until the run ends (use another worktree): the guard cannot tell your commit from a sandbox's, and stops the run. Worktrees share .git/config: an upstream for your own branch there (\`git worktree add\` from a remote branch, \`git push -u\`, \`gh pr create\`) is fine, but any other change to it stops the run - a remote, a hook path, an include, or an upstream on ${base} or an agent/issue-* branch.`;

export const keepAwake = async (): Promise<string> => {
  if ((process.env.KEEP_AWAKE ?? (machineSettings().keepAwake === false ? "0" : "1")) === "0") {
    return "off - the machine's energy settings apply";
  }
  const pid = String(process.pid);
  const [cmd, args] =
    process.platform === "darwin"
      ? ["caffeinate", ["-i", "-w", pid]]
      : ["systemd-inhibit", ["--what=idle:sleep", "--who=sandcastle", "--why=sandcastle run", "tail", `--pid=${pid}`, "-f", "/dev/null"]];
  if (spawnSync(cmd, ["-h"], { stdio: "ignore" }).error) return `off - ${cmd} not found`;
  // Each turn of a multi-turn run asks again: one inhibitor already holding is the answer, or a later
  // release would end only the newest and the machine would never sleep while paused.
  if (inhibitor && inhibitor.exitCode === null && inhibitor.signalCode === null) return `on (${cmd})`;
  const child = spawn(cmd, args, { stdio: "ignore" });
  settling = child;
  const ended = new Promise<boolean>((resolve) => {
    child.on("error", () => resolve(true));
    child.on("exit", () => resolve(true));
  });
  child.unref();
  let timer: NodeJS.Timeout | undefined;
  const settled = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), KEEP_AWAKE_SETTLE_MS); });
  const failed = await Promise.race([ended, settled]);
  clearTimeout(timer);
  if (settling === child) settling = undefined;
  if (!failed) {
    inhibitor = child;
    released = false;
  }
  return failed ? `off - ${cmd} failed` : `on (${cmd})`;
};

/**
 * A paused run with nothing in flight lets the machine sleep: the inhibitor ends. Nothing when none
 * is held (keep-awake was off, or already released).
 */
export const releaseAwake = () => {
  if (settling) {
    settling.kill();
    settling = undefined;
    released = true;
  }
  if (!inhibitor) return;
  inhibitor.kill();
  inhibitor = undefined;
  released = true;
};

/** Holds the machine awake again when a pause released it, as a resume does. Nothing otherwise. */
export const holdAwake = async () => {
  if (released) await keepAwake();
};

// Porcelain lines (`XY path`) of everything staged, unstaged or untracked. Not sh(): its trim
// would eat the first line's leading status column.
export const dirtyFiles = (root: string): string[] =>
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", maxBuffer: MAX_OUTPUT })
    .split("\n")
    .filter(Boolean);

// Every merge lands in the primary checkout, so it has to be clean and on the base branch.
// An OperatorError, so the CLI prints a message: a stack trace read as a kit bug, and
// without the file list the operator had to run git status to find a stray lockfile.
export const assertCleanBase = (project: Project) => {
  const dirty = dirtyFiles(project.root);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10).map((l) => `  ${l}`);
    if (dirty.length > 10) shown.push(`  ... and ${dirty.length - 10} more`);
    throw new OperatorError(
      `NOT STARTED: the working tree is dirty. The run merges into it - commit or stash first.\n${shown.join("\n")}`,
    );
  }
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], project.root);
  if (branch !== project.baseBranch) {
    throw new OperatorError(
      `NOT STARTED: expected to be on ${project.baseBranch}, found ${branch}. If ${branch} is your base branch, set baseBranch: "${branch}" in .sandcastle/config.ts.`,
    );
  }
};

// ---------------------------------------------------------------------------
// Preflight - one short reply from every model, before any sandbox exists.
// A spent Max plan allowance, a model the image's Claude Code is too old for,
// or an expired token otherwise surfaces mid-run as a misleading error, after
// the implementation has already been paid for. SKIP_PREFLIGHT=1 skips it.
// ---------------------------------------------------------------------------

const ask = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<{ ok: boolean; out: string; stdout: string }>((resolve) => {
    const child = execFile(
      cmd, args, { ...opts, encoding: "utf8", timeout: 180_000 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, out: stdout, stdout });
        resolve({ ok: false, out: `${stdout ?? ""}${stderr ?? ""}`.trim() || error.message, stdout: stdout ?? "" });
      },
    );
    // execFile has no stdio option: close the piped stdin so nothing waits on input (codex exec reads it).
    child.stdin?.end();
  });

// What a failed preflight says. Every model rejecting a bad token returns the same reply, so one line
// names them all; a reply that looks like an auth rejection also names the credential's key and file
// (never the value), since finding a stale token cost a field report about ten tool calls.
const AUTH_REJECTION = /\b401\b|authenticat|invalid.*(api.key|token)|oauth|400 \(no body\)/i;

export const preflightFailure = (
  failures: { model: string; reply: string }[],
  credential: { key: string; file: string } | undefined,
): string => {
  const same = failures.every((f) => f.reply === failures[0]!.reply);
  const lines = same
    ? [`${failures.map((f) => f.model).join(", ")}: ${failures[0]!.reply}`]
    : failures.map((f) => `${f.model}: ${f.reply}`);
  if (same && credential && AUTH_REJECTION.test(failures[0]!.reply)) {
    lines.push(
      `The credential was likely rejected: ${credential.key} from ${credential.file}. ` +
        `Make a new one (\`claude setup-token\` for a subscription) and replace that value in ${credential.file}.`,
    );
  }
  return `NOT STARTED: Preflight failed - no sandbox started:\n  ${lines.join("\n  ")}`;
};

// `extra` is a model only some tickets ask for (a label), with where it came from.
export const preflight = async (project: Project, image: string, extra: { model: string; from: string }[] = []) => {
  // Before any probe, and with preflight skipped too: without Codex on the host every ticket's
  // cross-review failed one by one, and preflight said only "spawn codex ENOENT" after the Claude probes.
  if (CROSS_REVIEW && spawnSync("codex", ["--version"], { stdio: "ignore" }).error) {
    throw new OperatorError("CROSS_REVIEW=1 needs the Codex CLI on this machine: `npm install -g @openai/codex && codex login` - or run without CROSS_REVIEW.");
  }
  if (process.env.SKIP_PREFLIGHT === "1") return;
  const env = credentials(project);
  type Failure = { model: string; reply: string } | undefined;
  // Every model is asked at once; failures are read back in this array's order, not completion order,
  // so the message is the same on every run.
  const probes: Promise<Failure>[] = [...new Set([IMPL_MODEL, REVIEW_MODEL, ...extra.map((e) => e.model)])].map(async (model): Promise<Failure> => {
    const r = await ask(
      "docker",
      [
        "run", "--rm", ...Object.keys(env).flatMap((k) => ["-e", k]),
        "--entrypoint", "/home/agent/.local/bin/claude", image,
        "--print", "--model", model, "--effort", "low", "--output-format", "json", "-p", "Reply OK",
      ],
      { env: { ...process.env, ...env } },
    );
    let reply: { is_error?: boolean; result?: string } = {};
    try {
      // stdout alone: on an unknown model the CLI also writes a `[claude-code:unrecognized_model]`
      // line to stderr, and parsing the two together printed the whole JSON as the reason.
      reply = JSON.parse(r.stdout);
    } catch {
      /* not JSON - the raw output is the reason */
    }
    // A model only a label names is reported with the ticket that asked for it.
    const from = model === IMPL_MODEL || model === REVIEW_MODEL ? undefined : extra.find((e) => e.model === model)?.from;
    return !r.ok || reply.is_error !== false
      ? { model: from ? `${model} (${from})` : model, reply: (reply.result ?? r.out).slice(0, 300) }
      : undefined;
  });
  if (CROSS_REVIEW) {
    // On the HOST, not in the image: this also refreshes the host's ChatGPT
    // login, which every sandbox then copies (see sandboxConfig).
    probes.push(
      ask(
        "codex",
        ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-m", CROSS_REVIEW_MODEL, "Reply OK"],
        { cwd: tmpdir() },
      ).then((r) => (r.ok ? undefined : { model: CROSS_REVIEW_MODEL, reply: r.out.split("\n").slice(-3).join(" ").slice(0, 300) })),
    );
  }
  const failures = (await Promise.all(probes)).filter((f): f is { model: string; reply: string } => f !== undefined);
  if (failures.length) {
    // The hint names the Claude credential; a Codex reply comes from the host's ChatGPT login, not that file.
    const claudeOnly = failures.every((f) => f.model !== CROSS_REVIEW_MODEL);
    throw new OperatorError(preflightFailure(failures, claudeOnly ? credentialSource(project) : undefined));
  }
  console.log(`Preflight ok: ${MODELS_LINE}`);
};

// ---------------------------------------------------------------------------
// Prompts: the kit's templates with the project's gates, label and rules
// filled in, written where Sandcastle reads them. Sandcastle's own
// placeholders ({{ISSUE_NUMBER}}, {{TICKET}}, {{SOURCE_BRANCH}}, ...) are left for it.
// ---------------------------------------------------------------------------

// A log is named agent-issue-<id>-<phase>-<id>.log, so the id appears twice and
// the repeat tells a ticket called "code-review-01" from phase "review". Logs
// from hand-suffixed branches (agent-issue-12-closeout-impl-...) fall back
// to the first phase word.
export const logOwner = (name: string) =>
  name.match(/^agent-issue-(.+)-(?:impl|resolve|review-codex|review|repair|gates)-\1\.(?:log|jsonl)$/)?.[1] ??
  name.match(/^agent-issue-([a-z0-9][a-z0-9-]*?)-(?:impl|resolve|review|repair|gates)-/)?.[1];

/** Where the orchestrator writes an issue's gate output as it runs; named like an agent log so it is archived with them. */
export const gatesLog = (project: Project, id: string) => join(project.root, `.sandcastle/logs/agent-issue-${id}-gates-${id}.log`);

/** The log Sandcastle writes for branch `agent/issue-<id>` and run name `name`; it mirrors Sandcastle's own filename sanitising. */
export const agentLog = (project: Project, id: string, name: string) =>
  join(project.root, ".sandcastle/logs", `agent-issue-${id}-${name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}.log`);

/** The sidecar that keeps an agent pass's raw stream beside its readable log. */
export const rawLog = (log: string) => log.replace(/\.log$/, ".jsonl");

/**
 * Sandcastle's `logging` option for one agent pass: the readable log goes where it always did, and every raw
 * stdout line the agent printed (tool calls and results its parser drops) is appended to the `.jsonl` sidecar.
 */
export const agentLogging = (project: Project, id: string, name: string, runId: string): LoggingOption => {
  const log = agentLog(project, id, name);
  markLog(log, runId);
  const raw = rawLog(log);
  // A JSON marker, not markLog's "# run" line, so the sidecar stays valid JSONL.
  appendFileSync(raw, JSON.stringify({ sandcastle: "run", run: runId, name, at: new Date().toISOString() }) + "\n");
  return {
    type: "file",
    path: log,
    onAgentStreamEvent: (event) => {
      if (event.type !== "raw") return;
      try {
        appendFileSync(raw, event.line + "\n");
        // The library's parser drops every tool result, so a failed call left no trace in the readable log.
        const failure = toolFailureLine(event.line);
        if (failure) appendFileSync(log, failure + "\n");
      } catch {
        // A full disk must not fail an agent pass; the library swallows a throwing callback too.
      }
    },
  };
};

/**
 * `! error: <first line>` (or `! exit N: <first line>` for a command's non-zero exit) for each failed tool
 * result in one raw stream line, else undefined. A result is failed when it says `is_error`, as a call to a
 * tool that does not exist does, or when its text opens with Claude Code's `Exit code N`.
 */
export const toolFailureLine = (line: string): string | undefined => {
  if (!line.includes("tool_result")) return undefined;
  let event: { type?: string; message?: { content?: unknown } };
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const content = event.message?.content;
  if (event.type !== "user" || !Array.isArray(content)) return undefined;
  const lines: string[] = [];
  for (const part of content as { type?: string; is_error?: boolean; content?: unknown }[]) {
    if (part?.type !== "tool_result") continue;
    const body = typeof part.content === "string"
      ? part.content
      : Array.isArray(part.content) ? part.content.map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
    const code = body.match(/^\s*Exit code (-?\d+)/)?.[1];
    if (!part.is_error && (code === undefined || code === "0")) continue;
    // Claude Code wraps its own refusals in a <tool_use_error> tag, and a failed command's output follows its
    // `Exit code N` line: the first line that says something is the one to show.
    const said = body.replace(/<\/?tool_use_error>/g, "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const text = (code === undefined ? said[0] : said[0]?.replace(/^Exit code -?\d+\s*:?\s*/, "") || said[1]) ?? "";
    lines.push(`! ${code === undefined || code === "0" ? "error" : `exit ${code}`}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  return lines.length ? lines.join("\n") : undefined;
};

/** A line `toolFailureLine` wrote. It quotes a tool's output, so a check of what the library or the agent said skips it. */
export const isToolFailureLine = (line: string) => /^! (error|exit -?\d+)(: |$)/.test(line);

// What a spent plan allowance leaves at the end of an agent's log.
const LIMIT = /out of usage credits|usage limit|limit reached/i;

/** Whether a readable log ends saying the plan allowance is spent. Not a failed tool's line: a test or a file can say "usage limit". */
export const logSaysLimit = (text: string) =>
  LIMIT.test(text.split("\n").filter((l) => !isToolFailureLine(l)).slice(-8).join("\n"));

/**
 * The library ends each pass with "Context window: Nk", which is the sum of input, cache-write and cache-read
 * tokens over every turn - tokens processed, not a window. Rewritten once the pass has returned; safe to repeat.
 */
export const relabelContextWindow = (log: string) => {
  try {
    const text = readFileSync(log, "utf8");
    const out = text.replace(/^Context window: (\d+k)$/gm, "Tokens processed (all turns): $1");
    if (out !== text) writeFileSync(log, out);
  } catch {
    // No log to rewrite (the pass died before writing one) is not a failure of the pass.
  }
};

export { localStamp };

/**
 * Separates one run's output from the last in a log that accumulates across attempts and runs. `what` names the
 * kind of run ("landing gates on the merged tree"): a ticket's gates log holds several, and the header is
 * all that tells a red landing from the ticket's own gates.
 */
export const markLog = (file: string, runId: string | undefined, what?: string) => {
  mkdirSync(dirname(file), { recursive: true });
  // `sandcastle land` has no run: its section is headed by the kind alone.
  const head = [what, runId === undefined ? undefined : `run ${runId}`].filter(Boolean).join(" - ");
  appendFileSync(file, `\n# ${head}, ${localStamp()}\n`);
};

// Sandcastle warns about an argument its prompt never mentions, so each run
// gets only the ones its rendered prompt uses.
export const usedArgs = (promptFile: string, args: Record<string, string>) => {
  const text = readFileSync(promptFile, "utf8");
  return Object.fromEntries(Object.entries(args).filter(([k]) => text.includes(`{{${k}}}`)));
};

// A repair agent works against a red gate, where the easy way to green is to
// weaken the test. Its commits used to land unreviewed, trusted to the repair
// prompt's rules alone.
const AFTER_REPAIR =
  "# This is a second review, after a repair\n\n" +
  "This branch was reviewed once. Then a gate went red, and a repair agent committed the fixes below to turn it " +
  "green. Nobody has reviewed those commits. Review them now, above all for what a repair under pressure gets " +
  "wrong: a test weakened, skipped or deleted, an assertion loosened, an expected value changed to match a wrong " +
  "result, a guard removed, an error swallowed instead of fixed. Put back what should not have gone, and fix the " +
  "cause instead. The rest of the branch was reviewed already: leave it alone unless a repair commit broke it.\n\n" +
  "!`git log -p {{REPAIR_BASE}}..HEAD --format='%h %s%n%b'`\n\n";

// A re-run's only new commits can be the kit's base merge, with a conflict
// resolved inside it. `--cc` shows a merge's resolution hunks alone and
// `--first-parent` keeps the base's own commits out of the log.
const AFTER_MERGE =
  "# This is a second review, after a base merge\n\n" +
  "This branch was reviewed in full at {{REVIEW_BASE}}. Since then the only change is that `{{TARGET_BRANCH}}` was " +
  "merged into it, with any conflicts resolved inside the merge. Nobody has reviewed that resolution. Below is each " +
  "merge's combined diff, which shows only the lines that differ from both sides - the resolution. Review it for what " +
  "a hurried resolution gets wrong: one side's change dropped, both sides kept where only one belongs, a block " +
  "duplicated, a call or import left pointing at code the other side renamed or removed. The rest of the branch was " +
  "reviewed already: leave it alone unless the merge broke it.\n\n" +
  "!`git log -p --cc --first-parent {{REVIEW_BASE}}..HEAD --format='%h %s%n%b'`\n\n";

// What `changelog: true` adds to the implement and review prompts. The tag's dots are the
// placeholder the orchestrator ignores if an agent echoes it back (see `changelogOf`).
const CHANGELOG_ASK =
  "**Changelog lines.** This project's changelog is written from the closing summary, so do not edit the changelog file. " +
  "Say what each user-facing change belongs in it as, one line each, in a tag on a line of its own:\n\n" +
  "<changelog>...</changelog>\n\n" +
  "with a sentence in place of the dots, starting `Added:`, `Changed:` or `Fixed:`. Write the sentence for a reader of the " +
  "changelog, not the diff. " +
  "A change an existing project must act on - a new default that changes what a run does or spends, a new convention, " +
  "something `init` now writes differently, a step to run again (a setup or configure command, say) - also needs a line " +
  "starting `Upgrading:` that says what to do, in its own tag. The closing summary lists it apart from the ordinary lines, " +
  "so do not fold the instruction into a `Changed:` line. If this project's own rules define an upgrading or migration note, " +
  "write it in their words. ";
const CHANGELOG_IMPLEMENT = `${CHANGELOG_ASK}Give none for a change nobody outside the code would notice.\n\n`;
// A full review that could not see the implementer's lines wrote the whole set again from the diff; it is
// shown them (per ticket, as `IMPL_UNMET` is), so it keeps the ones that hold and corrects or adds the rest.
const CHANGELOG_REVIEW =
  `${CHANGELOG_ASK}The implementer's own lines, if it gave any, are quoted just below this paragraph; none quoted means it gave ` +
  "none. If the diff shows a user-facing change you made yourself " +
  "in this review, or a line of the implementer's that would now be wrong, give the full set of lines for the whole branch - " +
  "its changes as well as yours, one line each, the implementer's lines that still hold copied as they are: your set replaces " +
  "the implementer's, so a line left out is lost, and a reworded one is not shown twice. Otherwise give none, and the " +
  "implementer's lines stand. If the change needs an `Upgrading:` line and none of the implementer's lines is one, give the " +
  "full set with one in it (do not leave that to a remark in your message).\n\n{{IMPL_CHANGELOG}}";

// What a full review is shown of the implementer's changelog lines, for `IMPL_CHANGELOG`: each line quoted, and
// nothing when it gave none (the prompt says that none quoted means none given). Only a full review has the
// placeholder: a narrow review gives lines for its own changes alone and they are added to the implementer's.
export const implChangelogView = (lines: string[]): string => (lines.length ? `${lines.map((l) => `> ${l}`).join("\n")}\n\n` : "");

// A narrow review (after a repair, a base merge or a conflict resolution) sees only what it reviews, so it
// gives lines for its own changes and the orchestrator adds them (see `addChangelog`).
const CHANGELOG_NARROW =
  `${CHANGELOG_ASK}The implementer has given its own, which you cannot see, and you see only the commits above, not the ` +
  "branch. Give lines only for a user-facing change you made yourself in this review, one line each; they are added to the " +
  "implementer's, so do not restate the branch's changes. If you made none, give none. If a change you made needs an " +
  "`Upgrading:` line, give it (do not leave that to a remark in your message).\n\n";

export const renderPrompts = (project: Project, tracker: Tracker, dryRun = false) => {
  const rules = project.rules
    ? `# Project rules\n\n${readFileSync(join(project.root, project.rules), "utf8").trim()}\n`
    : "";
  const out = join(project.root, ".sandcastle/.run");
  mkdirSync(out, { recursive: true });
  const paths = { implement: "", review: "", repair: "", rereview: "", remerge: "", resolve: "" };
  // `remerge` is the same prompt for a re-run whose only change since its last review is
  // the base merge: it shows the merge's resolution, not the whole branch again.
  // `rereview` is the review prompt again, for the review after a repair pass
  // committed: it names the unreviewed repair commits and what to look for in them.
  // `resolve` finishes a conflicted base merge on a branch already reviewed and green.
  for (const kind of ["implement", "review", "repair", "rereview", "remerge", "resolve"] as const) {
    // Function replacements: a `$&` or `$'` in a rule or gate is text, not a
    // replacement pattern.
    const text = readFileSync(join(KIT, `prompts/${kind === "rereview" || kind === "remerge" ? "review" : kind}.md`), "utf8")
      .replaceAll("{{KIT_AFTER_REPAIR}}", () => (kind === "rereview" ? AFTER_REPAIR : kind === "remerge" ? AFTER_MERGE : ""))
      .replaceAll(/\{\{KIT_(LOST|TICKET_VIEW|COMMENTS_VIEW|RECORD|NOCHANGE|BLOCKED|SAY)\}\}/g, (_, k: keyof Tracker["words"]) => tracker.words[k])
      .replaceAll("{{KIT_GATES}}", () => project.gates.map((g) => g.command).join("\n"))
      .replaceAll("{{KIT_LABEL}}", () => project.label)
      .replaceAll("{{KIT_PROJECT_RULES}}", () => rules)
      .replaceAll("{{KIT_CHANGELOG}}", () => (!project.changelog ? "" : kind === "implement" ? CHANGELOG_IMPLEMENT : kind === "rereview" || kind === "remerge" ? CHANGELOG_NARROW : CHANGELOG_REVIEW))
      .replaceAll("{{KIT_DRY_RUN}}", () => (dryRun ? tracker.dryRunNote : ""));
    // Sandcastle refuses a prompt with any other {{NAME}} - but only inside
    // the sandbox, after the install. Refuse it here instead. (A literal
    // {{...}} in rules.md, e.g. a template variable, has to be reworded.)
    const allowed = new Set(["ISSUE_NUMBER", "TICKET", "TICKET_BODY", "SOURCE_BRANCH", "TARGET_BRANCH"]);
    // The orchestrator fills these for a repair pass. Sandcastle substitutes
    // in one pass, so gate output holding `{{...}}` or a shell block stays text.
    if (kind === "repair") for (const k of ["GATE_NAME", "GATE_COMMAND", "GATE_OUTPUT"]) allowed.add(k);
    // The implementer's unmet line, which a full review is asked to finish or restate (empty when there is none, and for a narrow review).
    if (kind === "review" || kind === "rereview" || kind === "remerge") allowed.add("IMPL_UNMET");
    // Likewise the implementer's changelog lines, in the full review's changelog ask only (CHANGELOG_REVIEW).
    if (kind === "review") allowed.add("IMPL_CHANGELOG");
    if (kind === "rereview") allowed.add("REPAIR_BASE");
    if (kind === "remerge") allowed.add("REVIEW_BASE");
    const unknown = [...text.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)].map((m) => m[1]).filter((n) => !allowed.has(n));
    if (unknown.length) {
      throw new Error(`The ${kind} prompt has placeholders Sandcastle cannot fill: ${[...new Set(unknown)].map((n) => `{{${n}}}`).join(", ")} - from ${project.rules ?? "the kit template"}.`);
    }
    paths[kind] = join(out, `${kind}.md`);
    writeFileSync(paths[kind], text);
  }
  return paths;
};

// ---------------------------------------------------------------------------
// Run record - status.sh reads it for its header. `pid` tells it whether the
// run is still alive; `finishedAt` is written on a clean exit.
// ---------------------------------------------------------------------------

/**
 * A run killed without its exit handler (SIGKILL, the machine going down) never wrote its history
 * line, and this record's first write replaces its `run.json`: so a record that has not finished
 * and whose process is gone is appended to history first, with the changelog lines it holds. A
 * record of a live run (another process of this project) or of this very process is left alone.
 */
const keepKilledRecord = (root: string, file: string) => {
  try {
    if (!existsSync(file)) return;
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    if (liveness({ record, self: process.pid }, commandOf).state !== "dead") return;
    appendFileSync(join(root, ".sandcastle/logs/history.jsonl"), JSON.stringify(record) + "\n");
  } catch {
    /* history is a convenience: an unreadable record is replaced, as it always was */
  }
};

let current: ((code: number | undefined) => void) | undefined;
let exitHooked = false;

export const recordRun = (project: Project, extra: RunRecord = {}, onEnd?: (run: RunRecord) => void) => {
  // Before this record's first write: finishing the old one rewrites run.json.
  current?.(0);
  const file = join(project.root, ".sandcastle/logs/run.json");
  mkdirSync(join(project.root, ".sandcastle/logs"), { recursive: true });
  keepKilledRecord(project.root, file);
  // Only the id: the session's other variables include tokens. It tells the Claude Code mod
  // whose run this is, wherever the project's root is.
  const session = sessionId(process.env.CLAUDE_CODE_SESSION_ID);
  let run: RunRecord = { orchestrator: project.name, pid: process.pid, ...(session ? { session } : {}), startedAt: new Date().toISOString(), models: MODELS_LINE, ...extra };
  // Written whole and renamed into place: the view reads it every few seconds,
  // and a half-written file read as no record at all, so every row fell back
  // to the guesswork the record is there to replace.
  const write = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  };
  write();
  // One process can hold several runs (autonomy turns): a new record finishes the one before it,
  // and the single exit handler finishes the last. Each finishes once.
  let finished = false;
  const finish = (code: number | undefined) => {
    if (finished) return;
    finished = true;
    run = { ...run, finishedAt: new Date().toISOString(), exitCode: code, ...(endedBy ? { stoppedBy: endedBy } : {}) };
    write();
    // run.json is overwritten by the next run, so each finished run also leaves one
    // line here. A failed append must never change the process's exit.
    try {
      appendFileSync(join(project.root, ".sandcastle/logs/history.jsonl"), JSON.stringify(run) + "\n");
    } catch {
      /* history is a convenience; the run itself already ended */
    }
    // After the history line, so a notifier that hangs or throws cannot cost the record.
    try {
      onEnd?.(run);
    } catch {
      /* a callback must not change the exit */
    }
  };
  current = finish;
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", (code) => current?.(code));
  }
  return {
    startedAt: run.startedAt!,
    /** The record is finished: nothing writes to it any more, and a timer that did should stop. */
    get finished() {
      return finished;
    },
    /** `stage` is what the status view's run line shows while the run is live. */
    update(fields: RunRecord) {
      run = { ...run, ...fields };
      write();
    },
    tickets: (): Record<string, TicketRecord> => run.tickets ?? {},
    /** A person has the run paused (`paused` in the record). */
    paused: () => run.paused !== undefined,
    /** The plan usage the record holds now, for the Herdr sidebar's token. */
    usage: () => run.usage,
    /** A new `state` also restarts its clock; a note alone does not. */
    ticket(id: string, fields: TicketRecord) {
      const tickets = run.tickets ?? {};
      const now = fields.state ? { since: Math.floor(Date.now() / 1000), note: null } : {};
      run = { ...run, tickets: { ...tickets, [id]: { ...tickets[id], ...now, ...fields } } };
      write();
    },
  };
};

// ---------------------------------------------------------------------------
// Typical times - how long each step of an issue usually takes in this
// project, from earlier runs' timings. The status view marks a step running
// at twice its usual time (and says so in words at three times), and estimates when landing starts: a run that is
// busy but healthy and one that is stuck looked the same for an hour.
// ---------------------------------------------------------------------------

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);

/**
 * The timings lines `typicalTimes` and `estimate` both read: those of this
 * project's three most recent runs (the `run` field is an ISO timestamp) that
 * have a ticket line, widened to older runs, newest first, until they hold
 * `MIN_TICKETS` tickets (a `run|issue` pair) or the history ends. A project's
 * tickets change size over time, so a batch of small ones from weeks ago must
 * not set what "usual" means for the large ones now. Lines without a `run`
 * count as one run older than every run that has one. `lines` are ticket
 * lines already (an issue, not 0, and a numeric `ms`).
 */
const RECENT_RUNS = 3;
const MIN_TICKETS = 5;
export const recentWindow = <T extends { run?: unknown; issue?: unknown }>(lines: T[]): T[] => {
  const runOf = (l: T) => (typeof l.run === "string" ? l.run : "");
  const byRun = new Map<string, T[]>();
  for (const l of lines) byRun.set(runOf(l), [...(byRun.get(runOf(l)) ?? []), l]);
  const newestFirst = [...byRun.keys()].sort().reverse();
  const picked: T[] = [];
  const tickets = new Set<string>();
  for (const [i, run] of newestFirst.entries()) {
    if (i >= RECENT_RUNS && tickets.size >= MIN_TICKETS) break;
    for (const l of byRun.get(run)!) {
      picked.push(l);
      tickets.add(`${run}|${l.issue}`);
    }
  }
  return picked;
};

/**
 * Seconds per step, and `issue` for one whole issue (its own pipeline: not the landing gate, nor a landing's own line); `extra` adds this run's finished issues (ms).
 * `LANDING_GATES` is one ticket's landing gates summed, the median over the window's tickets that landed (a fast-forward,
 * with no gate, counts 0; a held, red or conflicted ticket, or one from before landings were timed, is no landing), and
 * absent when the window has no landing.
 */
export const typicalTimes = (project: Project, extra: number[] = []) => {
  let lines: { project?: string; run?: string; issue?: unknown; phase?: string; ms?: number; ok?: boolean }[] = [];
  try {
    lines = readFileSync(join(project.root, ".sandcastle/logs/timings.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    /* no runs yet */
  }
  // Steps before the agents are issue 0 (or "" in older lines).
  const steps = recentWindow(lines.filter((l) => l.project === project.name && l.issue && String(l.issue) !== "0" && typeof l.ms === "number"));
  const byPhase = new Map<string, number[]>();
  const byIssue = new Map<string, number>();
  const landing = new Map<string, number>();
  for (const l of steps) {
    const key = `${l.run}|${l.issue}`;
    if (l.phase === LANDING_GATES) {
      landing.set(key, (landing.get(key) ?? 0) + l.ms!);
      continue;
    }
    // A landing's own line holds its landing gates' time already: left out, or it counts them twice. A merged one
    // does say the ticket landed: a fast-forward's, with no gates, is a landing of 0. A conflict's is none.
    if (l.phase === LANDING) {
      if (l.ok === true) landing.set(key, landing.get(key) ?? 0);
      continue;
    }
    byPhase.set(l.phase!, [...(byPhase.get(l.phase!) ?? []), l.ms!]);
    byIssue.set(key, (byIssue.get(key) ?? 0) + l.ms!);
  }
  const out: Record<string, number> = {};
  for (const [phase, ms] of byPhase) out[phase] = Math.round(median(ms)! / 1000);
  const issue = median([...byIssue.values(), ...extra]);
  if (issue !== undefined) out.issue = Math.round(issue / 1000);
  if (landing.size) {
    // Over the tickets that landed: one held, red or from before landings were timed has no landing to count, and
    // counting it as 0 made the median 0 when most of a window had none.
    const landMs = median([...landing.values()]);
    if (landMs !== undefined) out[LANDING_GATES] = Math.round(landMs / 1000);
  }
  return out;
};

/**
 * Seconds until the first ticket of another live run is likely to end, for the start line of a run
 * that has to wait for a slot: this project's usual time for one issue (`typicalTimes`, the history
 * the estimate reads) less each working ticket's age, a minute at least, as the status view counts
 * it. Undefined with no history or no working ticket - the line then leaves the wait out.
 */
export const firstSlotWait = (project: Project, record: RunRecord, nowMs = Date.now()): number | undefined => {
  const typical = typicalTimes(project).issue;
  if (typical === undefined) return undefined;
  // From the current attempt's start: a requeued second attempt is a pipeline of its own.
  const left = Object.values(record.tickets ?? {}).flatMap((t) => {
    const from = t.attemptStarted ?? t.started;
    return t.state && GROUPS[t.state] === "working" && t.state !== "landing" && typeof from === "number" ? [Math.max(typical - (nowMs / 1000 - from), 60)] : [];
  });
  return left.length ? Math.min(...left) : undefined;
};

const k = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/**
 * Whether ticket `id` is carried work: its branch `agent/issue-<id>` exists and is ahead of the base
 * (the branch a `heads.json` entry names, or one an earlier run left). A carried branch gets a base
 * merge, often a conflict to resolve, and a review of work it already has, so it costs more than a
 * fresh ticket; the estimate prices the two apart, and the timings lines of a carried ticket say so.
 */
export const isCarried = (root: string, base: string, id: string): boolean => {
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/agent/issue-${id}`], root);
    return Number(sh("git", ["rev-list", "--count", `refs/heads/${base}..refs/heads/agent/issue-${id}`], root)) > 0;
  } catch {
    return false; // no such branch, or git failed
  }
};

/** The nearest-rank percentile, `p` in (0, 1]; the median above takes the middle one, this the one a fraction `p` of the list is at or below. */
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length, Math.max(1, Math.ceil(xs.length * p))) - 1];
const HIGH = 0.8;
/** A history run is of a similar load when its concurrency is within this many of the run's; at least `LOAD_RUNS` of them price the gate times. */
const LOAD_BAND = 1;
const LOAD_RUNS = 2;
/** Tickets of one model in the window that make its own history solid; fewer are blended with all tickets. */
const SOLID_HISTORY = 5;

/**
 * A rough estimate for a run about to start, as a range: the median to the 80th percentile of the
 * tokens and time of this project's tickets in its last three runs (from timings.jsonl, see
 * `recentWindow`), summed over `tickets`, with
 * the time the tickets' summed figures divided across `slots` (floored at the slowest single ticket's figure, at the median and at the
 * high end alike), or the chain's own tickets' times one after another when that is
 * longer (`chain` is the longest in-run `Blocked by` chain's length; `detail.chainAt` says which
 * tickets, by their place in `models`, and without it each takes the average). Undefined until an earlier ticket has
 * recorded tokens, so a new project prints nothing rather than a guess. It
 * covers the tickets' own pipelines and their landings (a ticket's landing gates): the last ticket's
 * after the pipelines, and every chain link's, since a dependant starts only once its blocker has
 * landed. The base gates and verify (the `base gates` and `verify` lines of the window's runs) are
 * added to it, as they run before every ticket and after the last; the image check and preflight are not.
 * `from N ticket(s)` is how many history tickets priced the run's, not how many the window holds. A line that does not parse is skipped.
 *
 * `models` is the implement model of each ticket in the run (its `model:` label, else the default):
 * each is estimated from the history of tickets that model implemented, as an Opus ticket takes
 * several times a Sonnet one. A history ticket's model is the one on its implement or repair
 * lines; lines with none (older ones) count as the default model. A model with no history falls
 * back to all of them, and the line says it is low. A model with fewer than `SOLID_HISTORY` tickets
 * is blended with all of them, and the line says so (`<model> from 2 tickets, blended`). Without `models` every ticket is estimated
 * from all of them.
 *
 * `detail.carried` says which tickets of the run are carried branches (`isCarried`). A carried
 * ticket is estimated from the history tickets that were carried (a `carried` field on their lines,
 * or a `resolve` pass and no implement), a fresh one from the rest, each falling back to the other
 * when it has no history of its own; a carried ticket with none says the estimate is low. A history
 * ticket implemented and requeued in its own run is a fresh sample, and its lines from the first
 * resolve on (resolve, narrow review, gates) a carried one: a carried branch's attempt is not its
 * ticket's first one.
 *
 * The gate and landing-gate times (not the bounds that combine them) are priced from the window's runs whose recorded `load` (the
 * run's effective concurrency, in `history.jsonl`, joined by `startedAt`) is within `LOAD_BAND` of `slots`, when `LOAD_RUNS` such
 * runs are in the window; a run with no `load` is unknown and counts only in the fallback, which prices them from all the window's
 * runs and says there is no history at this concurrency, so the estimate may be low.
 *
 * `detail.gateSlots` is the machine's gates pool (`limit("gates")`): every ticket's gate passes (the
 * pre-landing `gates` lines, and the `landing gates` lines) share it, so the run takes at least their
 * summed time over those slots, and the larger of that and the sandbox-bound or chain figure sets the
 * time. Without it the gates are not modelled. The landing gates alone, summed (each ticket's, from the
 * history tickets', none for one that landed without a gate), are a floor of their own: landings run in
 * a row on the one worker, whatever the slots, so they count with or without `gateSlots`.
 */
export const estimate = (
  project: Project, tickets: number, slots: number, chain = 0, models?: string[], detail: { carried?: boolean[]; chainAt?: number[]; gateSlots?: number } = {},
): string | undefined => {
  let text: string;
  try {
    text = readFileSync(join(project.root, ".sandcastle/logs/timings.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  type Line = { project?: string; run?: unknown; phase?: unknown; model?: unknown; issue?: unknown; ms?: unknown; carried?: unknown; tokens?: { input?: number; cacheWrite?: number; cacheRead?: number; output?: number } };
  type Group = {
    ms: number; gateMs: number; landMs: number; tokened: boolean; inTokens: number; out: number; carried: boolean; model?: string;
    // The run it was timed in: its load, if the history knows it, says whether its gate times are this run's to borrow.
    run?: string;
    // Seen while grouping: a `carried` field on a line, a resolve pass, an implement pass.
    flagged?: boolean; resolved?: boolean; implemented?: boolean;
    // A ticket implemented and requeued in the same run: what came after its first resolve, the cost of a carried branch's attempt.
    tail?: Group;
    // The history ticket a `tail` was cut from, so the line counts tickets.
    origin?: Group;
  };
  const groups = new Map<string, Group>();
  const ticketLines: Line[] = [];
  // The run's own steps before and after the tickets (issue 0): base gates hold every agent back, and verify follows the last landing.
  const stageLines: Line[] = [];
  for (const raw of text.split("\n").filter(Boolean)) {
    let l: Line;
    try {
      l = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!l || typeof l !== "object" || l.project !== project.name || typeof l.ms !== "number") continue;
    if (!l.issue || String(l.issue) === "0") {
      if (l.phase === "base gates" || l.phase === "verify") stageLines.push(l);
      continue;
    }
    ticketLines.push(l);
  }
  const window = recentWindow(ticketLines);
  for (const l of window) {
    // A landing's own line (`LANDING`) holds its landing gates' time, which is `landMs`: priced once, there.
    if (l.phase === LANDING) continue;
    const key = `${l.run}|${l.issue}`;
    const g = groups.get(key) ?? { ms: 0, gateMs: 0, landMs: 0, tokened: false, inTokens: 0, out: 0, carried: false, run: String(l.run) };
    // A landing gate is the landing worker's time, not the ticket's own pipeline.
    if (l.phase === LANDING_GATES) g.landMs += l.ms as number;
    else g.ms += l.ms as number;
    // A ticket's gate passes (the pre-landing `gates` lines, `waitMs` already out of `ms`): the time it holds a gates slot.
    if (l.phase === "gates") g.gateMs += l.ms as number;
    if (l.carried === true) g.flagged = true;
    if (l.phase === "implement") g.implemented = true;
    if (l.phase === "resolve") {
      g.resolved = true;
      g.tail ??= { ms: 0, gateMs: 0, landMs: 0, tokened: false, inTokens: 0, out: 0, carried: true, origin: g, run: g.run };
    }
    // From the first resolve on, the lines are the carried branch's attempt, which a ticket implemented in this run is requeued into.
    const t = g.tail;
    if (t) {
      if (l.phase === LANDING_GATES) t.landMs += l.ms as number;
      else t.ms += l.ms as number;
      if (l.phase === "gates") t.gateMs += l.ms as number;
      if (l.tokens && typeof l.tokens === "object") {
        t.tokened = true;
        t.inTokens += (l.tokens.input ?? 0) + (l.tokens.cacheWrite ?? 0) + (l.tokens.cacheRead ?? 0);
        t.out += l.tokens.output ?? 0;
      }
    }
    // The review lines name the reviewer's model: only the steps the implementer ran say who implemented.
    if ((l.phase === "implement" || l.phase === "repair") && typeof l.model === "string" && l.model) g.model ??= l.model;
    if (l.tokens && typeof l.tokens === "object") {
      g.tokened = true;
      g.inTokens += (l.tokens.input ?? 0) + (l.tokens.cacheWrite ?? 0) + (l.tokens.cacheRead ?? 0);
      g.out += l.tokens.output ?? 0;
    }
    groups.set(key, g);
  }
  // Carried: a branch from an earlier run (its lines say so) or one with a resolve and no implement in this run. A ticket
  // implemented and requeued in the same run is a fresh one, and its tail is a carried sample of its own: pricing a carried
  // ticket from its whole first attempt put the estimate at twice the real time.
  for (const g of groups.values()) {
    g.carried = g.flagged === true || (g.resolved === true && !g.implemented);
    if (g.carried || g.implemented !== true || !g.tail?.tokened) g.tail = undefined;
  }
  const counted = [...groups.values()].filter((g) => g.tokened);
  const samples = (g: Group): Group[] => (g.tail ? [g, g.tail] : [g]);
  if (!counted.length) return undefined;
  // Gate and landing-gate times slow with the load (a full queue runs several suites at once), so they are priced from the runs
  // that ran at about this run's concurrency - within `LOAD_BAND` of `slots` - when the window holds `LOAD_RUNS` of them. The
  // history says each run's load (its line's `load`, joined by `startedAt`); a run with none is unknown, used in the fallback only.
  const loads = new Map<string, number>();
  try {
    for (const raw of readFileSync(join(project.root, ".sandcastle/logs/history.jsonl"), "utf8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(raw);
        const c = r?.load?.concurrency;
        if (typeof r?.startedAt === "string" && typeof c === "number" && Number.isFinite(c)) loads.set(r.startedAt, c);
      } catch {
        /* a line that does not parse is skipped */
      }
    }
  } catch {
    /* no history: every run's load is unknown */
  }
  const similar = new Set([...new Set(window.map((l) => String(l.run)))].filter((r) => {
    const c = loads.get(r);
    return c !== undefined && Math.abs(c - slots) <= LOAD_BAND;
  }));
  const byLoad = similar.size >= LOAD_RUNS;
  const figures = (gs: Group[], at: (xs: number[]) => number) => {
    // This pool's tickets from a run of a similar load; one with none keeps its own, as the fallback does.
    const loaded = byLoad ? gs.filter((g) => g.run !== undefined && similar.has(g.run)) : [];
    const gates = loaded.length ? loaded : gs;
    const gateMs = at(gates.map((g) => g.gateMs));
    // A ticket's pipeline time holds its gate passes: with the gate time priced by load, each history ticket's own passes are swapped for it.
    const ms = loaded.length ? at(gs.map((g) => g.ms - g.gateMs + gateMs)) : at(gs.map((g) => g.ms));
    return { inTokens: at(gs.map((g) => g.inTokens)), out: at(gs.map((g) => g.out)), ms, gateMs, landMs: at(gates.map((g) => g.landMs)) };
  };
  // Each ticket of the run: the figures at the median and at the high end.
  let unknown = 0;
  let lowCarried = 0;
  // The history tickets some ticket of the run was priced from: the line's count, not the window's.
  const pricedFrom = new Set<Group>();
  const thin = new Map<string, number>();
  const per = Array.from({ length: tickets }, (_, at) => {
    const carried = detail.carried?.[at] ?? false;
    const model = models?.[at];
    const ofModel = model === undefined ? counted : counted.filter((g) => (g.model ?? IMPL_MODEL) === model);
    if (!ofModel.length) unknown++;
    else if (ofModel.length < SOLID_HISTORY && model !== undefined) thin.set(model, ofModel.length);
    const priced = (pool: Group[]) => {
      const same = pool.flatMap(samples).filter((g) => g.carried === carried);
      const use = same.length ? same : pool;
      for (const g of use) pricedFrom.add(g.origin ?? g);
      return { mid: figures(use, median as (xs: number[]) => number), high: figures(use, (xs) => percentile(xs, HIGH)) };
    };
    if (carried && !(ofModel.length >= SOLID_HISTORY ? ofModel : counted).flatMap(samples).some((g) => g.carried)) lowCarried++;
    if (!ofModel.length || ofModel.length >= SOLID_HISTORY || model === undefined) return priced(ofModel.length ? ofModel : counted);
    // A model with a few tickets only is blended with all of them, weighted by how many it has: two dear tickets in
    // the window are not a median to price a run by, and the other models' median alone prices it as one of them.
    const own = priced(ofModel);
    const all = priced(counted);
    const w = ofModel.length / SOLID_HISTORY;
    type Figures = ReturnType<typeof figures>;
    const mix = (a: Figures, b: Figures) =>
      Object.fromEntries((Object.keys(a) as (keyof Figures)[]).map((k) => [k, w * a[k] + (1 - w) * b[k]])) as Figures;
    return { mid: mix(own.mid, all.mid), high: mix(own.high, all.high) };
  });
  const sum = (pick: (p: (typeof per)[number]) => number) => per.reduce((n, p) => n + pick(p), 0);
  // A chain of in-run `Blocked by` runs one ticket after another, whatever the slots: its tickets' own times.
  const minutes = (pick: (p: (typeof per)[number]) => number, gate: (p: (typeof per)[number]) => number, land: (p: (typeof per)[number]) => number) => {
    // The tickets' summed figures over the slots, not whole rounds: a sixth ticket on five slots starts when the first slot
    // frees, so it is not a round of its own. No run is shorter than its slowest ticket, whatever the slots.
    // The run ends when its last ticket has landed: one landing after the pipelines.
    const serial = Math.max(sum(pick) / Math.max(slots, 1), per.reduce((n, p) => Math.max(n, pick(p)), 0)) + sum(land) / Math.max(tickets, 1);
    // A dependant starts only once its blocker has landed, so each link is its pipeline and its landing, the last one's too.
    const link = (p: (typeof per)[number]) => pick(p) + land(p);
    const chained = detail.chainAt?.length ? detail.chainAt.reduce((n, at) => n + (per[at] ? link(per[at]) : 0), 0) : chain * (sum(link) / Math.max(tickets, 1));
    // Every ticket's gate passes share the machine's gate slots, whatever the sandboxes: the run cannot finish before they have all run.
    // The landing gates take gates slots too, beside the tickets' own passes.
    const gated = detail.gateSlots && detail.gateSlots > 0 ? (sum(gate) + sum(land)) / detail.gateSlots : 0;
    // Landings go one at a time on one worker, whatever the slots: their gates in a row are a floor on the end.
    const landed = sum(land);
    return { serial, chained, gated, landed };
  };
  const midMs = minutes((p) => p.mid.ms, (p) => p.mid.gateMs, (p) => p.mid.landMs);
  const highMs = minutes((p) => p.high.ms, (p) => p.high.gateMs, (p) => p.high.landMs);
  const clock = (ms: number) => {
    const m = Math.round(ms / 60_000);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  };
  const span = (lo: number, hi: number, show: (n: number) => string) => (show(lo) === show(hi) ? show(lo) : `${show(lo)} to ${show(hi)}`);
  // Base gates and verify, from the runs the window holds: one each per run, before every ticket and after the last.
  const windowRuns = new Set(window.map((l) => String(l.run)));
  const stage = (phase: string, at: (xs: number[]) => number) => {
    const ms = stageLines.filter((l) => l.phase === phase && windowRuns.has(String(l.run))).map((l) => l.ms as number);
    return ms.length ? at(ms) : 0;
  };
  const steps = (at: (xs: number[]) => number) => stage("base gates", at) + stage("verify", at);
  const midSteps = steps(median as (xs: number[]) => number);
  const highSteps = steps((xs) => percentile(xs, HIGH));
  const bound = (t: { serial: number; chained: number; gated: number; landed: number }) => Math.max(t.serial, t.chained, t.gated, t.landed);
  const carriedCount = detail.carried?.slice(0, tickets).filter(Boolean).length ?? 0;
  const split = carriedCount ? ` (${carriedCount} carried, ${tickets - carriedCount} fresh)` : "";
  const sequence = chain > 1 && highMs.chained > highMs.serial ? ` (${chain} tickets in sequence)` : "";
  // At a tie too: the tickets' figure ends with a landing of its own, so landings in a row as long as it still set the time.
  const landBound = highMs.landed > 0 && highMs.landed >= Math.max(highMs.serial, highMs.chained, highMs.gated);
  const gateBound = landBound
    ? " (landing gates, one after another, set the time)"
    : highMs.gated > Math.max(highMs.serial, highMs.chained, highMs.landed) ? ` (gate runs on ${detail.gateSlots} slot(s) set the time)` : "";
  const low = [
    ...[...thin].map(([model, n]) => ` ${model} from ${n} ticket${n === 1 ? "" : "s"}, blended.`),
    unknown ? ` ${unknown} ticket(s) use a model with no history here; the estimate is low.` : "",
    lowCarried ? ` ${lowCarried} carried ticket(s) have no carried history here; the estimate is low.` : "",
    byLoad ? "" : ` No history at ${slots} at a time (gate times are from runs of any load), so it may be low.`,
  ].join("");
  return (
    `Estimate (rough, from ${pricedFrom.size} ticket(s) in the last 3 runs): ` +
    `about ${span(sum((p) => p.mid.inTokens), sum((p) => p.high.inTokens), k)} tokens in / ${span(sum((p) => p.mid.out), sum((p) => p.high.out), k)} out ` +
    `and ${span(bound(midMs) + midSteps, bound(highMs) + highSteps, clock)} for ${tickets} ticket(s)${split}, ${slots} at a time${sequence}${gateBound}.${low}`
  );
};

// ---------------------------------------------------------------------------
// Outcomes - what each branch's last run decided, kept across runs in
// logs/outcomes.json by branch slug. The status view shows it on the row, so
// a finished branch reads "gate red" or "dry run: would merge" rather than
// its sandbox's last log line, and a branch from an earlier run is told apart
// from this run's.
// ---------------------------------------------------------------------------

export type Outcomes = Record<string, OutcomeEntry>;

/** A missing or broken file is no outcomes; a kind outside the set (an older kit's entry, a hand edit) is dropped, so no reader takes a state from it. */
export const readOutcomes = (root: string): Outcomes => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, ".sandcastle/logs/outcomes.json"), "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([id, o]) => {
      const { kind, ...rest } = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
      return [id, (isOutcomeKind(kind) ? { ...rest, kind } : rest) as OutcomeEntry];
    }),
  );
};

/** The outcome text of a ticket an agent handed back: held, like work the kit held, but with nothing to merge. */
export const HANDED_BACK = "needs a human: handed back";

/**
 * A branch the kit held for a person - at landing, or a conflict resolution it would not trust - which a
 * person has since merged by hand: its tip is on the base, so its diff is empty, as a hand-back's is.
 * Only the outcome tells the two apart, and only an ancestor check says the merge happened. The ticket
 * stays open until the push closes it.
 */
export const mergedByHand = (root: string, base: string, id: string): boolean => {
  const o = readOutcomes(root)[id];
  if (o?.kind !== "held" || o.text === HANDED_BACK) return false;
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/agent/issue-${id}`]);
  } catch {
    // `sandcastle clean` deletes a branch once its patches are on the base, so a merged branch has no ref
    // to check: the merge's subject on the base is the proof, as the status view takes it. A branch gone
    // with no such subject was never merged by hand, and its merge command would fail.
    try {
      return git(["log", base, "-1", "--format=%H", "--fixed-strings", `--grep=Merge agent/issue-${id} (closes ${refOf(id)})`, `--grep=Merge agent/issue-${id} (part of ${refOf(id)})`]).trim() !== "";
    } catch {
      return false;
    }
  }
  try {
    git(["merge-base", "--is-ancestor", `refs/heads/agent/issue-${id}`, `refs/heads/${base}`]);
    return true;
  } catch {
    return false;
  }
};

export const recordOutcomes = (project: Project, run: string, outcomes: Record<string, Outcome>) => {
  const file = join(project.root, ".sandcastle/logs/outcomes.json");
  const all = readOutcomes(project.root);
  const at = new Date().toISOString();
  for (const [slug, o] of Object.entries(outcomes)) all[slug] = { run, kind: o.kind, ...(o.with?.length ? { with: o.with } : {}), text: o.text, at };
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
};

// ---------------------------------------------------------------------------
// Heads - the tip each branch was last reviewed at and last ended green on,
// kept across runs in logs/heads.json by ticket id. A later run skips work a
// branch already passed when its tip still equals the record; a broken or
// missing record means no record, which runs the branch in full.
// ---------------------------------------------------------------------------

export type BranchHead = {
  branch: string;
  /** The tip after the last review pass that completed: everything up to here was reviewed. */
  reviewed?: string;
  /** The tip a pipeline ended green on, not held as unreviewed. */
  green?: string;
  /** The tip whose gates ended red: a branch reviewed at a tip that went red needs the implementer, not just a re-run of the gates. Dropped by the next review or green. */
  red?: string;
  /** The acceptance criterion the agents left undone at `green`: a later land-only run reads no agent, so without it the ticket would close. */
  unmet?: string;
  /** The gate results at `green`, for a ticket the kit holds after its gates: a land-only re-run runs none before it holds, and would report none. */
  gates?: Gate[];
  /** The `<changelog>` lines the agents gave by `green` (`changelog: true`): a later land-only run reads no agent, so without them the lines never reach a closing summary. */
  changelog?: string[];
  /** How many `<changelog>` tags by `green` were no changelog line and were left out, carried like `changelog`. */
  changelogDropped?: number;
  /** What a reviewer said no gate exercises, by `green` (its `<ungated>` line): a later land-only run reads no reviewer, so without it the "check by hand" note would not reach the closing summary. */
  ungated?: string;
  /** What a reviewer said of a gap in prose and filed nowhere, carried like `ungated`. */
  gap?: string;
  /** The commits a repair pass made on the branch, over every attempt: the landing leaves what only they changed out of the `Touches:` overrun. */
  repaired?: string[];
  /** run.json's startedAt of the run that wrote the record last. */
  run: string;
  at: string;
};

const headsFile = (root: string) => join(root, ".sandcastle/logs/heads.json");

export const readHeads = (root: string): Record<string, BranchHead> => {
  try {
    const all = JSON.parse(readFileSync(headsFile(root), "utf8"));
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
};

export const recordHead = (root: string, id: string, fields: { branch: string; reviewed?: string; green?: string; red?: string; unmet?: string; gates?: Gate[]; changelog?: string[]; changelogDropped?: number; ungated?: string; gap?: string; repaired?: string[] }, run: string): void => {
  const file = headsFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const all = readHeads(root);
  // A review reads the branch afresh: a red result recorded before it is no longer the branch's state.
  const kept = "reviewed" in fields && !("red" in fields) ? { ...all[id], red: undefined } : all[id];
  all[id] = { ...kept, ...fields, run, at: new Date().toISOString() };
  // Written whole and renamed into place, as the run record is: a half-written
  // file read as no record would quietly cost a later run its skip.
  writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
};

/** Drops a ticket's record, so the next run implements it afresh; true when there was one. */
export const forgetHead = (root: string, id: string): boolean => {
  const all = readHeads(root);
  if (!(id in all)) return false;
  delete all[id];
  const file = headsFile(root);
  writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
  return true;
};

/** True when everything on `branch` since `from` is merge commits or already on `base`; throws when `from` is not in the branch's history. */
const onlyMergesSince = (root: string, base: string, branch: string, from: string): boolean => {
  // A rewritten branch: the recorded commit is no longer in its history.
  sh("git", ["merge-base", "--is-ancestor", from, branch], root);
  // Merge commits and what base already holds are not new work; anything else is.
  return Number(sh("git", ["rev-list", "--count", "--no-merges", `${from}..${branch}`, `^${base}`], root)) === 0;
};

/**
 * The recorded green head when branch agent/issue-<id> sits on it, or past it by merge commits
 * only (the kit's base merge, or a conflict resolution a hold left on the branch), and has work
 * not on base; otherwise undefined. Undefined means "run it in full": a missing or doubtful
 * record never skips work, and a branch with a commit of its own since green is new work.
 */
export const landOnlyHead = (root: string, base: string, id: string): string | undefined => {
  const branch = `agent/issue-${id}`;
  const record = readHeads(root)[id];
  if (!record?.green || record.branch !== branch) return undefined;
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
    if (sh("git", ["rev-parse", branch], root) !== record.green && !onlyMergesSince(root, base, branch, record.green)) return undefined;
    // Everything already on base: a reopened ticket, which runs as today.
    return Number(sh("git", ["rev-list", "--count", `${base}..${branch}`], root)) > 0 ? record.green : undefined;
  } catch {
    return undefined; // no such branch, not an ancestor, or git failed
  }
};

/**
 * The recorded reviewed head of a branch that never recorded a green one (stopped while its
 * gates ran, say) when it sits on it, or past it by merge commits only, and has work not on base;
 * otherwise undefined. A branch whose gates went red since its review (`red`) is never one: that
 * branch needs the implementer, not another gate run. Like `landOnlyHead`, a missing or doubtful
 * record means "run it in full".
 */
export const reviewedOnlyHead = (root: string, base: string, id: string): string | undefined => {
  const branch = `agent/issue-${id}`;
  const record = readHeads(root)[id];
  if (!record?.reviewed || record.red || record.branch !== branch) return undefined;
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
    if (sh("git", ["rev-parse", branch], root) !== record.reviewed && !onlyMergesSince(root, base, branch, record.reviewed)) return undefined;
    return Number(sh("git", ["rev-list", "--count", `${base}..${branch}`], root)) > 0 ? record.reviewed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The recorded reviewed head when everything on branch agent/issue-<id> since it is merge
 * commits (the kit's base merge, conflict resolution inside it) or already on base; otherwise undefined.
 * Undefined means "review in full": a missing or doubtful record never narrows a review.
 */
export const narrowReviewBase = (root: string, base: string, id: string): string | undefined => {
  const branch = `agent/issue-${id}`;
  const record = readHeads(root)[id];
  if (!record?.reviewed || record.branch !== branch) return undefined;
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
    return onlyMergesSince(root, base, branch, record.reviewed) ? record.reviewed : undefined;
  } catch {
    return undefined; // no such branch, not an ancestor, or git failed
  }
};

// ---------------------------------------------------------------------------
// Tokens. Each agent iteration reports what its process spent (agents.ts
// reads Claude's from the stream's closing line; Codex reports its own), and
// a pass is the sum of its iterations.
// ---------------------------------------------------------------------------

export type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number };
export const NO_TOKENS: Tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
});

export const runTokens = (result: unknown): Tokens | undefined => {
  const iterations = (result as { iterations?: { usage?: IterationUsage }[] } | undefined)?.iterations;
  const usages = (Array.isArray(iterations) ? iterations : []).map((i) => i.usage).filter((u): u is IterationUsage => !!u);
  if (!usages.length) return undefined;
  return usages
    .map((u) => ({ input: u.inputTokens, cacheWrite: u.cacheCreationInputTokens, cacheRead: u.cacheReadInputTokens, output: u.outputTokens }))
    .reduce(addTokens, NO_TOKENS);
};

export const tokenLine = (t: Tokens) => `${k(t.input + t.cacheWrite + t.cacheRead)} in (${k(t.cacheRead)} cached) / ${k(t.output)} out`;
/** The status view's run line has no room for the cached share. */
export const tokenBrief = (t: Tokens) => `${k(t.input + t.cacheWrite + t.cacheRead)} in / ${k(t.output)} out`;

/**
 * What the usage watch calls with a ticket's running pass's tokens so far: the ticket's `tokens` in the run record
 * becomes what its finished passes spent (`spent`, the run's own count of the results' figures) plus that live figure.
 * A pass that has ended is in `spent` and no longer live (`UsageWatch.settle`), so it is never in both.
 */
export const liveTokenWriter = (run: { finished: boolean; ticket(id: string, fields: { tokens: string }): void }, spent: Map<string, Tokens>) =>
  (issue: string, live: Tokens) => {
    if (!run.finished) run.ticket(issue, { tokens: tokenBrief(addTokens(spent.get(issue) ?? NO_TOKENS, live)) });
  };

// ---------------------------------------------------------------------------
// Log archive. A log whose branch is gone, merged, or shipped by an equivalent
// patch is history, and moving it out keeps the status view down to live
// work. Sandcastle appends each run to the same file name, so the archive
// appends too rather than overwriting an earlier run's log. The archive is
// pruned by age each time, since nothing else ever deletes from it.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** Archived files older than this are deleted. */
export const ARCHIVE_KEEP_DAYS = 14;
/** The raw `.jsonl` streams are the bulk of the archive, so they go sooner; the readable `.log` stays. */
export const ARCHIVE_KEEP_RAW_DAYS = 2;

/** The cleanup's one line; both limits carry their unit, so the raw streams' "2" is read as days. */
export const prunedLine = (pruned: number): string =>
  `Deleted ${pruned} archived log(s) past their age limit (${ARCHIVE_KEEP_DAYS} days; raw .jsonl streams ${ARCHIVE_KEEP_RAW_DAYS} days).`;

/** Delete archived files past their age limit, by mtime (an append refreshes it). Returns how many went. */
export const pruneArchive = (project: Project, now = Date.now()): number => {
  const archive = join(project.root, ".sandcastle/logs/archive");
  if (!existsSync(archive)) return 0;
  let pruned = 0;
  for (const name of readdirSync(archive)) {
    const limit = name.endsWith(".jsonl") ? ARCHIVE_KEEP_RAW_DAYS : ARCHIVE_KEEP_DAYS;
    try {
      const stat = statSync(join(archive, name));
      if (!stat.isFile() || now - stat.mtimeMs <= limit * DAY_MS) continue;
      unlinkSync(join(archive, name));
      pruned++;
    } catch {
      // Gone already (another run pruning at the same moment): nothing to do.
    }
  }
  return pruned;
};

export const archiveFinishedLogs = (project: Project) => {
  const logs = join(project.root, ".sandcastle/logs");
  if (!existsSync(logs)) return;
  mkdirSync(join(logs, "archive"), { recursive: true });
  const finished = new Map<string, boolean>();
  const isFinished = (branch: string) => {
    try {
      sh("git", ["show-ref", "-q", "--verify", `refs/heads/${branch}`], project.root);
    } catch {
      return true; // branch deleted
    }
    return !sh("git", ["cherry", project.baseBranch, branch], project.root)
      .split("\n")
      .some((line) => line.startsWith("+"));
  };
  let moved = 0;
  for (const name of readdirSync(logs)) {
    const slug = logOwner(name);
    if (!slug) continue;
    // A live sandbox is still appending to its log, whatever its branch says.
    if (existsSync(join(project.root, `.sandcastle/worktrees/agent-issue-${slug}`))) continue;
    const branch = `agent/issue-${slug}`;
    if (!finished.has(branch)) finished.set(branch, isFinished(branch));
    if (!finished.get(branch)) continue;
    appendFileSync(join(logs, "archive", name), readFileSync(join(logs, name)));
    unlinkSync(join(logs, name));
    moved++;
  }
  if (moved) console.log(`Archived ${moved} log(s) of finished branches to .sandcastle/logs/archive/.`);
  const pruned = pruneArchive(project);
  if (pruned) console.log(prunedLine(pruned));
};

// ---------------------------------------------------------------------------
// Status pane. Inside Herdr, a run opens `sandcastle status` in a sibling
// pane, or reuses the one an earlier run opened. The pane id is kept in
// .sandcastle/logs/status-pane; a closed pane is simply replaced.
// ---------------------------------------------------------------------------

// The pane splits beside the calling pane, so that pane's width picks the
// direction. stdout is no guide: piped (`sandcastle run | tee run.log`), it has
// no columns at all and every pane split down.
const callerWidth = (): number | undefined => {
  const id = process.env.HERDR_PANE_ID;
  if (!id) return undefined;
  try {
    const panes = herdrJson(["pane", "layout", "--pane", id]).result.layout.panes as { pane_id: string; rect: { width: number } }[];
    return panes.find((p) => p.pane_id === id)?.rect.width;
  } catch {
    return undefined;
  }
};

export const openStatusPane = (project: Project): string | undefined => {
  if (!IN_HERDR) {
    console.log("Not inside Herdr - watch the run with `sandcastle status` in another terminal.");
    return undefined;
  }
  const record = statusPaneRecord(project);
  const previous = existsSync(record) ? readFileSync(record, "utf8").trim() : "";
  if (previous) {
    try {
      // Open but idle (the view was stopped with Ctrl-C): restart it there.
      if (!runsStatus(previous)) herdr(["pane", "run", previous, STATUS_COMMAND]);
      return previous;
    } catch (error) {
      // Replace only a pane that is really gone. After a transient herdr
      // error the pane may be alive: opening another would show two views.
      if (!/pane_not_found/.test(String((error as { stderr?: string }).stderr ?? ""))) return previous;
      unlinkSync(record);
    }
  }
  try {
    const wide = (callerWidth() ?? process.stdout.columns ?? 0) >= 160;
    const pane = herdrJson([
      "pane", "split", "--current", "--direction", wide ? "right" : "down",
      "--cwd", project.root, "--no-focus",
    ]).result.pane.pane_id as string;
    herdr(["pane", "rename", pane, `sandcastle ${project.name}`]);
    herdr(["pane", "run", pane, STATUS_COMMAND]);
    writeFileSync(record, pane + "\n");
    return pane;
  } catch (error) {
    console.log(`Could not open the status pane (${String(error).slice(0, 160)}).`);
    return undefined;
  }
};
