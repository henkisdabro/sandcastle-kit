// The project's gates, run by the orchestrator in a sandbox - never
// self-reported by an agent - and the check that they are green on the base
// branch before any agent starts.
//
// A gate that is red on the base commit is red on every branch, whatever the
// agent writes: an image too old for a test, a hook lean.dropHooks removed
// that a test expects. A run on such a base spends allowance on every issue
// and merges nothing, and its repair passes cannot help. So a run first gates
// the base commit in the image, and stops if anything is red.

import { createHash } from "node:crypto";
import { createSandbox } from "@ai-hero/sandcastle";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HookTest, Project } from "./config.ts";
import type { Hook } from "./lean.ts";
import { recordPeak, samplePeak } from "./peaks.ts";
import { withSlot } from "./pool.ts";
import { sandboxConfig, sh } from "./sandbox.ts";
import { execGate, GATE_TIMEOUT_SECONDS, unlockWorktree } from "./worktree-lock.ts";
import { OperatorError } from "./errors.ts";

// `timedOut`: exit 124 from the gate's time bound, which reads as a bare exit code otherwise.
export type Gate = { name: string; pass: boolean; ms?: number; timedOut?: boolean };
type Failure = { name: string; command: string; exitCode: number; output: string };
// `waitMs`: how long the run waited for a machine-wide gates slot before its first gate started.
// `peakMib`: the sandbox's peak memory so far, read after the pass (src/peaks.ts); absent where the kernel gives none.
export type GateRun = { gates: Gate[]; failure?: Failure; failures: Failure[]; waitMs?: number; peakMib?: number };

// Start and end of a gate's output: the first compiler error is at the top,
// the test summary at the bottom, and a whole log would swamp the prompt.
export const clip = (text: string, head = 8_000, tail = 24_000) =>
  text.length <= head + tail
    ? text
    : `${text.slice(0, head)}\n[... ${text.length - head - tail} characters cut ...]\n${text.slice(-tail)}`;

/**
 * What a gate run tells its caller as it goes. A gate run takes minutes and
 * writes no agent log, so without this the status view could not tell one
 * waiting for a machine-wide slot from one halfway through its test suite.
 */
export type GateProgress = {
  /** No gates slot was free; the run waits for one. */
  wait?: () => void;
  /** Gate `index` (0-based) starts. */
  gate?: (index: number, name: string) => void;
  /** Each gate's output is appended here as it arrives. */
  log?: string;
};

// One decimal under 10 s: gates average a few seconds, and "green in 0s" says
// nothing. The cut-off at 9.95 s stops 9.96 s printing as "10.0s".
export const seconds = (ms: number) => (ms < 9_950 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

// In order. A branch stops at the first red gate - its repair pass is fed
// that one's output, and the rest would only cost time. `all` runs every
// gate, for a report that says which of them are red, not just the first.
export const runGates = (project: Project, sandbox: Parameters<typeof execGate>[0], label: string, all = false, progress: GateProgress = {}) => {
  const asked = Date.now();
  return withSlot("gates", label, async (): Promise<GateRun> => {
    const waitMs = Date.now() - asked;
    const gates: Gate[] = [];
    const failures: Failure[] = [];
    const log = progress.log;
    for (const [i, g] of project.gates.entries()) {
      progress.gate?.(i, g.name);
      if (log) appendFileSync(log, `\n$ ${g.command}   # gate ${i + 1}/${project.gates.length}: ${g.name}, ${new Date().toISOString()}\n`);
      const since = Date.now();
      const r = await execGate(sandbox, g.command, log ? { onLine: (line) => appendFileSync(log, line + "\n") } : undefined);
      const ms = Date.now() - since;
      const timedOut = r.exitCode === 124;
      const timeout = `timed out after ${GATE_TIMEOUT_SECONDS / 60} min`;
      if (log) appendFileSync(log, `# ${g.name} ${r.exitCode === 0 ? "green" : timedOut ? `RED (${timeout})` : `RED (exit ${r.exitCode})`} in ${seconds(ms)}\n`);
      gates.push({ name: g.name, pass: r.exitCode === 0, ms, ...(timedOut ? { timedOut } : {}) });
      if (r.exitCode === 0) continue;
      const output = clip([...(timedOut ? [`The gate ${timeout} and was stopped; its output so far:`] : []), r.stdout, r.stderr].filter(Boolean).join("\n").trim());
      failures.push({ name: g.name, command: g.command, exitCode: r.exitCode, output });
      // A timed-out gate may still be running in this container (or Docker
      // may not be answering): a later gate would run beside it, or wait out
      // its own timeout too.
      if (!all || r.exitCode === 124) break;
    }
    const peakMib = await samplePeak(sandbox);
    return { gates, failure: failures[0], failures, waitMs, ...(peakMib !== undefined ? { peakMib } : {}) };
  }, progress.wait);
};

// ---------------------------------------------------------------------------
// Hook tests. A guard that never ran and a guard that allowed everything look
// the same in an agent's log, and a hook whose module is missing exits 1,
// which Claude Code treats as a non-blocking error: the guard fails open.
// So each configured test hands the kept PreToolUse hooks a made-up tool call
// on stdin, exactly as Claude Code would, after setup has installed what they
// import. Blocking is exit 2 or a JSON deny; the call itself never happens.
// ---------------------------------------------------------------------------

type Exec = { exec(cmd: string, options?: { stdin?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> };
export type HookTestResult = { name: string; pass: boolean; detail: string };

// Claude Code's matcher: empty or `*` takes every tool, anything else is a
// regex over the whole tool name (`Write|Edit`).
const matches = (matcher: string, tool: string) => {
  if (matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher === tool;
  }
};

const blocked = (r: { exitCode: number; stdout: string }) => {
  if (r.exitCode === 2) return true;
  try {
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
    return out?.hookSpecificOutput?.permissionDecision === "deny" || out?.decision === "block" || out?.decision === "deny";
  } catch {
    return false;
  }
};

export const runHookTests = async (tests: HookTest[], hooks: Hook[], sandbox: Exec): Promise<HookTestResult[]> => {
  if (!tests.length) return [];
  const cwd = (await sandbox.exec("pwd")).stdout.trim();
  const results: HookTestResult[] = [];
  for (const t of tests) {
    const guards = hooks.filter((h) => h.event === "PreToolUse" && matches(h.matcher, t.tool));
    if (!guards.length) {
      results.push({ name: t.name, pass: false, detail: `no kept PreToolUse hook matches ${t.tool}` });
      continue;
    }
    const stdin = JSON.stringify({
      session_id: "sandcastle-hook-test", transcript_path: "", cwd, permission_mode: "bypassPermissions",
      hook_event_name: "PreToolUse", tool_name: t.tool, tool_input: t.input,
    });
    const blockers: string[] = [];
    const errors: string[] = [];
    for (const h of guards) {
      const cmd = `CLAUDE_PROJECT_DIR='${cwd}' timeout 60 sh -c '${h.command.replace(/'/g, "'\\''")}'`;
      const r = await sandbox.exec(cmd, { stdin });
      if (blocked(r)) blockers.push(h.command);
      else if (r.exitCode !== 0) errors.push(`${h.command.slice(0, 60)} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 200)}`);
    }
    // An allow that got through because a guard crashed is not an allow: the
    // guard is dead (it fails open) and errors on every tool call of every agent.
    const pass = t.expect === "block" ? blockers.length > 0 : blockers.length === 0 && errors.length === 0;
    const detail = pass
      ? t.expect === "block" ? `blocked by ${blockers[0].slice(0, 70)}` : `allowed by all ${guards.length} matching hook(s)`
      : t.expect === "block"
        ? `none of ${guards.length} matching hook(s) blocked it${errors.length ? ` - errors (a guard that errors fails open): ${errors.join("; ")}` : ""}`
        : blockers.length
          ? `blocked by ${blockers.map((b) => b.slice(0, 70)).join(", ")}`
          : `a matching hook errored (a guard that errors fails open): ${errors.join("; ")}`;
    results.push({ name: t.name, pass, detail });
  }
  return results;
};

// ---------------------------------------------------------------------------
// Git hook probe. A repo's commit hooks run on every agent commit in the
// sandbox, and a hook that needs a tool the image lacks refuses all of them
// after the whole implementation has been paid for. So the base check runs the
// hooks the way a commit would, without committing: `git hook run` resolves
// core.hooksPath and .git/hooks itself, the index is clean so the hook sees an
// empty change, and nothing in the repo is written (the message file is a temp
// file). A hook that is absent or not executable counts as none, as for git.
// POSIX sh only: it runs in the image and, in the test, on the host.
// ---------------------------------------------------------------------------

export const GIT_HOOK_PROBE = String.raw`
v=$(git --version 2>/dev/null)
set -- $(printf '%s\n' "$v" | sed -n 's/^git version \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')
if [ -n "$1" ] && { [ "$1" -lt 2 ] || { [ "$1" -eq 2 ] && [ "$2" -lt 36 ]; }; }; then
  echo "@@unsupported $v"
  exit 0
fi
msg=$(mktemp) || exit 0
trap 'rm -f "$msg"' EXIT
echo "chore: sandcastle git hook probe" > "$msg"
for name in pre-commit commit-msg; do
  file=$(git rev-parse --git-path "hooks/$name")
  if [ ! -x "$file" ]; then
    echo "@@hook $name none"
    continue
  fi
  if [ "$name" = commit-msg ]; then
    out=$(git hook run --ignore-missing "$name" -- "$msg" 2>&1)
  else
    out=$(git hook run --ignore-missing "$name" 2>&1)
  fi
  if [ $? -eq 0 ]; then
    echo "@@hook $name pass"
  else
    echo "@@hook $name fail"
    printf '%s\n' "$out"
    exit 0
  fi
done
exit 0
`;

export type GitHooks = {
  hooks: { name: string; status: "pass" | "none" | "fail" }[];
  /** The refused hook's output, when one was. */
  failure?: { name: string; output: string };
  /** Why the hooks were not checked: the image's git has no `git hook run`, or the probe could not run. */
  unchecked?: string;
};

export const parseGitHookProbe = (stdout: string): GitHooks => {
  const lines = stdout.split("\n");
  const unsupported = lines.find((l) => l.startsWith("@@unsupported "));
  if (unsupported) return { hooks: [], unchecked: `git ${unsupported.slice("@@unsupported git version ".length).trim()} in the image has no \`git hook run\`` };
  const hooks: GitHooks["hooks"] = [];
  let failure: GitHooks["failure"];
  for (const [i, line] of lines.entries()) {
    const m = /^@@hook (\S+) (pass|none|fail)$/.exec(line);
    if (!m) continue;
    const status = m[2] as "pass" | "none" | "fail";
    hooks.push({ name: m[1], status });
    if (status === "fail") failure = { name: m[1], output: lines.slice(i + 1).join("\n").trim() };
  }
  return { hooks, ...(failure ? { failure } : {}) };
};

export const runGitHookProbe = async (sandbox: Parameters<typeof execGate>[0]): Promise<GitHooks> => {
  const r = await execGate(sandbox, GIT_HOOK_PROBE);
  // A probe that could not run at all (the sandbox died) is not a refused hook.
  if (r.exitCode !== 0) return { hooks: [], unchecked: `the probe exited ${r.exitCode}` };
  return parseGitHookProbe(r.stdout);
};

export const gitHooksLine = (g: GitHooks) =>
  g.unchecked !== undefined ? `git hooks: not checked (${g.unchecked})` : `git hooks: ${g.hooks.map((h) => `${h.name}=${h.status}`).join(" ")}`;

// Every gate on the tip of the base branch, in a throwaway sandbox set up
// exactly as an agent's is (image, setup, lean plan). `hookTests` also runs
// the project's hook tests there, against the plan's kept hooks, and probes
// the repo's git commit hooks.
// `runId` is the run these gates belong to, which the sandbox's peak is filed under.
export const gateBase = (project: Project, image: string, planFile: string, label: string, hookTests = false, runId?: string) =>
  withSlot("sandboxes", `${project.name} ${label}`, async () => {
    const branch = `sandcastle/${label.replace(/\W+/g, "-")}-${Date.now()}`;
    const sandbox = await createSandbox({ branch, baseBranch: project.baseBranch, ...sandboxConfig(project, image, planFile) });
    try {
      const run = await runGates(project, sandbox, `${project.name} ${label}`, true);
      const hooks = (JSON.parse(readFileSync(planFile, "utf8")) as { hooks: Hook[] }).hooks;
      return {
        ...run,
        hookTests: hookTests ? await runHookTests(project.hookTests, hooks, sandbox) : [],
        gitHooks: hookTests ? await runGitHookProbe(sandbox) : undefined,
      };
    } finally {
      unlockWorktree(sandbox.worktreePath);
      await recordPeak(sandbox, project.root, runId);
      await sandbox.close();
      try {
        sh("git", ["branch", "-D", branch]);
      } catch {
        /* never created */
      }
    }
  });

export const gateLine = (gates: Gate[]) => gates.map((g) => `${g.name}=${g.pass ? "pass" : g.timedOut ? "TIMEOUT" : "FAIL"}`).join(" ");

// One line per gate result with the command that ran, in full: a gate that
// reached the network went green unnoticed because only its name and verdict
// were printed. runGates stops early, so `results` is a prefix of `configured`
// and the command is found by position.
export const gateResultLines = (configured: { name: string; command: string }[], results: Gate[]): string[] =>
  results.map((g, i) => `  ${g.pass ? "pass" : g.timedOut ? "TIMEOUT" : "FAIL"}  ${g.name}  $ ${configured[i]?.command ?? ""}`);

// Where gate time goes, per gate. A slow gate runs on every branch, its
// repair passes and the base check, so it is the first place to look when
// sandboxes take long - and the one test runner is usually most of it.
export const gateMs = (result: unknown): Record<string, number> | undefined => {
  const gates = (result as { gates?: Gate[] } | undefined)?.gates;
  const timed = (Array.isArray(gates) ? gates : []).filter((g) => typeof g.ms === "number");
  return timed.length ? Object.fromEntries(timed.map((g) => [g.name, g.ms!])) : undefined;
};
// The failing tests a red gate names, for the closing summary: pytest's
// "FAILED path::test", vitest's and jest's "FAIL path", node:test's TAP
// "not ok N - name" and spec "✖ name (1.2ms)", Go's "--- FAIL: TestName" and
// cargo's "test path::name ... FAILED". Three branches red on the same test
// once read as three separate mysteries; named, they group. Matched line by
// line so a bare "FAIL" line (Go prints one) cannot borrow the next line's word.
// ESLint ends a red lint gate with "✖ N problems (...)": not a test, and two
// lint-red branches would otherwise read as one failing test.
const FAILING_TEST_LINE = [
  /^(?:FAILED|ERROR)\s+(\S+)/,
  /^\s*FAIL\s+(\S+)/,
  /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/,
  /^\s*✖ (?!failing tests:|\d+ problems? \()(.+?)(?: \([\d.]+m?s\))?$/,
  /^\s*--- FAIL: (\S+)/,
  /^test (\S+) \.\.\. FAILED$/,
];
export const failingTests = (output: string) =>
  [
    ...new Set(
      output
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .flatMap((line) => FAILING_TEST_LINE.map((re) => re.exec(line)?.[1]).filter((id): id is string => id !== undefined)),
    ),
  ].slice(0, 5);

// The red gates of a result, or undefined for a step that is not a gate run.
// A timings line once said `ok: true` for a red gate run, because `ok` meant
// only that the step did not throw; anything reading it for pass/fail was wrong.
export const gateRed = (result: unknown): string[] | undefined => {
  const gates = (result as { gates?: Gate[] } | undefined)?.gates;
  return Array.isArray(gates) ? gates.filter((g) => !g.pass).map((g) => g.name) : undefined;
};

/**
 * The `ms` and `waitMs` of a step's timings line, given its elapsed time. A gate run's slot wait is
 * `waitMs`, not part of `ms`: a ticket that queued behind others for a slot once recorded the queue
 * as gate time, which `typicalTimes`, the status view's "twice the usual" age and the estimate read.
 */
export const stepTimes = (elapsed: number, result: unknown): { ms: number; waitMs?: number } => {
  const w = (result as { waitMs?: unknown } | undefined)?.waitMs;
  const waitMs = typeof w === "number" && w > 0 ? Math.min(Math.round(w), elapsed) : 0;
  return { ms: elapsed - waitMs, ...(waitMs ? { waitMs } : {}) };
};
const gateTimeLine =(gates: Gate[]) =>
  [...gates].filter((g) => g.ms !== undefined).sort((a, b) => b.ms! - a.ms!).map((g) => `${g.name} ${seconds(g.ms!)}`).join(", ");

// A green result holds for as long as nothing it depended on changes: the
// base commit, the image, and the config that shapes a sandbox.
const baseKey = (project: Project, image: string, planFile: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        sh("git", ["rev-parse", project.baseBranch]),
        image,
        project.gates,
        project.setup,
        project.mounts,
        project.hookTests,
        readFileSync(planFile, "utf8"),
      ]),
    )
    .digest("hex");

const baseRecord = (root: string) => join(root, ".sandcastle/.run/base-gates.json");

// Whether the base was green at exactly this key. An unreadable record is a miss.
export const baseCacheHit = (root: string, key: string) => {
  try {
    return JSON.parse(readFileSync(baseRecord(root), "utf8")).key === key;
  } catch {
    return false;
  }
};

// A green result is recorded; a red one removes the record. A gate that
// depends on the clock or the network can go red at the same key `sandcastle
// gates` was green at, and a record left behind would have the next run skip
// the check and fan agents out on a base known to be red.
export const noteBaseResult = (root: string, key: string, green: boolean) => {
  const file = baseRecord(root);
  if (!green) return rmSync(file, { force: true });
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  writeFileSync(file, JSON.stringify({ key, at: new Date().toISOString() }) + "\n");
};

/** Red on the base before any agent ran. Carries each gate's verdict so the run record, and the closing summary, can name the red ones. */
export class BaseRedError extends OperatorError {
  constructor(message: string, readonly baseGates: { gate: string; ok: boolean }[]) {
    super(message);
  }
}

/**
 * Writes each red gate's full output to `log` (base gates, and the gates on the merged base at the
 * end of a run), or removes it when every gate passed: a log left by an earlier red run would read
 * as this run's result. Returns whether it wrote one.
 */
/** Where a red verify (the gates on the merged base at the end of a run) leaves its output. */
export const VERIFY_LOG = ".sandcastle/logs/verify-gates.log";

export const writeGateLog = (log: string, header: string, failures: GateRun["failures"], extra = ""): boolean => {
  if (!failures.length && !extra) {
    rmSync(log, { force: true });
    return false;
  }
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, `${header}\n\n` + failures.map((f) => `===== ${f.name}: ${f.command} (exit ${f.exitCode})\n${f.output}\n`).join("\n") + extra);
  return true;
};

/**
 * Gates the base branch and throws if any gate is red, with each red gate's
 * output in the log. `cached` skips the check when the same base, image and
 * config were green before.
 */
export const requireGreenBase = async (project: Project, image: string, planFile: string, cached = true, runId?: string) => {
  const log = join(project.root, ".sandcastle/logs/base-gates.log");
  const key = baseKey(project, image, planFile);
  const base = project.baseBranch;
  if (cached && baseCacheHit(project.root, key)) {
    console.log(`Gates on ${base}: green at this commit and image before - not re-run.`);
    return;
  }
  console.log(`Gates on ${base}: running every gate on the base commit in a sandbox, before any agent starts ...`);
  const run = await gateBase(project, image, planFile, "base-gates", true, runId);
  console.log(`Gates on ${base}: ${gateLine(run.gates)}`);
  for (const line of gateResultLines(project.gates, run.gates)) console.log(line);
  console.log(`  time per gate, slowest first: ${gateTimeLine(run.gates)}`);
  for (const t of run.hookTests) console.log(`  hook test ${t.pass ? "pass" : "FAIL"}  ${t.name} - ${t.detail}`);
  if (run.gitHooks) console.log(`  ${gitHooksLine(run.gitHooks)}`);
  const redHooks = run.hookTests.filter((t) => !t.pass);
  const gitHook = run.gitHooks?.failure;
  const green = !run.failures.length && !redHooks.length && !gitHook;
  noteBaseResult(project.root, key, green);
  const commit = sh("git", ["rev-parse", "--short", base]);
  writeGateLog(
    log,
    `# base gates on ${base} at ${commit}, ${new Date().toISOString()}: ${gateLine(run.gates)}` +
      (redHooks.length ? ` hook-tests=${redHooks.length}-FAIL` : "") +
      (gitHook ? ` git-hook=${gitHook.name}-FAIL` : ""),
    run.failures,
    redHooks.map((t) => `===== hook test ${t.name}\n${t.detail}\n`).join("\n") + (gitHook ? `===== git hook ${gitHook.name}\n${gitHook.output}\n` : ""),
  );
  // The sandbox's peak, for the run's "base gates" timings line, as a ticket's gate pass carries it.
  if (green) return run.peakMib !== undefined ? { peakMib: run.peakMib } : undefined;
  for (const f of run.failures) {
    console.log(`\n--- ${f.name} (exit ${f.exitCode}), last lines:\n${f.output.split("\n").slice(-15).join("\n")}`);
  }
  if (gitHook) {
    console.log(`\nGit hook ${gitHook.name} fails in the sandbox - every agent commit would be refused:\n${gitHook.output.split("\n").slice(-15).join("\n")}`);
    console.log("Add what it needs to the project's Dockerfile (README: Dockerfile), then `sandcastle gates` again.");
  }
  const red = [...run.failures.map((f) => f.name), ...redHooks.map((t) => `hook test "${t.name}"`), ...(gitHook ? [`git hook ${gitHook.name}`] : [])];
  throw new BaseRedError(
    `Red on ${base} before any agent ran: ${red.join(", ")}. Every branch would fail the same way, ` +
      `so no sandbox started. The cause is on ${base} itself - its code, or the image, setup, lean plan or a hook - not in a ticket: full output in ` +
      `.sandcastle/logs/base-gates.log. Fix it, then \`sandcastle gates\` to check (SKIP_BASE_GATES=1 runs anyway).`,
    [...run.gates.map((g) => ({ gate: g.name, ok: g.pass })), ...redHooks.map((t) => ({ gate: `hook test "${t.name}"`, ok: false })), ...(gitHook ? [{ gate: `git hook ${gitHook.name}`, ok: false }] : [])],
  );
};

// What a red gate said, less the numbers that differ between two runs of the
// same failure (durations, counts, ports). A repair that turns up a different
// failure has made progress; one that leaves the same failure has not.
// A gate whose message says neither word ("the export count says 12, but ...")
// is keyed by all it said: keyed by nothing, two different failures read as
// the same one and the repair loop stopped a pass early.
export const failureKey = (f: { name: string; output: string }) => {
  const lines = f.output.split("\n").map((l) => l.trim()).filter(Boolean);
  const said = lines.filter((l) => /fail|error/i.test(l));
  return `${f.name}\n${(said.length ? said : lines.slice(-20)).map((l) => l.replace(/\d+/g, "N")).join("\n")}`;
};
