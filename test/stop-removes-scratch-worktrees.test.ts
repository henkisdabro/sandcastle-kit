// A stop (Ctrl-C, `sandcastle stop`) while the opening base gates run left the gate sandbox's scratch worktree and its
// `sandcastle/base-gates-*` branch behind: `gateBase`'s clean-up is a `finally` the signal path never reaches, and the
// library's teardown only prints a "To clean up" line. The run's exit now removes the scratch worktrees this run opened
// (`removeOwnScratchOnExit`, src/guard.ts), unless it stopped on the guard or its `.git` check fails at that moment;
// an earlier run's leftover, and a ticket's `agent-issue-*` worktree, are never touched. A real child process over a
// temp repo with a fake `docker` ahead on PATH: the child wires the same pieces `burndown()` does (`exitOnSignal`,
// `rewordLibraryLines`, the exit hook) around the real `requireGreenBase`; no Docker, model or network. The call site in
// `burndown()` is held by a source match at the end, since no test drives `burndown()`.
//
//   pnpm test:file test/stop-removes-scratch-worktrees.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startNode } from "./cli-spawn.ts";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-stop-scratch-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A docker whose gate command `hang` says it is running (a file) and sits there; with `TAMPER=1` it also plants a file in
// the shared `.git/info/`, the kind of change the `.git` check stops a run for.
const DOCKER = join(TMP, "docker");
mkdirSync(DOCKER, { recursive: true });
writeFileSync(
  join(DOCKER, "docker"),
  `#!/bin/sh
case "$1" in
  run) while [ $# -gt 0 ]; do [ "$1" = "--name" ] && echo "$2" > "$FAKE_DOCKER/name"; shift; done ;;
  ps) case "$2" in -aq) cat "$FAKE_DOCKER/name" 2>/dev/null ;; esac ;;
  exec)
    case "$*" in
      *"git rev-parse HEAD"*) git -C "$FAKE_DOCKER_REPO" rev-parse main ;;
      *hang*)
        if [ "$TAMPER" = 1 ]; then mkdir -p "$FAKE_DOCKER_REPO/.git/info"; echo "* -text" > "$FAKE_DOCKER_REPO/.git/info/attributes"; fi
        echo up > "$FAKE_DOCKER/hanging"
        exec sleep 20 ;;
    esac ;;
esac
exit 0
`,
);
chmodSync(join(DOCKER, "docker"), 0o755);

// What `cli.ts` and `burndown()` do around a run's base gates, over the real pieces.
const FIXTURE = join(TMP, "fixture.mts");
writeFileSync(
  FIXTURE,
  `import { exitOnSignal, rewordLibraryLines } from ${JSON.stringify(join(KIT, "src/run.ts"))};
import { assertGitUnchanged, gitFingerprint, removeOwnScratchOnExit } from ${JSON.stringify(join(KIT, "src/guard.ts"))};
import { requireGreenBase } from ${JSON.stringify(join(KIT, "src/gates.ts"))};
import { loadProject } from ${JSON.stringify(join(KIT, "src/config.ts"))};
import { writePlan } from ${JSON.stringify(join(KIT, "src/lean.ts"))};
process.chdir(process.env.REPO!);
exitOnSignal();
rewordLibraryLines();
const project = await loadProject(process.env.REPO!);
const plan = writePlan(project).file;
const atStart = gitFingerprint(project);
process.on("exit", () => void removeOwnScratchOnExit(project, (when) => assertGitUnchanged(project, atStart, when), false));
await requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1", undefined, (when) => assertGitUnchanged(project, atStart, when));
`,
);
mkdirSync(join(TMP, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(TMP, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");

let n = 0;
/** A temp repo with a ticket's `agent-issue-1` worktree on `agent/issue-1` and, with `earlier`, a base-gates worktree an earlier run left. */
const repo = (earlier: boolean) => {
  const root = join(TMP, `repo-${++n}`);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "start");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "hang" }] };\n`);
  git(root, "worktree", "add", "-q", "-b", "agent/issue-1", join(root, ".sandcastle/worktrees/agent-issue-1"));
  if (earlier) git(root, "worktree", "add", "-q", "-b", "sandcastle/base-gates-1", join(root, ".sandcastle/worktrees/sandcastle-base-gates-1"));
  return root;
};

/** Runs the fixture over `root`, sends SIGINT once its gate is running, and returns what it printed once it ended. */
const stopped = async (root: string, tamper: boolean) => {
  const state = join(TMP, `state-${n}`);
  mkdirSync(state, { recursive: true });
  const env = {
    ...process.env,
    PATH: [DOCKER, dirname(process.execPath), process.env.PATH].join(delimiter),
    XDG_CACHE_HOME: join(TMP, "cache"),
    XDG_CONFIG_HOME: join(TMP, "config"),
    FAKE_DOCKER: state,
    FAKE_DOCKER_REPO: root,
    REPO: root,
    TAMPER: tamper ? "1" : "0",
  };
  const child = startNode([FIXTURE], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const ended = new Promise<void>((resolve) => child.on("close", () => resolve()));
  for (let i = 0; i < 600 && !existsSync(join(state, "hanging")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(join(state, "hanging")), `the gate never started: ${out}`);
  child.kill("SIGINT");
  await ended;
  return out;
};

const worktrees = (root: string) =>
  git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9).slice(root.length + 1))
    .filter(Boolean);
const branches = (root: string) => git(root, "branch", "--format=%(refname:short)").split("\n");
const scratchDirs = (root: string) => readdirSync(join(root, ".sandcastle/worktrees")).filter((f) => f.startsWith("sandcastle-"));

test("a run stopped by SIGINT while its base gates run leaves no scratch worktree or branch, and a ticket's worktree and branch stay", async () => {
  const root = repo(false);
  await stopped(root, false);
  assert.deepEqual(worktrees(root), [".sandcastle/worktrees/agent-issue-1"]);
  assert.deepEqual(scratchDirs(root), []);
  assert.deepEqual(branches(root).filter((b) => b.startsWith("sandcastle/")), []);
  assert.ok(branches(root).includes("agent/issue-1"));
  assert.ok(existsSync(join(root, ".sandcastle/worktrees/agent-issue-1/tracked.txt")));
});

test("the scratch worktree an earlier run left is still there after a later run is stopped", async () => {
  const root = repo(true);
  await stopped(root, false);
  assert.deepEqual(worktrees(root).sort(), [".sandcastle/worktrees/agent-issue-1", ".sandcastle/worktrees/sandcastle-base-gates-1"]);
  assert.deepEqual(branches(root).filter((b) => b.startsWith("sandcastle/")), ["sandcastle/base-gates-1"]);
});

test("a SIGINT whose exit-time .git check fails leaves the worktree, and the printed line says the run removes it unless that check fails", async () => {
  const root = repo(false);
  const out = await stopped(root, true);
  assert.equal(scratchDirs(root).length, 1, out);
  assert.ok(branches(root).some((b) => /^sandcastle\/base-gates-\d+$/.test(b)));
  assert.match(out, /To clean up: the run removes this throwaway worktree on exit unless its `\.git` check fails - then `sandcastle clean` does/);
});

test("burndown() hands its exit the run's .git reading and skips the removal after a guard stop", () => {
  const src = readFileSync(join(KIT, "src/burndown.ts"), "utf8");
  assert.match(src, /removeOwnScratchOnExit\(project, \(when\) => assertGitUnchanged\(project, exitFingerprint, when\), guardStopped\)/);
  assert.match(src, /exitFingerprint = host\.expected;/);
  assert.match(src, /if \(error instanceof GuardStop\) guardStopped = true;/);
});
