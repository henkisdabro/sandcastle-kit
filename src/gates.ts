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
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { HookTest, Project } from "./config.ts";
import { assertGitUnchanged, checkBeforeClose, gitFingerprint, protectedAmong } from "./guard.ts";
import type { Hook } from "./lean.ts";
import { peakOf, recordPeak, samplePeak, sampling } from "./peaks.ts";
import { withExtraSlot, withSlot } from "./pool.ts";
import { sandboxConfig, sh } from "./sandbox.ts";
import { execGate, GATE_TIMEOUT_SECONDS, unlockWorktree } from "./worktree-lock.ts";
import { OperatorError } from "./errors.ts";
import { localStamp } from "./stamp.ts";
import { shq } from "./generated.ts";

// `timedOut`: exit 124 from the gate's time bound, which reads as a bare exit code otherwise.
export type Gate = { name: string; pass: boolean; ms?: number; timedOut?: boolean };
type Failure = { name: string; command: string; exitCode: number; output: string };
// `waitMs`: how long the run waited for a machine-wide gates slot before its first gate started; a base run
// (`gateBase`) adds its wait for a machine-wide sandbox slot.
// `peakMib`: the sandbox's peak memory so far, read after the pass (src/peaks.ts); absent where the kernel gives none.
// `head`: the commit a base run (`gateBase`) gated, read in its sandbox: the base's name can move between asking and gating.
// `rewrote`: the tracked files the gates changed in the worktree, which were put back.
export type GateRun = { gates: Gate[]; failure?: Failure; failures: Failure[]; waitMs?: number; peakMib?: number; head?: string; rewrote?: string[] };

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

type Dirty = Map<string, string>;

// The worktree's changed paths with their status, or undefined when git cannot say (the sandbox died): a gate
// run never fails for want of this bookkeeping.
const dirtyPaths = async (sandbox: Parameters<typeof execGate>[0]): Promise<Dirty | undefined> => {
  try {
    const r = await sandbox.exec("git status --porcelain -z --no-renames --untracked-files=all");
    if (r.exitCode !== 0) return undefined;
    return new Map(r.stdout.split("\0").filter((e) => e.length > 3).map((e) => [e.slice(3), e.slice(0, 2)]));
  } catch {
    return undefined;
  }
};

// Sandcastle keeps a dirty worktree, and its branch, at close: a gate that rewrites a tracked file (a build that
// regenerates a checked-in one) or leaves a build behind would leak both. So the paths the gates changed are
// put back; whatever was dirty before them is the agent's, and stays. Returns the tracked files restored.
const restoreGateChanges = async (sandbox: Parameters<typeof execGate>[0], before: Dirty | undefined): Promise<string[]> => {
  if (!before) return [];
  const after = await dirtyPaths(sandbox);
  if (!after) return [];
  const changed = [...after].filter(([path]) => !before.has(path));
  const added = changed.filter(([, status]) => status[0] === "A").map(([path]) => path);
  const untracked = changed.filter(([, status]) => status === "??").map(([path]) => path);
  const tracked = changed.filter(([, status]) => status !== "??" && status[0] !== "A").map(([path]) => path);
  // In chunks: a build can leave thousands of files, more than one command line takes.
  const chunks = (paths: string[]) => {
    const out: string[][] = [[]];
    let size = 0;
    for (const p of paths) {
      if (size > 30_000) {
        out.push([]);
        size = 0;
      }
      out[out.length - 1].push(shq(p));
      size += p.length + 3;
    }
    return out.filter((c) => c.length);
  };
  try {
    for (const c of chunks(tracked)) await sandbox.exec(`git checkout HEAD -- ${c.join(" ")}`);
    for (const c of chunks(added)) await sandbox.exec(`git rm -qf -- ${c.join(" ")}`);
    for (const c of chunks(untracked)) await sandbox.exec(`git clean -fdq -- ${c.join(" ")}`);
  } catch {
    /* the gate's verdict stands; the sandbox's close reports a worktree that stays dirty */
  }
  return [...tracked, ...added];
};

// In order. A branch stops at the first red gate - its repair pass is fed
// that one's output, and the rest would only cost time. `all` runs every
// gate, for a report that says which of them are red, not just the first.
// `priority` is for the gates the run's end waits on - a landing's, the base check's, the verify's: when a
// machine-wide gates slot frees, they take it before the same run's ticket gates (`withSlot` in src/pool.ts).
export const runGates = (project: Project, sandbox: Parameters<typeof execGate>[0], label: string, all = false, progress: GateProgress = {}, priority = false) => {
  const asked = Date.now();
  return withSlot("gates", label, async (): Promise<GateRun> => {
    const waitMs = Date.now() - asked;
    const gates: Gate[] = [];
    const failures: Failure[] = [];
    const log = progress.log;
    // Said in the log, not only in the timings: the gate lines below are stamped when the gate starts, so a
    // wait reads as a gap between the section's header and its first gate.
    if (log && waitMs >= 1000) appendFileSync(log, `# waited ${Math.round(waitMs / 1000)}s for a gates slot\n`);
    const before = await dirtyPaths(sandbox);
    // The sandbox's anonymous memory while the gates run (src/peaks.ts): after them, the test workers are gone.
    await sampling(sandbox, "gate", async () => {
      for (const [i, g] of project.gates.entries()) {
        progress.gate?.(i, g.name);
        if (log) appendFileSync(log, `\n$ ${g.command}   # gate ${i + 1}/${project.gates.length}: ${g.name}, ${localStamp()}\n`);
        const since = Date.now();
        const r = await execGate(sandbox, g.command, log ? { onLine: (line) => appendFileSync(log, line + "\n") } : undefined);
        const ms = Date.now() - since;
        const timedOut = r.exitCode === 124;
        const timeout = `timed out after ${GATE_TIMEOUT_SECONDS / 60} min`;
        // With `onLine` set the sandbox streams stdout alone and returns stderr apart, so a log written only
        // from `onLine` has none of it - and a test runner prints its failures there. Not `2>&1` on the command:
        // the failure output's order would change for logged gates only, and `redOnBase` compares failure keys
        // between a branch and the base.
        if (log && r.stderr) appendFileSync(log, `# stderr of ${g.name} (at most its last 64 KiB):\n${r.stderr.endsWith("\n") ? r.stderr : r.stderr + "\n"}`);
        if (log) appendFileSync(log, `# ${g.name} ${r.exitCode === 0 ? "green" : timedOut ? `RED (${timeout})` : `RED (exit ${r.exitCode})`} in ${seconds(ms)}\n`);
        gates.push({ name: g.name, pass: r.exitCode === 0, ms, ...(timedOut ? { timedOut } : {}) });
        if (r.exitCode === 0) continue;
        // Without the colour codes a test runner prints into a pipe (vitest does, with no TTY and no TERM): the repair
        // prompt, `failureKey` and `failingTests` read plain text. The gates log, written as the gate ran, keeps them.
        const output = clip(
          stripVTControlCharacters([...(timedOut ? [`The gate ${timeout} and was stopped; its output so far:`] : []), r.stdout, r.stderr].filter(Boolean).join("\n")).trim(),
        );
        failures.push({ name: g.name, command: g.command, exitCode: r.exitCode, output });
        // A timed-out gate may still be running in this container (or Docker
        // may not be answering): a later gate would run beside it, or wait out
        // its own timeout too.
        if (!all || r.exitCode === 124) break;
      }
    });
    const peakMib = await samplePeak(sandbox);
    const rewrote = await restoreGateChanges(sandbox, before);
    return { gates, failure: failures[0], failures, waitMs, ...(peakMib !== undefined ? { peakMib } : {}), ...(rewrote.length ? { rewrote } : {}) };
  }, progress.wait, undefined, priority);
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
// `clean`: the commands of the hooks that ran to a verdict in this test - exit 0, or a block - and did not error. A
// test that passes says nothing of a guard whose own error it ignored (a block test passes when any guard blocks), so
// only these are vouched for.
export type HookTestResult = { name: string; pass: boolean; detail: string; clean: string[] };

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
      results.push({ name: t.name, pass: false, detail: `no kept PreToolUse hook matches ${t.tool}`, clean: [] });
      continue;
    }
    const stdin = JSON.stringify({
      session_id: "sandcastle-hook-test", transcript_path: "", cwd, permission_mode: "bypassPermissions",
      hook_event_name: "PreToolUse", tool_name: t.tool, tool_input: t.input,
    });
    const blockers: string[] = [];
    const errors: string[] = [];
    const clean: string[] = [];
    for (const h of guards) {
      const cmd = `CLAUDE_PROJECT_DIR='${cwd}' timeout 60 sh -c '${h.command.replace(/'/g, "'\\''")}'`;
      const r = await sandbox.exec(cmd, { stdin });
      if (blocked(r) || r.exitCode === 0) clean.push(h.command);
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
    results.push({ name: t.name, pass, detail, clean: pass ? clean : [] });
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
// `withGates` false runs only those hook checks, for a base a landing's or verify's gates already passed.
// `runId` is the run these gates belong to, which the sandbox's peak is filed under.
// `ownSlot` false runs it in the sandbox slot the caller holds: a ticket's pipeline that waits on
// the answer, its own sandbox idle, would otherwise wait for a slot it holds itself - for ever
// with a pool of one slot, or with every slot of the run's cap held by tickets red on one test.
// `check` is the `.git` check of the run around it (`HostGit.check`), made before the sandbox closes.
export const gateBase = (project: Project, image: string, planFile: string, label: string, hookTests = false, runId?: string, ownSlot = true, withGates = true, check?: (when: string) => unknown) => {
  // The wait for a machine-wide sandbox slot is `waitMs` too, as a ticket's and a landing's is: a run that verified
  // while another held the machine's sandboxes would otherwise put that wait into the estimate's verify step.
  const asked = Date.now();
  const gated = async () => {
    const slotWaitMs = Date.now() - asked;
    const branch = `sandcastle/${label.replace(/\W+/g, "-")}-${Date.now()}`;
    const sandbox = await createSandbox({ branch, baseBranch: project.baseBranch, ...sandboxConfig(project, image, planFile) });
    // With no run's check (the base gates at a run's start, when none of its sandboxes ran yet), a reading of its own,
    // taken once the sandbox is open: git may write the repo's config as it adds a worktree (`worktree.useRelativePaths`).
    const own = check ? undefined : gitFingerprint(project);
    const checkGit = (when: string) => (own ? assertGitUnchanged(project, own, when) : check?.(when));
    try {
      // Before the gates, which may leave the worktree anywhere: the sandbox was cut from the base's name, so a
      // landing after the caller read the tip is in here, and the run is that commit's, not the one asked about.
      const head = (await sandbox.exec("git rev-parse HEAD")).stdout.trim() || undefined;
      // The base and verify gates end a run's wait for them; the mid-run check (`ownSlot` false) is a ticket's, run in its slot.
      const run: GateRun = withGates ? await runGates(project, sandbox, `${project.name} ${label}`, true, undefined, ownSlot) : { gates: [], failure: undefined, failures: [], waitMs: 0 };
      // Red on the base, whoever asked: a green record of it (a landing's, the verify's) would have the next
      // turn skip the check on a base known to be red - a flaky test passes once and fails the next time.
      if (run.failures.length || run.gates.some((g) => !g.pass)) noteBaseResult(project.root, "", false);
      const hooks = (JSON.parse(readFileSync(planFile, "utf8")) as { hooks: Hook[] }).hooks;
      return {
        ...run,
        waitMs: slotWaitMs + (run.waitMs ?? 0),
        head,
        hookTests: hookTests ? await runHookTests(project.hookTests, hooks, sandbox) : [],
        gitHooks: hookTests ? await runGitHookProbe(sandbox) : undefined,
      };
    } finally {
      await recordPeak(sandbox, project.root, runId);
      // Sandcastle's close keeps a worktree with any uncommitted file, and a gate or a hook test leaves one: the
      // kept worktree and its branch would outlive the run, unnamed.
      try {
        await sandbox.exec("git reset -q --hard && git clean -fdq");
      } catch {
        /* closing still has to happen */
      }
      // Sandcastle's close runs `git status` on the host in the worktree: the container is stopped, and the `.git`
      // check and the worktree's records made, before it. A failure throws with the container removed, the worktree
      // and its branch left for a person.
      const when = `before closing the ${label} sandbox`;
      await checkBeforeClose(project, sandbox.worktreePath, when, () => checkGit(when));
      unlockWorktree(sandbox.worktreePath);
      await sandbox.close();
      try {
        sh("git", ["branch", "-D", branch]);
      } catch {
        /* never created */
      }
    }
  };
  // In the caller's slot the sandbox is still a sandbox: an extra slot, never waited for, shows it to other runs.
  return ownSlot ? withSlot("sandboxes", `${project.name} ${label}`, gated) : withExtraSlot("sandboxes", `${project.name} ${label}`, gated);
};

// What the closing summary says of a tracked file a gate rewrote, once per path for the run.
export const rewroteLine = (path: string) =>
  `A gate rewrote ${path} and it was put back, so no worktree stays dirty. Add it to .gitignore, or list it under \`generated\` in the project config, so the gate stops rewriting a tracked file.`;

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
// node:test's spec reporter ends a red run with a "✖ failing tests:" summary
// that puts "test at <path>:<line>:<col>" above each failing leaf test, so its
// ids there are "path::name", like pytest's, and the base-red check can tell
// whose red it is. The summary is the whole list: the body's "✖" lines before
// it also name the describe suites and parents of a failed test, which are
// not tests. Pairs go by position, never by name, as one name can fail in two
// files. Without the summary (TAP, a summary cut off, Node 20 and 22's TAP
// default with its absolute "location:" paths) the ids name no file, and the
// red stays the branch's own.
const SPEC_FAILED = /^\s*✖ (?!failing tests:|\d+ problems? \()(.+?)(?: \([\d.]+m?s\))?$/;
// vitest's workspace projects put a label after FAIL: "|web|" without colour, a bare "web" badge with it. The label
// is skipped, a bare word only when a file follows that is not a duration: Go's "FAIL<TAB>mymod<TAB>0.004s" is a
// package, and its "0.004s" would pass for a file.
const FAIL_LINE = /^\s*FAIL\s+(?:\|[^|\s]+\|\s+|(?=[^\s/.]+\s+(?!\d+(?:\.\d+)?m?s(?:\s|$))[^\s/][^\s]*\.[A-Za-z0-9]+(?:\s|$))[^\s/.]+\s+)?(\S+)/;
const FAILING_TEST_LINE = [
  /^(?:FAILED|ERROR)\s+(\S+)/,
  FAIL_LINE,
  /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/,
  SPEC_FAILED,
  /^\s*--- FAIL: (\S+)/,
  /^test (\S+) \.\.\. FAILED$/,
];
/** True when a single output line is a failing-test match (the patterns `failingTests` reads). */
export const namesFailingTest = (line: string) => FAILING_TEST_LINE.some((re) => re.test(line));
/** How many failing tests `failingTests` names by default: a list this long may have been cut, so it is not the whole set. */
export const FAILING_TESTS_SHOWN = 5;
const SPEC_SUMMARY = /^✖ failing tests:$/;
const SPEC_LOCATION = /^test at (.+):\d+:\d+$/;
const CLIPPED = /^\[\.\.\. \d+ characters cut \.\.\.\]$/;
const idsOf = (line: string) => FAILING_TEST_LINE.map((re) => re.exec(line)?.[1]).filter((id): id is string => id !== undefined);
// `limit`: the base-red check reads the base's whole list (Infinity): a branch's test sixth on it is still the base's.
export const failingTests = (output: string, limit = FAILING_TESTS_SHOWN) => {
  // A runner colours its output when it has no TTY and no NO_COLOR (vitest does), which hides its FAIL lines.
  const lines = stripVTControlCharacters(output).split("\n").map((line) => line.replace(/\r$/, ""));
  const header = lines.findIndex((line) => SPEC_SUMMARY.test(line));
  // A summary `clip` cut through is not the whole list: a test it lost could be the branch's own.
  const summary = header >= 0 && lines.slice(header).some((line) => CLIPPED.test(line)) ? -1 : header;
  if (summary < 0) return [...new Set(lines.flatMap(idsOf))].slice(0, limit);
  const before = lines.slice(0, summary).flatMap((line) => (SPEC_FAILED.test(line) ? [] : idsOf(line)));
  const listed: string[] = [];
  let at: string | undefined;
  for (const line of lines.slice(summary + 1)) {
    const name = line.startsWith("✖ ") ? SPEC_FAILED.exec(line)?.[1] : undefined;
    // A file that failed to load is listed under its own path, which is the id.
    if (name !== undefined) listed.push(at === undefined || name === at ? name : `${at}::${name}`);
    at = SPEC_LOCATION.exec(line)?.[1];
  }
  return [...new Set([...before, ...listed])].slice(0, limit);
};

/**
 * The failing tests across a red run's gates, for the end-of-run verify's excerpt and summary: at most
 * `FAILING_TESTS_SHOWN` names, and `more` when the output named others. Each gate is read whole first: a list
 * cut at the limit inside `failingTests` could not say there were more.
 */
export const verifyFailing = (failures: GateRun["failures"]) => {
  const all = [...new Set(failures.flatMap((f) => failingTests(f.output, Infinity)))];
  return { tests: all.slice(0, FAILING_TESTS_SHOWN), more: all.length > FAILING_TESTS_SHOWN };
};

/**
 * The file a failing test's id names, or undefined when it names none. pytest's "path::test",
 * vitest's and jest's "FAIL path" and node:test's summary "path::name" do; node:test's bare "name",
 * Go's "TestName" and cargo's "mod::name" do not, and a guess from a test's title would call a
 * branch's own red the base's. Relative paths inside the repo only: one through "../" is not the repo's.
 */
export const failingTestFile = (id: string) => {
  const file = id.split("::")[0].replace(/^\.\//, "");
  return /^[^\s/][^\s]*\.[A-Za-z0-9]+$/.test(file) && !file.split("/").includes("..") ? file : undefined;
};

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

/**
 * A step's times with a wait that came before it began added to `waitMs`: a sent-back ticket waits for the
 * tickets ahead of its resolve before its `setup` step starts, so `elapsed` never held that wait, and a wait
 * left off the setup line showed nowhere at all.
 */
export const withQueued = (times: { ms: number; waitMs?: number }, queued: number | undefined): { ms: number; waitMs?: number } => {
  const q = typeof queued === "number" && queued > 0 ? Math.round(queued) : 0;
  return q ? { ms: times.ms, waitMs: (times.waitMs ?? 0) + q } : times;
};
/**
 * The phase of a landing gate's timings line (a tree merged in the landing worker's sandbox). Apart from
 * `gates`, a ticket's own passes: landings run one after another on one worker, so they are summed on
 * their own, and are no part of a ticket's pipeline time.
 */
export const LANDING_GATES = "landing gates";

/**
 * The phase of a landing's own timings line: one per landing that reached its merge, whatever it ended in (a
 * fast-forward, a conflict, a red tree). Its `ms` is the landing less its slot wait, which is `waitMs`; the landing
 * gates it ran are lines of their own (`LANDING_GATES`) and are in its `ms` too, so a sum of a ticket's
 * time leaves this line out, as it leaves out the landing gates, or it counts them twice.
 */
export const LANDING = "landing";

/**
 * Appends a landing's timings line (`LANDING`): `elapsed` is the landing's whole time, `slotWaitMs` how long it waited
 * for a machine-wide sandbox slot (0 for a fast-forward, which takes none, and for a conflict found on the host
 * before one), `result` the kind of ending `landOne` returned. Without it a landing that waited minutes for a slot
 * and then found a conflict ran no gate and left no line at all.
 */
export const writeLandingLine = (
  timings: string, who: { run: string; project: string; issue: string; carried?: boolean }, took: { elapsed: number; slotWaitMs: number }, result: { ok: boolean; kind: string },
) => {
  const line = {
    ts: new Date().toISOString(), run: who.run, project: who.project, issue: who.issue, phase: LANDING, ...stepTimes(took.elapsed, { waitMs: took.slotWaitMs }), ok: result.ok, result: result.kind,
    ...(who.carried ? { carried: true } : {}),
  };
  appendFileSync(timings, JSON.stringify(line) + "\n");
};

/**
 * Runs a landing gate and appends its timings line (`LANDING_GATES`, the slot wait out of `ms` as in
 * `stepTimes`) to `timings`, whether it came back red or threw. Not the run's `timed`: that writes the
 * ticket's state, and a ticket landing already holds the landing stage `landOne` wrote.
 */
export const timedLandingGate = async <T>(
  timings: string, who: { run: string; project: string; issue: string; carried?: boolean }, fn: () => Promise<T>,
): Promise<T> => {
  const since = Date.now();
  let result: T | undefined;
  let done = false;
  try {
    result = await fn();
    done = true;
    return result;
  } finally {
    const red = done ? gateRed(result) : undefined;
    const gateTimes = done ? gateMs(result) : undefined;
    const peakMib = done ? peakOf(result) : undefined;
    const line = {
      ts: new Date().toISOString(), run: who.run, project: who.project, issue: who.issue, phase: LANDING_GATES, ...stepTimes(Date.now() - since, result), ok: done && !red?.length,
      ...(who.carried ? { carried: true } : {}),
      ...(gateTimes ? { gates: gateTimes } : {}),
      ...(peakMib ? { peakMib } : {}),
      ...(red?.length ? { red } : {}),
    };
    appendFileSync(timings, JSON.stringify(line) + "\n");
  }
};

const gateTimeLine =(gates: Gate[]) =>
  [...gates].filter((g) => g.ms !== undefined).sort((a, b) => b.ms! - a.ms!).map((g) => `${g.name} ${seconds(g.ms!)}`).join(", ");

// A green result holds for as long as nothing it depended on changes: the
// base commit, the image, and the config that shapes a sandbox.
// `commit` is the one a gate ran on, when that is not what the base names now.
const baseKey = (project: Project, image: string, planFile: string, commit = sh("git", ["rev-parse", project.baseBranch])) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        commit,
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

// Whether the record at this key also covers the hook tests and the git-hook probe, which only the base check runs.
// A record without the field (an older kit's) covers the gates alone.
const hooksCovered = (root: string, key: string) => {
  try {
    const record = JSON.parse(readFileSync(baseRecord(root), "utf8"));
    return record.key === key && record.hooks === true;
  } catch {
    return false;
  }
};

// A green result is recorded; a red one removes the record. A gate that
// depends on the clock or the network can go red at the same key `sandcastle
// gates` was green at, and a record left behind would have the next run skip
// the check and fan agents out on a base known to be red.
// `hooks` says the green result covered the hook tests and the git-hook probe as well as the gates: only the base check
// runs them, so a landing's or verify's record (gates alone) leaves the next base check its hook checks, which a
// commit that changed a hook file would otherwise have skipped - unless `noteGreenCommit` finds the record before it
// covered them and no file they read changed.
// `run` is this process: a skip says "verified this run" only for a record this run wrote. Not the run record's
// `startedAt`, which every autonomy turn writes afresh, so a drain turn never knew its own run's verify.
const THIS_RUN = `${process.pid}@${Math.round(Date.now() - process.uptime() * 1000)}`;
// `proof` is the commit that result is of, whose gates proved it (a ticket's `#427`, "the base check", "verify") and
// where they ran (`kind`): the end-of-run verify says it when it skips for this record, and a record without one is an
// older kit's. A `ticket-sandbox` proof is a fast-forward's: the ticket's own gates, in the sandbox its agent worked in
// (its git identity, its caches), which a clean gate-only sandbox may not reproduce - so the verify never trusts it.
export type ProofKind = "ticket-sandbox" | "landing-sandbox" | "base" | "verify";
export type GreenProof = { commit: string; by: string; kind: ProofKind };
// `hookRuns` are the commands of the kept hooks that ran cleanly in a passing hook test (`HookTestResult.clean`), which the
// lean hook check reads to drop its unseen-import warning. They travel with `hooks`: a record that covers the hook tests
// keeps the list of the record it covers (same key) or is handed the carried one, and a record that does not has none.
export const noteBaseResult = (root: string, key: string, green: boolean, hooks = false, proof?: GreenProof, hookRuns?: string[]) => {
  const file = baseRecord(root);
  if (!green) return rmSync(file, { force: true });
  // The key names the commit, so the hook files: a gates-only result at the key a base check recorded in full says nothing less.
  const covered = hooks || hooksCovered(root, key);
  const runs = !covered ? [] : (hookRuns ?? (hooksCovered(root, key) ? recordedHookRuns(root) : []));
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  writeFileSync(file, JSON.stringify({ key, at: new Date().toISOString(), run: THIS_RUN, hooks: covered, hookRuns: runs, ...(proof ? { commit: proof.commit, by: proof.by, kind: proof.kind } : {}) }) + "\n");
};

const recordedHookRuns = (root: string): string[] => {
  try {
    const runs = JSON.parse(readFileSync(baseRecord(root), "utf8")).hookRuns;
    return Array.isArray(runs) ? runs.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
};

const recordedRun = (root: string): string | undefined => {
  try {
    return JSON.parse(readFileSync(baseRecord(root), "utf8")).run;
  } catch {
    return undefined;
  }
};

// A package manifest or lockfile, by name: the project's setup (a `pnpm install`) reads one, and the sandbox the hook
// checks run in is set up from it, so a change to one re-checks the hooks as a change to a hook file does.
const MANIFEST = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|uv\.lock|pdm\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|setup\.(py|cfg)|Cargo\.(toml|lock)|go\.(mod|sum|work)|Gemfile(\.lock)?|composer\.(json|lock)|mix\.(exs|lock)|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|[^/]*\.csproj|packages\.lock\.json|deno\.(json|jsonc|lock))$/;

// Whether any file changed between two commits is one the hook tests or the git-hook probe read: the hooks directory
// (`core.hooksPath`, `.husky`, `.git-hooks`, the default protected set), the files the lean plan's kept hooks run, the
// package manifests and lockfiles, and `protectedPaths`. A conservative list, not a trace: anything it does not name
// but a hook reads is a miss the maintainer chose to accept. A diff that cannot be read says yes.
const hookInputsChanged = (project: Project, planFile: string, from: string, to: string): boolean => {
  let changed: string[];
  try {
    changed = sh("git", ["diff", "--name-only", from, to], project.root).split("\n").filter(Boolean);
  } catch {
    return true;
  }
  const dirs = [".husky/", ".git-hooks/"];
  try {
    // `--local`: the host's own hooks are switched off through the environment, which a plain read would answer with.
    const configured = sh("git", ["config", "--local", "--get", "core.hooksPath"], project.root);
    const rel = isAbsolute(configured) ? relative(project.root, configured) : posix.normalize(configured);
    if (configured && rel && !rel.startsWith("..") && !isAbsolute(rel)) dirs.push(`${rel.replace(/\/+$/, "")}/`);
  } catch {
    // no core.hooksPath set
  }
  let commands: string[] = [];
  try {
    commands = (JSON.parse(readFileSync(planFile, "utf8")) as { hooks?: Hook[] }).hooks?.map((h) => h.command) ?? [];
  } catch {
    return true;
  }
  return changed.some(
    (f) => dirs.some((d) => f.startsWith(d)) || MANIFEST.test(posix.basename(f)) || protectedAmong(project, [f]).length > 0 || commands.some((c) => c.includes(f)),
  );
};

/**
 * A commit the run's own gates passed on - a landing's merge, which the base now names - is the green
 * base the next turn's check would otherwise gate again, in the one gate slot, minutes later.
 * The record covers the hook tests and the git-hook probe too (so the next check opens no base sandbox) only when
 * the record before it did, at a commit it names, on this image and config, and nothing the hook checks read changed
 * since (`hookInputsChanged`). Anything else - no earlier record, an older kit's without a commit - re-checks.
 * `kind` has no default: a caller that forgot it would otherwise be trusted to skip the verify (`greenProofOfBase`).
 */
export const noteGreenCommit = (project: Project, image: string, planFile: string, commit: string, by: string, kind: ProofKind) => {
  const hooks = hookRecordHolds(project, image, planFile, commit);
  noteBaseResult(project.root, baseKey(project, image, planFile, commit), true, hooks, { commit, by, kind }, hooks ? recordedHookRuns(project.root) : []);
};

// Whether the record on disk covers the hook tests and the git-hook probe at a commit it names, on this image and
// config, with nothing they read changed from that commit to `commit`. No record, or an unreadable one: no.
const hookRecordHolds = (project: Project, image: string, planFile: string, commit: string): boolean => {
  try {
    const prev = JSON.parse(readFileSync(baseRecord(project.root), "utf8"));
    return (
      prev.hooks === true &&
      typeof prev.commit === "string" &&
      prev.key === baseKey(project, image, planFile, prev.commit) &&
      !hookInputsChanged(project, planFile, prev.commit, commit)
    );
  } catch {
    return false;
  }
};

/**
 * The commands of the kept hooks that ran cleanly in a passing hook test, from the base check's record - for the lean
 * hook check, which prints before the base gates and so before this run's hook tests. The record counts at the base's
 * tip when it covers the hook tests there (`hookRecordHolds`): a commit that changed a hook file, a manifest or a
 * lockfile, another image or another plan leaves none, and the check warns as it did.
 */
export const hooksThatRanClean = (project: Project, image: string, planFile: string): string[] => {
  try {
    return hookRecordHolds(project, image, planFile, sh("git", ["rev-parse", project.baseBranch], project.root)) ? recordedHookRuns(project.root) : [];
  } catch {
    return [];
  }
};

/**
 * Whether the green-base record already proves the base's tip on this image and plan: the commit, whose gates ran on
 * it (`by`) and where (`kind`). The end-of-run verify is proof that the merged base is green in a clean gate-only
 * sandbox, so it is skipped when this answers, and only for a proof from one: a landing merged in a landing sandbox,
 * the base check or an earlier verify. A fast-forward's proof (`ticket-sandbox`: the ticket's own gates, run in the
 * sandbox its agent worked in) and a record from an older kit (no `kind`) leave the verify to run, as does a missing
 * record or one at another commit (a landing's failed note is swallowed). The next turn's base check reads the record
 * with `baseCacheHit`, whatever its kind. The key is the record's own test, as the base check's is.
 */
export const greenProofOfBase = (project: Project, image: string, planFile: string): { commit: string; by?: string; kind: ProofKind } | undefined => {
  const commit = sh("git", ["rev-parse", project.baseBranch], project.root);
  if (!baseCacheHit(project.root, baseKey(project, image, planFile, commit))) return undefined;
  try {
    const record = JSON.parse(readFileSync(baseRecord(project.root), "utf8"));
    const kind = record.kind;
    if (kind !== "landing-sandbox" && kind !== "base" && kind !== "verify") return undefined;
    return { commit, ...(typeof record.by === "string" && record.by ? { by: record.by } : {}), kind };
  } catch {
    return undefined;
  }
};

/**
 * What the end-of-run verify does: `due` when at least one ticket merged (or a merge regenerated files), and
 * `skipped` when the green-base record already holds a gate-only proof of the tip (`greenProofOfBase`). A run that
 * landed one ticket as a fast-forward records a `ticket-sandbox` proof, which is none, so its verify runs: nothing
 * else would gate that tip in a clean sandbox, and the next turn's base check reads the record of any kind.
 */
export const verifyPlan = (project: Project, image: string, planFile: string, merged: number, regenerated: number): { due: boolean; skipped?: ReturnType<typeof greenProofOfBase> } => {
  if (merged === 0 && regenerated === 0) return { due: false };
  const skipped = greenProofOfBase(project, image, planFile);
  return skipped ? { due: true, skipped } : { due: true };
};

/**
 * The gates on the merged base at the end of a run (`gateBase`, no hook tests). What they say of the
 * commit they ran on is the base's record, as the base check's own result is: green is the next
 * turn's skip, red removes a record that would skip a base known to be red.
 */
export const verifyBase = async (project: Project, image: string, planFile: string, runId?: string, check?: (when: string) => unknown) => {
  const gated = await gateBase(project, image, planFile, "verify", false, runId, true, true, check);
  const green = !gated.failures.length && gated.gates.every((g) => g.pass);
  // The commit the sandbox was cut from, not the base's name: a landing since would be a commit nobody gated.
  if (green && gated.head) noteGreenCommit(project, image, planFile, gated.head, "verify", "verify");
  else noteBaseResult(project.root, "", false);
  return gated;
};

/** Red on the base before any agent ran. Carries each gate's verdict so the run record, and the closing summary, can name the red ones. */
export class BaseRedError extends OperatorError {
  readonly baseGates: { gate: string; ok: boolean }[];
  constructor(message: string, baseGates: { gate: string; ok: boolean }[]) {
    super(message);
    this.baseGates = baseGates;
  }
}

/**
 * Writes each red gate's full output to `log` (base gates, and the gates on the merged base at the
 * end of a run), or removes it when every gate passed: a log left by an earlier red run would read
 * as this run's result. Returns whether it wrote one.
 */
/** Where a red verify (the gates on the merged base at the end of a run) leaves its output. */
export const VERIFY_LOG = ".sandcastle/logs/verify-gates.log";

/**
 * The Dockerfiles a run's merges changed between `from` and `to` (commits on the base): the kit's base image
 * (`docker/base.Dockerfile`) and the project's own layer (the config's `dockerfile`). The run's image is
 * built before the first landing, so the verify gates the merged tree on an image without them; the closing
 * summary says so. A path git cannot place is no change: nothing here may fail a run that has landed.
 */
export const changedDockerfiles = (project: Pick<Project, "root" | "dockerfile">, from: string, to: string): string[] => {
  const watched = ["docker/base.Dockerfile", ...(project.dockerfile ? [project.dockerfile] : [])].map((d) => posix.normalize(d));
  try {
    const changed = new Set(sh("git", ["diff", "--no-renames", "--name-only", from, to], project.root).split("\n").filter(Boolean).map((l) => posix.normalize(l)));
    return [...new Set(watched.filter((d) => changed.has(d)))];
  } catch {
    return [];
  }
};

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
 * config were green before. `check` is the `.git` check before its sandbox closes (`gateBase`).
 */
export const requireGreenBase = async (project: Project, image: string, planFile: string, cached = true, runId?: string, check?: (when: string) => unknown) => {
  const log = join(project.root, ".sandcastle/logs/base-gates.log");
  const key = baseKey(project, image, planFile);
  const base = project.baseBranch;
  // A landing's or verify's green record covers the gates, and the hook tests and the git-hook probe only when
  // `noteGreenCommit` carried them over from the record before it.
  const gatesGreen = cached && baseCacheHit(project.root, key);
  if (gatesGreen) {
    const commit = sh("git", ["rev-parse", "--short", base]);
    const seen = recordedRun(project.root) === THIS_RUN ? `green at ${commit} already (verified this run)` : "green at this commit and image before";
    if (hooksCovered(project.root, key)) {
      console.log(`Gates on ${base}: ${seen} - not re-run.`);
      return;
    }
    console.log(`Gates on ${base}: ${seen} - gates not re-run; running the hook tests and the git-hook probe in a sandbox, before any agent starts ...`);
  } else console.log(`Gates on ${base}: running every gate on the base commit in a sandbox, before any agent starts ...`);
  const run = await gateBase(project, image, planFile, "base-gates", true, runId, true, !gatesGreen, check);
  if (!gatesGreen) {
    console.log(`Gates on ${base}: ${gateLine(run.gates)}`);
    for (const line of gateResultLines(project.gates, run.gates)) console.log(line);
    console.log(`  time per gate, slowest first: ${gateTimeLine(run.gates)}`);
  }
  for (const t of run.hookTests) console.log(`  hook test ${t.pass ? "pass" : "FAIL"}  ${t.name} - ${t.detail}`);
  if (run.gitHooks) console.log(`  ${gitHooksLine(run.gitHooks)}`);
  const redHooks = run.hookTests.filter((t) => !t.pass);
  const gitHook = run.gitHooks?.failure;
  const green = !run.failures.length && !redHooks.length && !gitHook;
  // A hook test that ran every hook of this run passed when `green` (a red one removes the record).
  const hookRuns = [...new Set(run.hookTests.flatMap((t) => t.clean))];
  noteBaseResult(project.root, key, green, true, { commit: sh("git", ["rev-parse", base]), by: "the base check", kind: "base" }, hookRuns);
  const commit = sh("git", ["rev-parse", "--short", base]);
  writeGateLog(
    log,
    `# base gates on ${base} at ${commit}, ${new Date().toISOString()}: ${gatesGreen ? "gates green on record, not re-run" : gateLine(run.gates)}` +
      (redHooks.length ? ` hook-tests=${redHooks.length}-FAIL` : "") +
      (gitHook ? ` git-hook=${gitHook.name}-FAIL` : ""),
    run.failures,
    redHooks.map((t) => `===== hook test ${t.name}\n${t.detail}\n`).join("\n") + (gitHook ? `===== git hook ${gitHook.name}\n${gitHook.output}\n` : ""),
  );
  // For the run's "base gates" timings line, as verify's carries them: per-gate times, the slot wait
  // (out of `ms`) and the sandbox's peak.
  if (green) return { gates: run.gates, waitMs: run.waitMs, ...(run.peakMib !== undefined ? { peakMib: run.peakMib } : {}) };
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
