// Everything around a run that is not the pipeline itself: preconditions,
// preflight, prompts, the run record, the log archive and the status pane.

import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IterationUsage, LoggingOption } from "@ai-hero/sandcastle";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, REVIEW_MODEL } from "./agents.ts";
import type { Project } from "./config.ts";
import type { Tracker } from "./tracker.ts";
import { herdr, herdrJson, IN_HERDR, runsStatus, STATUS_COMMAND, statusPaneRecord } from "./herdr.ts";
import { credentials, credentialSource, KIT, machineSettings, sh } from "./sandbox.ts";
import { OperatorError } from "./errors.ts";

// Node's default action on SIGHUP, SIGINT and SIGTERM ends the process without
// running exit handlers, so a closed pane or a Ctrl-C lost the end line, run.json's
// finishedAt and the lock releases. The library handles only SIGINT and SIGTERM, and
// only while a sandbox is live: while it listens, leave the teardown to it (a SIGHUP
// is handed over as a SIGTERM); otherwise exit, so the exit handlers fire.
export const exitOnSignal = () => {
  const mapped = { SIGHUP: "SIGTERM", SIGINT: "SIGINT", SIGTERM: "SIGTERM" } as const;
  for (const sig of Object.keys(mapped) as (keyof typeof mapped)[]) {
    process.on(sig, () => {
      if (process.listenerCount(mapped[sig]) > 1) {
        if (sig === "SIGHUP") process.emit("SIGTERM", "SIGTERM");
        return;
      }
      process.exit(128 + osConstants.signals[sig]);
    });
  }
};

// ---------------------------------------------------------------------------
// `sandcastle run` arguments - aliases for the ISSUES, DRY_RUN and CONCURRENCY
// variables, which stay the one mechanism. Anything else is refused: a
// silently ignored `run 12 14` burned down the whole queue.
// ---------------------------------------------------------------------------

const RUN_USAGE = "Usage: sandcastle run [TICKET ...] [--dry] [--concurrency N]";

export const parseRunArgs = (args: string[]): { issues?: string[]; dry: boolean; concurrency?: number } => {
  const out: { issues?: string[]; dry: boolean; concurrency?: number } = { dry: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry") out.dry = true;
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

export const keepAwake = (): string => {
  if ((process.env.KEEP_AWAKE ?? (machineSettings().keepAwake === false ? "0" : "1")) === "0") {
    return "off - the machine's energy settings apply";
  }
  const pid = String(process.pid);
  const [cmd, args] =
    process.platform === "darwin"
      ? ["caffeinate", ["-i", "-w", pid]]
      : ["systemd-inhibit", ["--what=idle:sleep", "--who=sandcastle", "--why=sandcastle run", "tail", `--pid=${pid}`, "-f", "/dev/null"]];
  if (spawnSync(cmd, ["-h"], { stdio: "ignore" }).error) return `off - ${cmd} not found`;
  spawn(cmd, args, { stdio: "ignore" }).on("error", () => {}).unref();
  return `on (${cmd})`;
};

// Porcelain lines (`XY path`) of everything staged, unstaged or untracked. Not sh(): its trim
// would eat the first line's leading status column.
export const dirtyFiles = (root: string): string[] =>
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
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
  new Promise<{ ok: boolean; out: string }>((resolve) => {
    const child = execFile(
      cmd, args, { ...opts, encoding: "utf8", timeout: 180_000 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, out: stdout });
        resolve({ ok: false, out: `${stdout ?? ""}${stderr ?? ""}`.trim() || error.message });
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

export const preflight = async (project: Project, image: string) => {
  if (process.env.SKIP_PREFLIGHT === "1") return;
  const env = credentials(project);
  type Failure = { model: string; reply: string } | undefined;
  // Every model is asked at once; failures are read back in this array's order, not completion order,
  // so the message is the same on every run.
  const probes: Promise<Failure>[] = [...new Set([IMPL_MODEL, REVIEW_MODEL])].map(async (model): Promise<Failure> => {
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
      reply = JSON.parse(r.out);
    } catch {
      /* not JSON - the raw output is the reason */
    }
    return !r.ok || reply.is_error !== false ? { model, reply: (reply.result ?? r.out).slice(0, 300) } : undefined;
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
  name.match(/^agent-issue-(.+)-(?:impl|review-codex|review|repair|gates)-\1\.(?:log|jsonl)$/)?.[1] ??
  name.match(/^agent-issue-([a-z0-9][a-z0-9-]*?)-(?:impl|review|repair|gates)-/)?.[1];

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
      } catch {
        // A full disk must not fail an agent pass; the library swallows a throwing callback too.
      }
    },
  };
};

// Local time with its offset, built by hand: toLocaleString varies by locale,
// and git and the terminal show local time where the gate headers show UTC.
export const localStamp = (d = new Date()) => {
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${offset < 0 ? "-" : "+"}${p(Math.trunc(offset / 60))}:${p(offset % 60)}`;
};

/** Separates one run's output from the last in a log that accumulates across attempts and runs. */
export const markLog = (file: string, runId: string) => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `\n# run ${runId}, ${localStamp()}\n`);
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
      .replaceAll(/\{\{KIT_(LOST|TICKET_VIEW|COMMENTS_VIEW|NEW_TICKET_REVIEW|NEW_TICKET|RECORD|NOCHANGE|BLOCKED|SAY)\}\}/g, (_, k: keyof Tracker["words"]) => tracker.words[k])
      .replaceAll("{{KIT_GATES}}", () => project.gates.map((g) => g.command).join("\n"))
      .replaceAll("{{KIT_LABEL}}", () => project.label)
      .replaceAll("{{KIT_PROJECT_RULES}}", () => rules)
      .replaceAll("{{KIT_DRY_RUN}}", () => (dryRun ? tracker.dryRunNote : ""));
    // Sandcastle refuses a prompt with any other {{NAME}} - but only inside
    // the sandbox, after the install. Refuse it here instead. (A literal
    // {{...}} in rules.md, e.g. a template variable, has to be reworded.)
    const allowed = new Set(["ISSUE_NUMBER", "TICKET", "TICKET_BODY", "SOURCE_BRANCH", "TARGET_BRANCH"]);
    // The orchestrator fills these for a repair pass. Sandcastle substitutes
    // in one pass, so gate output holding `{{...}}` or a shell block stays text.
    if (kind === "repair") for (const k of ["GATE_NAME", "GATE_COMMAND", "GATE_OUTPUT"]) allowed.add(k);
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
 * Where one ticket of the live run is. The status view shows the run's tickets
 * from this record, not from branches and logs: before it, a branch waiting to
 * land had no outcome, and the view's rules for old runs read it as queued.
 * `state` is one of: queued, blocked, setup, implement, review, cross-review,
 * gates, repair, ready, landing, merged, held, conflict, red, nochange,
 * crashed, not landed, withdrawn (closed or unqueued during the run), stopped (finished, but
 * the run stopped before landing), skipped.
 */
export type TicketRecord = {
  state?: string;
  since?: number;
  started?: number;
  order?: number;
  note?: string | null;
  title?: string;
  // For the closing summary (report.ts), set when the pipeline ends.
  commits?: number;
  tokens?: string;
  minutes?: number;
  /** Test ids a red gate named. */
  failing?: string[];
  /** Files a merge conflicted on, or protected paths a held branch changes. */
  files?: string[];
  /** Merged, but the tracker refused the close: the error, short. */
  closeFailed?: string;
};

export const recordRun = (project: Project, extra: Record<string, unknown> = {}) => {
  const file = join(project.root, ".sandcastle/logs/run.json");
  mkdirSync(join(project.root, ".sandcastle/logs"), { recursive: true });
  let run: Record<string, unknown> = { orchestrator: project.name, pid: process.pid, startedAt: new Date().toISOString(), models: MODELS_LINE, ...extra };
  // Written whole and renamed into place: the view reads it every few seconds,
  // and a half-written file read as no record at all, so every row fell back
  // to the guesswork the record is there to replace.
  const write = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  };
  write();
  process.on("exit", (code) => {
    run = { ...run, finishedAt: new Date().toISOString(), exitCode: code };
    write();
    // run.json is overwritten by the next run, so each finished run also leaves one
    // line here. A failed append must never change the process's exit.
    try {
      appendFileSync(join(project.root, ".sandcastle/logs/history.jsonl"), JSON.stringify(run) + "\n");
    } catch {
      /* history is a convenience; the run itself already ended */
    }
  });
  return {
    startedAt: run.startedAt as string,
    /** `stage` is what the status view's run line shows while the run is live. */
    update(fields: Record<string, unknown>) {
      run = { ...run, ...fields };
      write();
    },
    tickets: () => (run.tickets ?? {}) as Record<string, TicketRecord>,
    /** A new `state` also restarts its clock; a note alone does not. */
    ticket(id: string, fields: TicketRecord) {
      const tickets = (run.tickets ?? {}) as Record<string, TicketRecord>;
      const now = fields.state ? { since: Math.floor(Date.now() / 1000), note: null } : {};
      run = { ...run, tickets: { ...tickets, [id]: { ...tickets[id], ...now, ...fields } } };
      write();
    },
  };
};

// ---------------------------------------------------------------------------
// Typical times - how long each step of an issue usually takes in this
// project, from earlier runs' timings. The status view marks a step running
// at twice its usual time, and estimates when landing starts: a run that is
// busy but healthy and one that is stuck looked the same for an hour.
// ---------------------------------------------------------------------------

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);

/** Seconds per step, and `issue` for one whole issue; `extra` adds this run's finished issues (ms). */
export const typicalTimes = (project: Project, extra: number[] = []) => {
  let lines: { project?: string; run?: string; issue?: unknown; phase?: string; ms?: number }[] = [];
  try {
    lines = readFileSync(join(project.root, ".sandcastle/logs/timings.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    /* no runs yet */
  }
  // Steps before the agents are issue 0 (or "" in older lines).
  const steps = lines.filter((l) => l.project === project.name && l.issue && String(l.issue) !== "0" && typeof l.ms === "number");
  const byPhase = new Map<string, number[]>();
  const byIssue = new Map<string, number>();
  for (const l of steps) {
    byPhase.set(l.phase!, [...(byPhase.get(l.phase!) ?? []), l.ms!]);
    byIssue.set(`${l.run}|${l.issue}`, (byIssue.get(`${l.run}|${l.issue}`) ?? 0) + l.ms!);
  }
  const out: Record<string, number> = {};
  for (const [phase, ms] of byPhase) out[phase] = Math.round(median(ms)! / 1000);
  const issue = median([...byIssue.values(), ...extra]);
  if (issue !== undefined) out.issue = Math.round(issue / 1000);
  return out;
};

const k = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/**
 * A rough estimate for a run about to start: the median tokens and time of
 * this project's earlier tickets (from timings.jsonl) times `tickets`, with
 * the time divided across `slots`. Undefined until an earlier ticket has
 * recorded tokens, so a new project prints nothing rather than a guess. It
 * covers the tickets' own pipelines only - not the image check, preflight,
 * base gates, landing or verify. A line that does not parse is skipped.
 */
export const estimate = (project: Project, tickets: number, slots: number): string | undefined => {
  let text: string;
  try {
    text = readFileSync(join(project.root, ".sandcastle/logs/timings.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  type Line = { project?: string; run?: unknown; issue?: unknown; ms?: unknown; tokens?: { input?: number; cacheWrite?: number; cacheRead?: number; output?: number } };
  const groups = new Map<string, { ms: number; tokened: boolean; inTokens: number; out: number }>();
  for (const raw of text.split("\n").filter(Boolean)) {
    let l: Line;
    try {
      l = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!l || typeof l !== "object" || l.project !== project.name) continue;
    if (!l.issue || String(l.issue) === "0" || typeof l.ms !== "number") continue;
    const key = `${l.run}|${l.issue}`;
    const g = groups.get(key) ?? { ms: 0, tokened: false, inTokens: 0, out: 0 };
    g.ms += l.ms;
    if (l.tokens && typeof l.tokens === "object") {
      g.tokened = true;
      g.inTokens += (l.tokens.input ?? 0) + (l.tokens.cacheWrite ?? 0) + (l.tokens.cacheRead ?? 0);
      g.out += l.tokens.output ?? 0;
    }
    groups.set(key, g);
  }
  const counted = [...groups.values()].filter((g) => g.tokened);
  if (!counted.length) return undefined;
  const inAll = median(counted.map((g) => g.inTokens))! * tickets;
  const outAll = median(counted.map((g) => g.out))! * tickets;
  const m = Math.round((median(counted.map((g) => g.ms))! * Math.ceil(tickets / slots)) / 60_000);
  const time = m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return `Estimate (rough, from ${counted.length} earlier ticket(s) in this project): about ${k(inAll)} tokens in / ${k(outAll)} out and ${time} for ${tickets} ticket(s), ${slots} at a time.`;
};

// ---------------------------------------------------------------------------
// Outcomes - what each branch's last run decided, kept across runs in
// logs/outcomes.json by branch slug. The status view shows it on the row, so
// a finished branch reads "gate red" or "dry run: would merge" rather than
// its sandbox's last log line, and a branch from an earlier run is told apart
// from this run's.
// ---------------------------------------------------------------------------

export const recordOutcomes = (project: Project, run: string, outcomes: Record<string, string>) => {
  const file = join(project.root, ".sandcastle/logs/outcomes.json");
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* first run */
  }
  const at = new Date().toISOString();
  for (const [slug, outcome] of Object.entries(outcomes)) all[slug] = { run, outcome, at };
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

export const recordHead = (root: string, id: string, fields: { branch: string; reviewed?: string; green?: string }, run: string): void => {
  const file = headsFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const all = readHeads(root);
  all[id] = { ...all[id], ...fields, run, at: new Date().toISOString() };
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

/**
 * The recorded green head when branch agent/issue-<id> still sits on it and has
 * work not on base; otherwise undefined. Undefined means "run it in full": a
 * missing or doubtful record never skips work.
 */
export const landOnlyHead = (root: string, base: string, id: string): string | undefined => {
  const branch = `agent/issue-${id}`;
  const record = readHeads(root)[id];
  if (!record?.green || record.branch !== branch) return undefined;
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
    if (sh("git", ["rev-parse", branch], root) !== record.green) return undefined;
    // Everything already on base: a reopened ticket, which runs as today.
    return Number(sh("git", ["rev-list", "--count", `${base}..${branch}`], root)) > 0 ? record.green : undefined;
  } catch {
    return undefined; // no such branch, or git failed
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
    // A rewritten branch: the reviewed commit is no longer in its history.
    sh("git", ["merge-base", "--is-ancestor", record.reviewed, branch], root);
    // Merge commits and what base already holds are not new work; anything else is.
    const fresh = Number(sh("git", ["rev-list", "--count", "--no-merges", `${record.reviewed}..${branch}`, `^${base}`], root));
    return fresh > 0 ? undefined : record.reviewed;
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

// ---------------------------------------------------------------------------
// Log archive. A log whose branch is gone, merged, or shipped by an equivalent
// patch is history, and moving it out keeps the status view down to live
// work. Sandcastle appends each run to the same file name, so the archive
// appends too rather than overwriting an earlier run's log.
// ---------------------------------------------------------------------------

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
