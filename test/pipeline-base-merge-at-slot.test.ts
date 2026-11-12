// A ticket's gates wait for a machine-wide gates slot, minutes at `maxGates: 1`, and the base moves in that wait. Once the slot is
// granted (`GateProgress.onSlot`, awaited by `runGates`) the pipeline checks the branch against the base again and merges the base
// into it again if it moved, before the first gate; a conflict that appeared in the wait ends the attempt `conflict`, found at
// `gates`, with no gate run (the slot is given back). The pipeline (`createPipeline`) runs over faked ports as
// test/pipeline-base-merge-before-gates.test.ts does, whose gate port here "waits" (changes the base) and then calls the hook it is
// handed, as the grant. `runGates` is driven over a made-up sandbox and the pool of test/pool-sim.ts. No Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-base-merge-at-slot.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";
import { cleanup, RUN_ID, slots } from "./pool-sim.ts";
import { quietly } from "./quiet.ts";

// The merges pass process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { runGates } = await import("../src/gates.ts");
type PCtx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type GateRun = import("../src/gates.ts").GateRun;

afterEach(cleanup);

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-base-merge-"));
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

/** A project in a temp repo and a pipeline over it with every port faked; `gated` is each head the gate port was handed. */
const harness = (o: { duringWait?: (root: string) => void } = {}) => {
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
  const gated: { head: string; files: string[] }[] = [];
  /** Whether the gate port was asked for its hook, and what the hook answered. */
  const slot: { answers: boolean[]; hooked: number } = { answers: [], hooked: 0 };
  const agents: Record<string, (worktree: string) => void> = {};

  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const box = {
      worktreePath: path,
      exec: async (cmd: string) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const before = git(path, "rev-parse", "HEAD");
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
    setup: [],
    implement: {},
    review: {},
    repair: {},
  } as unknown as PCtx["project"];
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
    gate: async (box: Box, _id: string, _rerun?: boolean, onSlot?: () => Promise<boolean>) => {
      const wt = (box as unknown as { worktreePath: string }).worktreePath;
      // The wait for the gates slot: the base moves in it. Then the grant.
      o.duringWait?.(root);
      if (onSlot) {
        slot.hooked++;
        const go = await onSlot();
        slot.answers.push(go);
        if (!go) return { gates: [], failures: [] } as GateRun;
      }
      gated.push({ head: git(wt, "rev-parse", "HEAD"), files: git(wt, "ls-files").split("\n") });
      return GREEN;
    },
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
    tampered: new Map(),
  } as unknown as PCtx);
  const attempt = async () => quietly(() => pipeline(issue));

  return { root, agents, gated, slot, attempt };
};


test("a base that gains a commit while the gates wait is merged in at the grant: the gate sees the new tip, and the log says so", async () => {
  const h = harness({ duringWait: (root) => commit(root, "other.txt", "one\n", "another ticket landed during the wait") });
  h.agents.impl = (wt) => commit(wt, "seven.txt", "seven\n");
  const { result: o, lines } = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(h.gated.length, 1);
  const tip = git(h.root, "rev-parse", "main");
  assert.equal(git(h.root, "merge-base", "--is-ancestor", tip, h.gated[0].head) || "", "", "the gated head holds the base tip");
  assert.ok(h.gated[0].files.includes("other.txt") && h.gated[0].files.includes("seven.txt"));
  assert.equal(o.head, h.gated[0].head, "the green head is the merged tip the gates ran on");
  assert.deepEqual(h.slot.answers, [true]);
  assert.ok(lines.includes("#7: merged main into its branch before its gates (1 behind)"), lines.join("\n"));
});

test("a base that gains a conflicting commit while the gates wait ends the attempt in conflict, found at the gates, with no gate run", async () => {
  const h = harness({ duringWait: (root) => commit(root, "shared.txt", "one\n", "another ticket landed over the same line") });
  h.agents.impl = (wt) => commit(wt, "shared.txt", "seven\n");
  const { result: o, lines } = await h.attempt();
  assert.equal(o.status, "conflict");
  assert.equal(o.conflict?.found, "gates");
  assert.deepEqual(o.conflict?.files, ["shared.txt"]);
  assert.deepEqual(o.gates, []);
  assert.equal(h.gated.length, 0, "no gate ran");
  assert.deepEqual(h.slot.answers, [false]);
  assert.equal(o.head, git(h.root, "rev-parse", BRANCH));
  assert.ok(lines.some((l) => l.startsWith("#7: agent/issue-7 no longer merges onto main (") && l.endsWith("- its gates are skipped.")), lines.join("\n"));
});

test("a base that does not move while the gates wait is merged no second time: the branch head is the one the first merge left", async () => {
  const h = harness({
    // The base moved before the pre-wait merge (the implementer's turn), so by the grant the branch holds the tip.
    duringWait: (root) => assert.equal(git(root, "rev-list", "--count", `${BRANCH}..main`), "0", "the first merge left the branch holding the tip"),
  });
  h.agents.impl = (wt) => {
    commit(wt, "seven.txt", "seven\n");
    commit(h.root, "other.txt", "one\n", "another ticket landed");
  };
  const { result: o, lines } = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(git(h.root, "rev-list", "--merges", "--count", BRANCH), "1", "one merge commit, from the pre-wait merge");
  assert.equal(h.gated[0].head, git(h.root, "rev-parse", BRANCH));
  assert.deepEqual(h.slot.answers, [true]);
  assert.equal(lines.filter((l) => l.includes("before its gates")).length, 1, lines.join("\n"));
});

test("a stopped gate run is not a green one: no gates, no failures, where a green run has a result per gate", async () => {
  const project = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }, { name: "unit", command: "run-unit" }] } as Parameters<typeof runGates>[0];
  const ran: string[] = [];
  const sandbox = { exec: async (cmd: string) => (ran.push(cmd), { exitCode: 0, stdout: "", stderr: "" }) };
  const seen: string[] = [];
  const stopped = await runGates(project, sandbox, "fixture gates", false, { onSlot: async () => (seen.push("slot"), false), gate: (_i, name) => seen.push(`gate ${name}`) });
  assert.deepEqual(stopped.gates, []);
  assert.deepEqual(stopped.failures, []);
  assert.equal(stopped.failure, undefined);
  assert.deepEqual(seen, ["slot"], "no gate started");
  assert.ok(!ran.some((c) => c.includes("run-lint") || c.includes("run-unit")), `no gate command ran: ${ran.join(" | ")}`);
  const slotLocks = readdirSync(slots).filter((f) => f.startsWith("gates-") && f.endsWith(".lock") && readFileSync(join(slots, f), "utf8").includes(` run=${RUN_ID} `));
  assert.deepEqual(slotLocks, [], "the gates slot is free again");
  const green = await runGates(project, sandbox, "fixture gates", false, { onSlot: async () => true });
  assert.deepEqual(green.gates.map((g) => g.name), ["lint", "unit"]);
  assert.ok(ran.some((c) => c.includes("run-lint")) && ran.some((c) => c.includes("run-unit")));
  // The same slot is taken again at once: the stop released it.
  const again = await runGates(project, sandbox, "fixture gates", false, { onSlot: () => undefined });
  assert.equal(again.gates.length, 2);
});

test("source: only the first gate run of an attempt passes the hook, and the real port hands it to runGates", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /gate: \(box, id, rerunOnRed, onSlot\) => runGates\(box, id, undefined, false, undefined, rerunOnRed, rerunOnRed, undefined, onSlot\),/);
  assert.equal(src.match(/gate\(sandbox, issue\.id, !!ctx\.regate && repair > 0, async \(\) => \{/g)?.length, 1);
  assert.equal(src.match(/gate\(sandbox, issue\.id\)/g)?.length, 4, "the gate runs after a repair or a fix wait pass no hook");
});
