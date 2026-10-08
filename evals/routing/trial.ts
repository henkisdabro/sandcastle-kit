// One trial: one task, one arm, one repetition, through the kit itself - implement, review, gates,
// repair, landing - in a throwaway repository that holds the task's base and nothing later.
//
// The repository is fetched from this checkout by the base's sha alone, so no later commit (the
// reference fix among them) is anywhere an agent can read. Tickets are files (`tracker: "files"`), so
// a run writes nothing to GitHub.

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { armEnv, dollars, type Arm, type Tokens } from "./arms.ts";
import { REPO, ticketFile, type Task } from "./tasks.ts";

export const WORK = process.env.EVAL_WORK ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "sandcastle-kit", "routing-eval");
const FEATURE = "work";
export const ticketId = (t: Task) => `${FEATURE}-${String(t.issue).padStart(2, "0")}`;

const IDENTITY = ["-c", "user.name=routing-eval", "-c", "user.email=routing-eval@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();

export const trialDir = (task: Task, arm: string, rep: number) => join(WORK, "trials", `${task.issue}-${arm.replace(/[^\w.-]+/g, "_")}-${rep}`);

/** A repository at the task's base as `main`, with only the base's history. */
export const checkoutBase = (task: Task, dir: string) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "fetch", "-q", REPO, task.base);
  git(dir, "reset", "-q", "--hard", "FETCH_HEAD");
};

const mergeSettings = (dir: string, extra: Record<string, unknown>) => {
  const path = join(dir, ".claude/settings.json");
  const now = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  const env = { ...((now.env as object) ?? {}), ...((extra.env as object) ?? {}) };
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...now, ...extra, ...(Object.keys(env).length ? { env } : {}) }, null, 2) + "\n");
};

/** The trial's repository, ready for `sandcastle run`: ticket file, files tracker, the arm's settings, one commit. */
export const prepare = (task: Task, arm: Arm, dir: string) => {
  checkoutBase(task, dir);
  const config = join(dir, ".sandcastle/config.ts");
  const text = readFileSync(config, "utf8");
  if (!/export default \{/.test(text)) throw new Error(`${config}: no "export default {" to add the tracker to`);
  writeFileSync(config, text.replace(/export default \{/, 'export default {\n  tracker: "files",'));
  const ticket = join(dir, ".scratch", FEATURE, "issues", `${String(task.issue).padStart(2, "0")}-ticket.md`);
  mkdirSync(join(ticket, ".."), { recursive: true });
  writeFileSync(ticket, ticketFile(task));
  if (arm.settings) mergeSettings(dir, arm.settings);
  git(dir, "add", "-A", "-f", ".sandcastle/config.ts", ".scratch", ...(arm.settings ? [".claude/settings.json"] : []));
  execFileSync("git", ["-C", dir, ...IDENTITY, "commit", "-q", "-m", `eval: ticket ${ticketId(task)} for arm ${arm.id}`]);
  return git(dir, "rev-parse", "HEAD");
};

// The kit reads these from the caller; a trial must not open Herdr panes, inherit a person's run
// settings, or be told it is inside another run.
const scrubbed = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !/^(HERDR_|TMUX|SANDCASTLE_|IMPL_|REVIEW_|CROSS_REVIEW|AUTONOMY_LEVEL|DRY_RUN|TICKETS|CONCURRENCY|USAGE_)/.test(k)));

/** Runs the kit on the prepared repository and resolves with its exit code; output goes to `<dir>.out`. */
export const runKit = (arm: Arm, dir: string, limitMinutes = 120) =>
  new Promise<number>((resolve) => {
    const out = openSync(`${dir}.out`, "w");
    const child = spawn(join(REPO, "bin/sandcastle"), ["run"], {
      cwd: dir,
      env: { ...scrubbed(process.env), ...armEnv(arm) },
      stdio: ["ignore", out, out],
    });
    const timer = setTimeout(() => child.kill("SIGINT"), limitMinutes * 60_000);
    const done = (code: number) => {
      clearTimeout(timer);
      closeSync(out);
      resolve(code);
    };
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });

type ModelUse = Tokens & { costUSD?: number; requests: number; over100k: number };
/** One phase of the ticket: every pass of it (a second repair appends to the first one's stream). */
export type Pass = { phase: string; passes: number; ms: number; ok: boolean; models: Record<string, ModelUse>; dollars: number; turns?: number; toolCalls: number; agentCalls: number };

// One agent pass's spend, from its stream: the closing `result` line's `modelUsage` (every model the
// process used, subagents and an advisor included), and each request's prompt size for Haiku's 100K
// card. Streamed requests repeat a message id per content block; each id counts once.
const passFromLog = (path: string): Omit<Pass, "phase" | "passes" | "ms" | "ok"> => {
  const models: Record<string, ModelUse> = {};
  const seen = new Set<string>();
  let turns: number | undefined;
  let toolCalls = 0;
  let agentCalls = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "assistant" && e.message?.usage && !seen.has(e.message.id)) {
      seen.add(e.message.id);
      const u = e.message.usage;
      const m = (models[e.message.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, over100k: 0 });
      m.requests++;
      if ((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) > 100_000) m.over100k++;
    }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type !== "tool_use") continue;
        toolCalls++;
        if (c.name === "Agent" || c.name === "Task") agentCalls++;
      }
    }
    // A repeated pass (a second repair) appends to the same stream, with a result line of its own.
    if (e.type === "result") {
      turns = (turns ?? 0) + (e.num_turns ?? 0);
      for (const [model, u] of Object.entries<any>(e.modelUsage ?? {})) {
        const m = (models[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, over100k: 0 });
        m.input += u.inputTokens ?? 0;
        m.output += u.outputTokens ?? 0;
        m.cacheRead += u.cacheReadInputTokens ?? 0;
        m.cacheWrite += u.cacheCreationInputTokens ?? 0;
        m.costUSD = (m.costUSD ?? 0) + (u.costUSD ?? 0);
      }
    }
  }
  const total = Object.entries(models).reduce((n, [model, m]) => n + (dollars(model, m, m.requests ? m.over100k / m.requests : 0) ?? m.costUSD ?? 0), 0);
  return { models, dollars: total, turns, toolCalls, agentCalls };
};

export type Collected = {
  exitCode: number;
  state?: string;
  minutes?: number;
  record: Record<string, unknown>;
  phases: Pass[];
  /** The implementer's last commit, or the start commit when it made none. */
  implTip: string;
  /** What the run left: the base branch when the ticket landed, else the branch tip. */
  finalTip?: string;
  landed: boolean;
  /** A trial whose agents reached the upstream tracker or repository could have read the fix. */
  contaminated: string[];
};

export const collect = (task: Task, dir: string, start: string, exitCode: number): Collected => {
  const id = ticketId(task);
  const logs = join(dir, ".sandcastle/logs");
  const record = existsSync(join(logs, "run.json")) ? JSON.parse(readFileSync(join(logs, "run.json"), "utf8")) : {};
  const ticket = record.tickets?.[id] ?? {};
  const timings = existsSync(join(logs, "timings.jsonl"))
    ? readFileSync(join(logs, "timings.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((t) => t.issue === id)
    : [];
  const streams = existsSync(logs) ? readdirSync(logs).filter((f) => f.startsWith(`agent-issue-${id}-`) && f.endsWith(".jsonl")) : [];
  // A stream is named after its agent run (`impl-<id>`, `review-codex-<id>`), as src/burndown.ts maps it to a phase.
  const phaseOf = (f: string) => {
    const name = f.slice(`agent-issue-${id}-`.length, -`-${id}.jsonl`.length);
    return name === "impl" ? "implement" : name === "review-codex" ? "cross-review" : name;
  };
  const phases = [...new Set(timings.map((t) => String(t.phase)))];
  const perPhase: Pass[] = phases.map((phase) => {
    const runs = timings.filter((t) => t.phase === phase);
    const stream = streams.find((f) => phaseOf(f) === phase);
    return {
      phase,
      passes: runs.length,
      ms: runs.reduce((n, t) => n + (t.ms ?? 0), 0),
      ok: runs.every((t) => t.ok),
      ...(stream ? passFromLog(join(logs, stream)) : { models: {}, dollars: 0, toolCalls: 0, agentCalls: 0 }),
    };
  });
  const landed = ticket.state === "merged";
  const branch = `refs/heads/agent/issue-${id}`;
  let finalTip: string | undefined = landed ? git(dir, "rev-parse", "main") : undefined;
  if (!finalTip) {
    try {
      finalTip = git(dir, "rev-parse", "--verify", "--quiet", branch);
    } catch {
      finalTip = undefined;
    }
  }
  // The implementer's last commit: the newest `git commit` line its stream printed, else (a quiet
  // commit prints none) the newest commit on the way to the tip made before the implement phase ended.
  const impl = streams.filter((f) => phaseOf(f) === "implement");
  const shas = impl.flatMap((f) => [...readFileSync(join(logs, f), "utf8").matchAll(/\[agent\/issue-[^\s\]]+ ([0-9a-f]{7,40})\]/g)].map((m) => m[1]));
  const implEnd = Date.parse(timings.filter((t) => t.phase === "implement").at(0)?.ts ?? "") / 1000;
  const before = finalTip && Number.isFinite(implEnd)
    ? git(dir, "log", "--no-merges", "--format=%H %ct", `${start}..${finalTip}`)
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" "))
        .filter(([, ct]) => Number(ct) <= implEnd)
        .map(([sha]) => sha)
    : [];
  const implTip = shas.length ? git(dir, "rev-parse", shas.at(-1)!) : (before[0] ?? start);
  const all = streams.map((f) => readFileSync(join(logs, f), "utf8")).join("\n");
  const contaminated = [...new Set([...all.matchAll(/gh (?:issue|pr|api)[^\n"]{0,80}|github\.com\/[\w.-]+\/sandcastle-kit[^\s"]{0,60}/g)].map((m) => m[0]))];
  return { exitCode, state: ticket.state, minutes: ticket.minutes, record: ticket, phases: perPhase, implTip, finalTip, landed, contaminated };
};
