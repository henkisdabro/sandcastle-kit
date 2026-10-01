// Everything around a run that is not the pipeline itself: preconditions,
// preflight, prompts, the run record, the log archive and the status pane.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IterationUsage } from "@ai-hero/sandcastle";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, REVIEW_MODEL } from "./agents.ts";
import type { Project } from "./config.ts";
import type { Tracker } from "./tracker.ts";
import { herdr, herdrJson, IN_HERDR, runsStatus, STATUS_COMMAND, statusPaneRecord } from "./herdr.ts";
import { credentials, KIT, machineSettings, sh } from "./sandbox.ts";
import { OperatorError } from "./errors.ts";

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

// Every merge lands in the primary checkout, so it has to be clean and on the base branch.
// An OperatorError, so the CLI prints a message: a stack trace read as a kit bug, and
// without the file list the operator had to run git status to find a stray lockfile.
export const assertCleanBase = (project: Project) => {
  // Not sh(): its trim would eat the first line's leading status column.
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: project.root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10).map((l) => `  ${l}`);
    if (dirty.length > 10) shown.push(`  ... and ${dirty.length - 10} more`);
    throw new OperatorError(
      `NOT STARTED: the working tree is dirty. The run merges into it - commit or stash first.\n${shown.join("\n")}`,
    );
  }
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], project.root);
  if (branch !== project.baseBranch) {
    throw new OperatorError(`NOT STARTED: expected to be on ${project.baseBranch}, found ${branch}.`);
  }
};

// ---------------------------------------------------------------------------
// Preflight - one short reply from every model, before any sandbox exists.
// A spent Max plan allowance, a model the image's Claude Code is too old for,
// or an expired token otherwise surfaces mid-run as a misleading error, after
// the implementation has already been paid for. SKIP_PREFLIGHT=1 skips it.
// ---------------------------------------------------------------------------

const ask = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { ...opts, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
  }
};

export const preflight = (project: Project, image: string) => {
  if (process.env.SKIP_PREFLIGHT === "1") return;
  const env = credentials(project);
  const failures: string[] = [];
  for (const model of new Set([IMPL_MODEL, REVIEW_MODEL])) {
    const r = ask(
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
    if (!r.ok || reply.is_error !== false) failures.push(`${model}: ${(reply.result ?? r.out).slice(0, 300)}`);
  }
  if (CROSS_REVIEW) {
    // On the HOST, not in the image: this also refreshes the host's ChatGPT
    // login, which every sandbox then copies (see sandboxConfig).
    const r = ask(
      "codex",
      ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-m", CROSS_REVIEW_MODEL, "Reply OK"],
      { cwd: tmpdir() },
    );
    if (!r.ok) failures.push(`${CROSS_REVIEW_MODEL}: ${r.out.split("\n").slice(-3).join(" ").slice(0, 300)}`);
  }
  if (failures.length) {
    throw new OperatorError(`Preflight failed - no sandbox started:\n  ${failures.join("\n  ")}`);
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
  name.match(/^agent-issue-(.+)-(?:impl|review-codex|review|repair|gates)-\1\.log$/)?.[1] ??
  name.match(/^agent-issue-([a-z0-9][a-z0-9-]*?)-(?:impl|review|repair|gates)-/)?.[1];

/** Where the orchestrator writes an issue's gate output as it runs; named like an agent log so it is archived with them. */
export const gatesLog = (project: Project, id: string) => join(project.root, `.sandcastle/logs/agent-issue-${id}-gates-${id}.log`);

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

export const renderPrompts = (project: Project, tracker: Tracker, dryRun = false) => {
  const rules = project.rules
    ? `# Project rules\n\n${readFileSync(join(project.root, project.rules), "utf8").trim()}\n`
    : "";
  const out = join(project.root, ".sandcastle/.run");
  mkdirSync(out, { recursive: true });
  const paths = { implement: "", review: "", repair: "", rereview: "" };
  // `rereview` is the review prompt again, for the review after a repair pass
  // committed: it names the unreviewed repair commits and what to look for in them.
  for (const kind of ["implement", "review", "repair", "rereview"] as const) {
    // Function replacements: a `$&` or `$'` in a rule or gate is text, not a
    // replacement pattern.
    const text = readFileSync(join(KIT, `prompts/${kind === "rereview" ? "review" : kind}.md`), "utf8")
      .replaceAll("{{KIT_AFTER_REPAIR}}", () => (kind === "rereview" ? AFTER_REPAIR : ""))
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

const k = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);
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
