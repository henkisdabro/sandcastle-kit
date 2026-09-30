// Everything around a run that is not the pipeline itself: preconditions,
// preflight, prompts, the run record, the log archive and the status pane.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, REVIEW_MODEL } from "./agents.ts";
import type { Project } from "./config.ts";
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
// placeholders ({{ISSUE_NUMBER}}, {{SOURCE_BRANCH}}, ...) are left for it.
// ---------------------------------------------------------------------------

export const renderPrompts = (project: Project) => {
  const rules = project.rules
    ? `# Project rules\n\n${readFileSync(join(project.root, project.rules), "utf8").trim()}\n`
    : "";
  const out = join(project.root, ".sandcastle/.run");
  mkdirSync(out, { recursive: true });
  const paths = { implement: "", review: "" };
  for (const kind of ["implement", "review"] as const) {
    // Function replacements: a `$&` or `$'` in a rule or gate is text, not a
    // replacement pattern.
    const text = readFileSync(join(KIT, `prompts/${kind}.md`), "utf8")
      .replaceAll("{{KIT_GATES}}", () => project.gates.map((g) => g.command).join("\n"))
      .replaceAll("{{KIT_LABEL}}", () => project.label)
      .replaceAll("{{KIT_PROJECT_RULES}}", () => rules);
    // Sandcastle refuses a prompt with any other {{NAME}} - but only inside
    // the sandbox, after the install. Refuse it here instead. (A literal
    // {{...}} in rules.md, e.g. a template variable, has to be reworded.)
    const allowed = new Set(["ISSUE_NUMBER", "SOURCE_BRANCH", "TARGET_BRANCH"]);
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
  const run = { orchestrator: project.name, pid: process.pid, startedAt: new Date().toISOString(), models: MODELS_LINE, ...extra };
  writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  process.on("exit", (code) => {
    writeFileSync(file, JSON.stringify({ ...run, finishedAt: new Date().toISOString(), exitCode: code }, null, 2) + "\n");
  });
};

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
    const slug = name.match(/^agent-issue-(\d+(?:-[a-z]+)*)-(?:impl|review)-/)?.[1];
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

// stderr is captured, not inherited: a closed pane makes herdr print
// `{"error":{"code":"pane_not_found",...}}` there, which leaked into the run's
// output although the catch below already handles it.
const herdr = (args: string[]) =>
  execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const herdrJson = (args: string[]) => JSON.parse(herdr(args));

export const openStatusPane = (project: Project) => {
  if (process.env.HERDR_ENV !== "1") {
    console.log("Not inside Herdr - watch the run with `sandcastle status` in another terminal.");
    return;
  }
  const record = join(project.root, ".sandcastle/logs/status-pane");
  const previous = existsSync(record) ? readFileSync(record, "utf8").trim() : "";
  if (previous) {
    try {
      const info = herdrJson(["pane", "process-info", "--pane", previous]).result.process_info;
      const running = (info.foreground_processes as { cmdline: string }[]).some((p) => p.cmdline.includes("status.sh"));
      // Open but idle (the view was stopped with Ctrl-C): restart it there.
      if (!running) herdr(["pane", "run", previous, "sandcastle status"]);
      return;
    } catch (error) {
      // Forget only a pane that is really gone; a transient herdr error must
      // not lose a live pane's id and open a second view next run.
      if (/pane_not_found/.test(String((error as { stderr?: string }).stderr ?? ""))) unlinkSync(record);
    }
  }
  try {
    const wide = (process.stdout.columns ?? 0) >= 160;
    const pane = herdrJson([
      "pane", "split", "--current", "--direction", wide ? "right" : "down",
      "--cwd", project.root, "--no-focus",
    ]).result.pane.pane_id as string;
    herdr(["pane", "rename", pane, `sandcastle ${project.name}`]);
    herdr(["pane", "run", pane, "sandcastle status"]);
    writeFileSync(record, pane + "\n");
  } catch (error) {
    // A status view is a convenience; it never stops a run.
    console.log(`Could not open the status pane (${String(error).slice(0, 160)}).`);
  }
};
