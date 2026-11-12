// A fresh ticket's branch (no commit of its own) is fast-forwarded to the base's tip once its sandbox is open and
// before the implement pass, so a landing that finished during the rest of the setup is in the branch the agent works on.
// When the fast-forward brought changed files the project's setup runs again first (a failed one fails the attempt as
// `SetupFailed`), the worktree's git records are checked before the host's git runs there, and a branch with a commit of
// its own is left alone. The pipeline (`createPipeline`) runs over faked ports with a temp git repo, as
// test/pipeline-base-merge-before-gates.test.ts does. No Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-fresh-branch-catch-up.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { SetupFailed } = await import("../src/errors.ts");
const { GuardStop } = await import("../src/guard.ts");
type PCtx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-catch-up-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
};
const commit = (cwd: string, file: string, text: string, message = `change ${file}`) => {
  write(cwd, file, text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

const ID = "7";
const BRANCH = `agent/issue-${ID}`;
const issue = { id: ID, title: "ticket 7", body: "" } as Issue;
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/**
 * A project in a temp repo and a pipeline over it with every port faked. `afterOpen` runs once the fake sandbox is open
 * (the worktree made), where a landing that finished during the setup is made. `setupRuns` counts the project's setup
 * hook run again in the sandbox after the open (the open itself runs none in the fake).
 */
const harness = (o: { setup?: string[]; afterOpen?: (root: string, worktree: string) => void; failSetup?: boolean } = {}) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n", "start");
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}} {{REVIEW_BASE}} {{REPAIR_BASE}}\n");
      return [kind, file];
    }),
  ) as PCtx["prompts"];
  const agents: Record<string, (worktree: string) => void> = {};
  // What the implement pass found in its tree when it started, and the setup hook runs the sandbox saw before it.
  const atImplement: { files: string[]; head: string; setupRuns: number }[] = [];
  const state = { setupRuns: 0 };

  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    o.afterOpen?.(root, path);
    const box = {
      worktreePath: path,
      exec: async (cmd: string) => {
        // The setup hook (`setupHook`) writes its record under /tmp: the fake answers it, the record is made-up.
        if (cmd.includes("sandcastle-setup") && cmd.includes("echo done")) {
          state.setupRuns++;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.includes("sandcastle-setup") && cmd.includes("@@output")) {
          return { exitCode: 0, stdout: o.failSetup && state.setupRuns > 0 ? "fail 0 3\n@@output\nnpm ERR! missing\n" : "done\n@@output\n", stderr: "" };
        }
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const before = git(path, "rev-parse", "HEAD");
        if ((opts.name ?? "").startsWith("impl")) atImplement.push({ files: git(path, "ls-files").split("\n"), head: before, setupRuns: state.setupRuns });
        agents[(opts.name ?? "").split("-")[0]]?.(path);
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    };
    return box as unknown as Box;
  };

  const project = {
    root,
    name: "fixture",
    baseBranch: "main",
    gates: [{ name: "test", command: "run-tests" }],
    generated: [],
    setup: o.setup ?? [],
    implement: {},
    review: {},
    repair: {},
  } as unknown as PCtx["project"];
  const tampered = new Map<string, unknown>();
  const results: PromiseSettledResult<unknown>[] = [];
  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as PCtx["tracker"],
    runId: "2026-10-07T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => GREEN,
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue: unknown, _phase: unknown, fn: () => unknown) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results,
    reds: new Map(),
    landed: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered,
  } as unknown as PCtx);
  const attempt = async () => quietly(() => pipeline(issue));
  return { root, agents, atImplement, state, tampered, attempt };
};

const implementing = (file: string, text: string) => (wt: string) => void commit(wt, file, text);

test("a landing that finished while the sandbox was opening is in the branch when the implement pass starts", async () => {
  const h = harness({ afterOpen: (root) => commit(root, "other.txt", "landed\n", "another ticket landed") });
  h.agents.impl = implementing("seven.txt", "seven\n");
  const { result: o, lines } = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(h.atImplement.length, 1);
  assert.ok(h.atImplement[0].files.includes("other.txt"), `implement saw: ${h.atImplement[0].files.join(", ")}`);
  assert.equal(h.atImplement[0].head, git(h.root, "rev-parse", "main"));
  assert.equal(git(h.root, "rev-list", "--count", `main..${BRANCH}`), "1");
  assert.ok(lines.some((l) => l.includes("had no commits ahead of main and was 1 commit(s) behind it when its sandbox opened - brought to main's tip before implement")), lines.join("\n"));
});

test("the project's setup runs again before implement when the fast-forward brought changed files", async () => {
  const h = harness({ setup: ["npm ci"], afterOpen: (root) => commit(root, "package.json", "{}\n", "a landing that adds a dependency") });
  h.agents.impl = implementing("seven.txt", "seven\n");
  const { result: o } = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(h.atImplement[0].setupRuns, 1, "the setup hook ran once, before implement");
  assert.equal(h.state.setupRuns, 1);
});

test("a base that did not move gets no fast-forward and no extra setup", async () => {
  const h = harness({ setup: ["npm ci"] });
  h.agents.impl = implementing("seven.txt", "seven\n");
  const { result: o, lines } = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(h.atImplement[0].setupRuns, 0);
  assert.equal(h.state.setupRuns, 0);
  assert.ok(!lines.some((l) => l.includes("brought to main's tip")), lines.join("\n"));
});

test("a setup that fails after the fast-forward fails the attempt as SetupFailed, and implement does not run", async () => {
  const h = harness({ setup: ["npm ci"], failSetup: true, afterOpen: (root) => commit(root, "package.json", "{}\n", "a landing that adds a dependency") });
  h.agents.impl = implementing("seven.txt", "seven\n");
  await assert.rejects(h.attempt(), (error) => error instanceof SetupFailed && /`npm ci` exited 3/.test(error.message));
  assert.equal(h.atImplement.length, 0, "no implement pass ran on a broken install");
});

test("a branch with a commit of its own is left as it is", async () => {
  const h = harness({
    setup: ["npm ci"],
    afterOpen: (root, wt) => {
      commit(wt, "own.txt", "mine\n", "the branch's own commit");
      commit(root, "other.txt", "landed\n", "another ticket landed");
    },
  });
  h.agents.impl = implementing("seven.txt", "seven\n");
  const own = () => git(h.root, "rev-parse", BRANCH);
  const { lines } = await h.attempt();
  // Not even tried: git would refuse a fast-forward of a branch that diverged, so only the count says it was never attempted.
  assert.ok(!lines.some((l) => l.includes("when its sandbox opened")), lines.join("\n"));
  assert.equal(h.state.setupRuns, 0);
  // The carried branch's own base merge (later in the pipeline) is not this fast-forward: its commit stays in the history.
  assert.ok(h.atImplement[0]?.files.includes("own.txt"));
  assert.notEqual(own(), git(h.root, "rev-parse", "main"));
});

test("a worktree record altered after the sandbox opened stops the run as tampered, before the host runs git there", async () => {
  const h = harness({
    afterOpen: (root, wt) => {
      commit(root, "other.txt", "landed\n", "another ticket landed");
      const name = wt.split("/").at(-1)!;
      writeFileSync(join(root, ".git", "worktrees", name, "config.worktree"), "[core]\n\tfsmonitor = true\n");
    },
  });
  h.agents.impl = implementing("seven.txt", "seven\n");
  await assert.rejects(h.attempt(), (error) => error instanceof GuardStop);
  assert.ok(h.tampered.get(ID) instanceof GuardStop);
  assert.equal(h.atImplement.length, 0);
});
