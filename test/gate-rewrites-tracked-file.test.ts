// A gate that rewrites a tracked file (a build that regenerates a checked-in one) must not leave the worktree
// dirty: Sandcastle keeps a dirty worktree and its branch at close. runGates puts back only what the gates changed,
// the closing summary names the file once with the way to stop it, and a requeued ticket's kept worktree is one line.
// No Docker, model or network: the sandbox is a temp git repo, the one fake being how a command reaches it.
//
//   pnpm test:file test/gate-rewrites-tracked-file.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { runGates } = await import("../src/gates.ts");
const { render } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

// A worktree with a checked-in generated file; the gates are `sh` commands run in it.
const worktree = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-gate-rewrite-"));
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/generated.txt"), "checked in\n");
  writeFileSync(join(dir, "notes.txt"), "committed\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return dir;
};

// Runs what Sandcastle's exec would in the container: the gate wrapper (`timeout ... sh -c '<gate>'`) is
// replaced by the gate itself, as macOS has no `timeout`; every other command, the kit's own git, runs as written.
const boxOf = (dir: string, gates: string[]) => ({
  exec: async (cmd: string) => {
    const command = cmd.startsWith("timeout ") ? gates.find((g) => cmd.includes(g.replace(/'/g, "'\\''"))) ?? cmd : cmd;
    const r = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  },
});

const projectOf = (gates: string[]) => ({ name: "fixture", gates: gates.map((command, i) => ({ name: `gate${i}`, command })) }) as unknown as Parameters<typeof runGates>[0];

test("a gate that rewrites a tracked file leaves the worktree clean, and the run names the file", async () => {
  const dir = worktree();
  const gates = ["echo rebuilt > src/generated.txt && mkdir -p dist && echo out > dist/app.js"];
  const run = await runGates(projectOf(gates), boxOf(dir, gates), "fixture gates");
  assert.equal(run.failure, undefined);
  assert.deepEqual(run.rewrote, ["src/generated.txt"]);
  assert.equal(git(dir, "status", "--porcelain"), "", "nothing left for Sandcastle's close to keep");
  assert.equal(readFileSync(join(dir, "src/generated.txt"), "utf8"), "checked in\n");
  assert.ok(!existsSync(join(dir, "dist/app.js")), "a build the gates left behind is gone too");
});

test("a red gate puts back what it rewrote before it failed", async () => {
  const dir = worktree();
  const gates = ["echo rebuilt > src/generated.txt; exit 3"];
  const run = await runGates(projectOf(gates), boxOf(dir, gates), "fixture gates");
  assert.equal(run.failure?.exitCode, 3);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("what was uncommitted before the gates stays; only what the gates changed is put back", async () => {
  const dir = worktree();
  writeFileSync(join(dir, "notes.txt"), "the agent's unfinished edit\n");
  writeFileSync(join(dir, "draft.txt"), "untracked work\n");
  const gates = ["echo rebuilt > src/generated.txt"];
  const run = await runGates(projectOf(gates), boxOf(dir, gates), "fixture gates");
  assert.deepEqual(run.rewrote, ["src/generated.txt"]);
  assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "the agent's unfinished edit\n");
  assert.equal(readFileSync(join(dir, "draft.txt"), "utf8"), "untracked work\n");
  assert.equal(git(dir, "status", "--porcelain").split("\n").filter(Boolean).sort().join("|"), " M notes.txt|?? draft.txt");
});

test("gates that change nothing report no rewrite", async () => {
  const dir = worktree();
  const gates = ["true"];
  const run = await runGates(projectOf(gates), boxOf(dir, gates), "fixture gates");
  assert.equal(run.rewrote, undefined);
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

test("the summary names a kept worktree once, however often its ticket ran", () => {
  const kept = { issue: "7", path: ".sandcastle/worktrees/agent-issue-7" };
  const out = render(facts({ keptWorktrees: [kept, { ...kept }, { issue: "8", path: ".sandcastle/worktrees/agent-issue-8" }] }));
  assert.equal(out.split("Worktree kept with uncommitted files").length - 1, 2);
});

test("the summary names a rewritten file once, with how to stop it", () => {
  const out = render(facts({ gateRewrites: ["src/generated.txt"] }));
  const lines = out.split("\n").filter((l) => l.includes("src/generated.txt"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\.gitignore/);
  assert.match(lines[0], /generated/);
});

// burndown() needs Docker; its wiring is held here instead.
test("gate-only sandboxes reset before they close, and a run records what its gates rewrote", () => {
  const gates = readFileSync(join(import.meta.dirname, "../src/gates.ts"), "utf8");
  // Between the reset and the close only the `.git` check before the close (test/guard-worktree-records.test.ts) and the unlock.
  assert.match(
    gates,
    /await sandbox\.exec\("git reset -q --hard && git clean -fdq"\);\n\s*\} catch \{\n.*\n\s*\}\n(?:\s*\/\/.*\n)*\s*const when = .*\n\s*await checkBeforeClose\(project, sandbox\.worktreePath, when, .*\);\n\s*unlockWorktree\(sandbox\.worktreePath\);\n\s*await sandbox\.close\(\);/,
  );
  const burndown = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(burndown, /for \(const path of gated\.rewrote \?\? \[\]\)/);
  assert.match(burndown, /gateRewrites: \[\.\.\.gateRewrites\]/);
});
