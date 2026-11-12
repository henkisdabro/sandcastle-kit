// The run's `.git` check (`host.check`) runs once more between a red gate and the repair pass, after the fix board's
// wait, the merge of a landed fix and the counted slot wait: a change made on the host stops the run as the ticket's `tampered`
// before the repairer reads it as the red's cause. A check that passes goes on to the repair pass as before. The
// pipeline (`createPipeline`, src/burndown.ts) runs over its faked ports - a temp repo, a host worktree as its sandbox,
// scripted agents and gate runs. No Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-repair-git-check.test.ts

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
const { attempted, createPipeline } = await import("../src/burndown.ts");
const { GuardStop } = await import("../src/guard.ts");
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type PCtx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-repair-check-"));
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
const issue = { id: ID, title: "ticket 7", body: "" } as Issue;
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const failure = { name: "test", command: "run-tests", exitCode: 1, output: "something failed\n" };
const RED: GateRun = { gates: [{ name: "test", pass: false }], failure, failures: [failure] };

/** The guard's stop for a `.git` check that sees a change, worded as `src/guard.ts` words it. */
const stop = (when: string) =>
  new GuardStop(`STOPPED ${when}: config changed while sandboxes ran. A sandbox may have tampered with the shared .git.`, { what: "the shared .git changed while sandboxes ran" });

/**
 * A project in a temp repo and a pipeline over it with every port faked. `check` is the host's `.git` check: it is
 * handed each `when` it is asked with, in order (`asked`). `fixes` replaces the run's fix board where a test needs a wait.
 */
const harness = (o: { check: (when: string) => Promise<void> | void; fixes?: unknown }) => {
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
  const events: string[] = [];
  const asked: string[] = [];
  const gates: GateRun[] = [];

  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const box = {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const kind = (opts.name ?? "").split("-")[0];
        events.push(kind);
        const before = git(path, "rev-parse", "HEAD");
        if (kind === "impl") commit(path, "seven.txt", "seven\n");
        if (kind === "repair") commit(path, "seven.txt", "fixed\n");
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
    setup: [],
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
    gate: async () => {
      events.push("gate");
      const next = gates.shift();
      assert.ok(next, "a gate run the test did not expect");
      return next;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue: unknown, _phase: unknown, fn: () => unknown) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: {
      begin: () => {},
      settle: async () => {},
      check: async (when: string) => {
        asked.push(when);
        await o.check(when);
      },
    },
    ...(o.fixes ? { fixes: o.fixes } : {}),
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
  const attempt = async (at?: Parameters<ReturnType<typeof createPipeline>>[1]) => quietly(() => pipeline(issue, at));
  return { project, events, asked, gates, tampered, attempt };
};

test("a .git change seen after a red gate runs no repair pass and stops the run as the ticket's tampered", async () => {
  const h = harness({
    check: (when) => {
      if (when.startsWith("before repairing")) throw stop(when);
    },
  });
  h.gates.push(RED);
  await assert.rejects(h.attempt(), (error) => error instanceof GuardStop && /STOPPED before repairing #7:/.test(error.message));
  assert.ok(!h.events.includes("repair"), `a repair pass ran: ${h.events.join(", ")}`);
  assert.deepEqual(h.events.filter((e) => e === "gate"), ["gate"]);
  assert.ok(h.tampered.get(ID) instanceof GuardStop);
  assert.match(String((h.tampered.get(ID) as Error).message), /^STOPPED before repairing #7: /);
  assert.ok(h.asked.includes("before repairing #7"), h.asked.join(" | "));

  // The attempt hands this cause to the scheduler, and the closing summary prints the guard's full stop line.
  const error = h.tampered.get(ID) as Error;
  assert.deepEqual(attempted(ID, { status: "rejected", reason: error }, { error }), {
    kind: "crashed", error, causes: [{ kind: "tampered", error }],
  });
  write(h.project.root, ".sandcastle/logs/run.json", JSON.stringify({
    startedAt: "2026-10-07T00:00:00.000Z",
    finishedAt: "2026-10-07T01:00:00.000Z",
    stage: "report", exitCode: 1, pid: 1, tickets: {}, stopped: error.message,
  }));
  const log = render(await gather({ ...h.project, tracker: fakeTracker({ kind: "files" }) }, () => undefined), true);
  assert.ok(log.includes(error.message), log);
});

test("a .git check that passes goes on to the repair pass as before", async () => {
  const h = harness({ check: () => {} });
  h.gates.push(RED, GREEN);
  const { result: o } = await h.attempt();
  assert.ok(h.events.includes("repair"), h.events.join(", "));
  assert.equal(h.asked.filter((w) => w === "before repairing #7").length, 1);
  assert.equal(h.tampered.size, 0);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 1);
});

test("a .git change made while the ticket waited for another's fix runs no repair pass", async () => {
  let changed = false;
  // Another ticket is repairing the same failure; the wait ends with nothing landed, and the host's .git changes meanwhile.
  const fixes = {
    outsideFor: () => undefined,
    fixing: () => ({ by: "8", landed: false }),
    wait: async () => {
      changed = true;
      return false;
    },
    claim: () => {},
    judgedOutside: () => {},
    told: () => {},
  };
  const h = harness({
    fixes,
    check: (when) => {
      if (changed && when.startsWith("before repairing")) throw stop(when);
    },
  });
  h.gates.push(RED);
  await assert.rejects(h.attempt(), (error) => error instanceof GuardStop && /STOPPED before repairing #7:/.test(error.message));
  assert.ok(changed, "the wait did not run");
  assert.ok(!h.events.includes("repair"), `a repair pass ran: ${h.events.join(", ")}`);
  assert.ok(h.tampered.get(ID) instanceof GuardStop);
});

test("a .git change made while the repair waited for a counted sandbox slot runs no repair pass", async () => {
  let changed = false;
  const h = harness({
    check: (when) => {
      if (changed) throw stop(when);
    },
  });
  h.gates.push(RED, GREEN);
  await assert.rejects(h.attempt({
    juncture: async () => {},
    agent: async () => { changed = true; },
  }), (error) => error instanceof GuardStop && /STOPPED before repairing #7:/.test(error.message));
  assert.ok(changed, "the sandbox slot wait did not run");
  assert.ok(!h.events.includes("repair"), `a repair pass ran: ${h.events.join(", ")}`);
  assert.ok(h.tampered.get(ID) instanceof GuardStop);
});
