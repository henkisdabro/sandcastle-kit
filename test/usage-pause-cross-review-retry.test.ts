// A Codex skip ends at the reset and survives a retry that reuses the earlier review.
// CROSS_REVIEW=1 is read at import, so this has a file of its own. The pipeline runs over a temp repo
// with scripted agents and the summary over a made-up run record: no Docker, no model, no network.
//
//   pnpm test:file test/usage-pause-cross-review-retry.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { PlanUsage } from "../mod/hooks/run-record.ts";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.CROSS_REVIEW = "1";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { gather, render } = await import("../src/report.ts");
const { readHeads } = await import("../src/run.ts");
const { crossReviewSkippedWords, createUsagePause } = await import("../src/usage.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-usage-pause-cross-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

const NOW = Math.floor(new Date(2026, 10, 12, 12, 0).getTime() / 1000);
const HOUR = 3600;
const DAY = 24 * HOUR;

/** A reading of both windows, `[percent, resetsAt]` each. */
const reading = (provider: PlanUsage["provider"], five: [number, number], week: [number, number]): PlanUsage => ({
  provider,
  windows: { fiveHour: { percent: five[0], resetsAt: five[1] }, week: { percent: week[0], resetsAt: week[1] } },
  at: NOW,
});

/**
 * One ticket's pipeline over a temp repo, its agents scripted to commit once and say nothing. The usage pause is the
 * real `createUsagePause` over an in-memory control file, fed `usage` as `burndown()` feeds it the newest readings;
 * the pipeline's `crossReviewSkip` port is wired to it as `burndown()` wires it. `threshold` undefined: USAGE_PAUSE is off.
 */
const fixture = (usage: PlanUsage[], threshold: number | undefined) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "shared.txt"), "start\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-q", "-m", "start");
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const passes: string[] = [];
  const phases: string[] = [];
  let gated = GREEN;
  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const name = opts.name ?? "";
        passes.push(name);
        const before = git(path, "rev-parse", "HEAD");
        if (name.startsWith("impl-") && git(path, "rev-list", "--count", "main..HEAD") === "0") {
          writeFileSync(join(path, "seven.txt"), "seven\n");
          git(path, "add", "seven.txt");
          git(path, "commit", "-q", "-m", "change seven.txt");
        }
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };
  const pause = threshold === undefined ? undefined : createUsagePause(threshold, { standing: () => undefined, hold: () => {}, now: () => NOW * 1000, resumed: new Set() });
  pause?.reading(usage);
  const pipeline = createPipeline({
    project: { root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }], generated: [], setup: [], implement: {}, review: {}, repair: {}, changelog: true } as unknown as Ctx["project"],
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-11-12T00:00:00.000Z",
    dryRun: false,
    repair: 0,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => gated,
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, phase, fn) => (phases.push(phase), fn()),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
    ...(pause
      ? {
          crossReviewSkip: () => {
            const spent = pause.crossReviewSpent();
            return spent && crossReviewSkippedWords(spent, new Date(NOW * 1000));
          },
        }
      : {}),
  });
  const issue = { id: "7", title: "seven", body: "" } as Parameters<typeof pipeline>[0];
  return { root, pipeline, issue, passes, phases, gate: (value: GateRun) => { gated = value; }, reading: (value: PlanUsage[]) => pause?.reading(value) };
};

/** The closing summary of a run whose ticket 7 merged with the pipeline's `crossSkipped` in its record. */
const summary = async (crossSkipped: string | undefined) => {
  const root = mkdtempSync(join(TMP, "summary-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ startedAt: "2026-11-12T06:00:00Z", finishedAt: "2026-11-12T07:00:00Z", stage: "report", exitCode: 0, pid: 1, tickets: { "7": { state: "merged", title: "seven", ...(crossSkipped ? { crossSkipped } : {}) } } }),
  );
  const project = { root, baseBranch: "main", tracker: fakeTracker({ kind: "files" }), gates: [] } as any;
  return render(await gather(project, () => undefined), true);
};

test("Codex's cross-review opens at its reset, without Claude's one-minute pause grace", () => {
  for (const window of ["fiveHour", "week"] as const) {
    let now = NOW - 1;
    const pause = createUsagePause(90, { standing: () => undefined, hold: () => assert.fail("Codex never pauses the run"), now: () => now * 1000, resumed: new Set() });
    pause.reading([reading("codex", [window === "fiveHour" ? 98 : 11, NOW], [window === "week" ? 98 : 11, NOW])]);
    assert.equal(pause.crossReviewSpent()?.window, window);
    now = NOW;
    assert.equal(pause.crossReviewSpent(), undefined, `${window} has reset`);
  }
});

test("a retry after red gates keeps the skipped cross-review when it reuses the earlier review", async () => {
  const f = fixture([reading("codex", [98, NOW + HOUR], [11, NOW + DAY])], 90);
  const failure = { name: "test", command: "run-tests", exitCode: 1, output: "a transient failure" };
  f.gate({ gates: [{ name: "test", pass: false }], failure, failures: [failure] });
  const { result: first } = await quietly(() => f.pipeline(f.issue));
  assert.equal(first.status, "gate-failed");
  assert.ok(first.crossSkipped);
  assert.equal(readHeads(f.root)["7"].crossSkipped, first.crossSkipped);

  // The next implementer finds nothing to change; the recorded review covers the same tip.
  f.gate(GREEN);
  f.passes.length = 0;
  const { result: later } = await quietly(() => f.pipeline(f.issue));
  assert.equal(later.status, "green");
  assert.deepEqual(f.passes, ["impl-7"]);
  assert.equal(later.crossSkipped, first.crossSkipped);
  assert.equal(readHeads(f.root)["7"].crossSkipped, first.crossSkipped);
  assert.match(await summary(later.crossSkipped), /^Landed without a cross-review \(Codex plan's limit\): #7$/m);
});

test("a green land-only retry preserves the skip, and a later full cross-review clears it", async () => {
  const f = fixture([reading("codex", [98, NOW + HOUR], [11, NOW + DAY])], 90);
  const { result: first } = await quietly(() => f.pipeline(f.issue));
  assert.equal(first.status, "green");
  assert.ok(first.crossSkipped);
  f.passes.length = 0;
  const { result: carried } = await quietly(() => f.pipeline(f.issue));
  assert.deepEqual(f.passes, []);
  assert.equal(carried.crossSkipped, first.crossSkipped);

  // New work requires a full review. Codex is available now, so the earlier skip no longer applies.
  const path = join(TMP, `wt${n++}`);
  git(f.root, "worktree", "add", "-q", path, "agent/issue-7");
  writeFileSync(join(path, "extra.txt"), "extra\n");
  git(path, "add", "extra.txt");
  git(path, "commit", "-q", "-m", "extra work");
  git(f.root, "worktree", "remove", "--force", path);
  f.reading([reading("codex", [11, NOW + HOUR], [11, NOW + DAY])]);
  const { result: reviewed } = await quietly(() => f.pipeline(f.issue));
  assert.equal(reviewed.status, "green");
  assert.deepEqual(f.passes, ["impl-7", "review-7", "review-codex-7"]);
  assert.equal(reviewed.crossSkipped, undefined);
  assert.equal(readHeads(f.root)["7"].crossSkipped, undefined);
  assert.doesNotMatch(await summary(reviewed.crossSkipped), /Landed without a cross-review/);
});
