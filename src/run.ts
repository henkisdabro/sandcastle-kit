// Everything around a run that is not the pipeline itself: preconditions,
// preflight, prompts, the run record, the log archive and the status pane.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IterationUsage } from "@ai-hero/sandcastle";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, REVIEW_MODEL } from "./agents.ts";
import type { Project } from "./config.ts";
import type { Tracker } from "./tracker.ts";
import { herdr, herdrJson, IN_HERDR, runsStatus, STATUS_COMMAND, statusPaneRecord } from "./herdr.ts";
import { credentials, KIT, sh } from "./sandbox.ts";

// Every merge lands in the primary checkout, so it has to be clean and on the base branch.
export const assertCleanBase = (project: Project) => {
  if (sh("git", ["status", "--porcelain"], project.root) !== "") {
    throw new Error("Working tree is dirty. The run merges into it - commit or stash first.");
  }
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], project.root);
  if (branch !== project.baseBranch) {
    throw new Error(`Expected to be on ${project.baseBranch}, found ${branch}.`);
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
    throw new Error(`Preflight failed - no sandbox started:\n  ${failures.join("\n  ")}`);
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
// from hand-suffixed branches (agent-issue-1086-closeout-impl-...) fall back
// to the first phase word.
export const logOwner = (name: string) =>
  name.match(/^agent-issue-(.+)-(?:impl|review-codex|review|repair)-\1\.log$/)?.[1] ??
  name.match(/^agent-issue-([a-z0-9][a-z0-9-]*?)-(?:impl|review|repair)-/)?.[1];

// Sandcastle warns about an argument its prompt never mentions, so each run
// gets only the ones its rendered prompt uses.
export const usedArgs = (promptFile: string, args: Record<string, string>) => {
  const text = readFileSync(promptFile, "utf8");
  return Object.fromEntries(Object.entries(args).filter(([k]) => text.includes(`{{${k}}}`)));
};

export const renderPrompts = (project: Project, tracker: Tracker, dryRun = false) => {
  const rules = project.rules
    ? `# Project rules\n\n${readFileSync(join(project.root, project.rules), "utf8").trim()}\n`
    : "";
  const out = join(project.root, ".sandcastle/.run");
  mkdirSync(out, { recursive: true });
  const paths = { implement: "", review: "", repair: "" };
  for (const kind of ["implement", "review", "repair"] as const) {
    // Function replacements: a `$&` or `$'` in a rule or gate is text, not a
    // replacement pattern.
    const text = readFileSync(join(KIT, `prompts/${kind}.md`), "utf8")
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

export const recordRun = (project: Project, extra: Record<string, unknown> = {}) => {
  const file = join(project.root, ".sandcastle/logs/run.json");
  mkdirSync(join(project.root, ".sandcastle/logs"), { recursive: true });
  let run: Record<string, unknown> = { orchestrator: project.name, pid: process.pid, startedAt: new Date().toISOString(), models: MODELS_LINE, ...extra };
  const write = () => writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
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
  };
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
