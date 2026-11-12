// USAGE_PAUSE and the Codex cross-review: a Codex window at the threshold never pauses the run (the cross-review is
// a second opinion, not a gate). The ticket's pipeline skips the pass instead, says so, and the closing summary lists
// the ticket as landed without one. CROSS_REVIEW=1 is read at import, so this has a file of its own. The pipeline runs
// over a temp repo with scripted agents and the summary over a made-up run record: no Docker, no model, no network.
//
//   pnpm test:file test/usage-pause-cross-review.test.ts

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

// Local noon keeps the same-day case away from midnight, on every timezone and test date.
const NOW = Math.floor(new Date(2026, 10, 12, 12, 0).getTime() / 1000);
const HOUR = 3600;
const DAY = 24 * HOUR;
const pad = (x: number) => String(x).padStart(2, "0");
/** The clock time of a moment as the status view words it, worked out by hand here: HH:MM. */
const clockOf = (seconds: number) => `${pad(new Date(seconds * 1000).getHours())}:${pad(new Date(seconds * 1000).getMinutes())}`;

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
  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
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
        if (name.startsWith("impl-")) {
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
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => GREEN,
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
  return { pipeline, issue, passes, phases };
};

/** The closing summary of a run whose ticket 7 merged with the pipeline's `crossSkipped` in its record. */
const summary = async (crossSkipped: string | undefined) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ startedAt: "2026-11-12T06:00:00Z", finishedAt: "2026-11-12T07:00:00Z", stage: "report", exitCode: 0, pid: 1, tickets: { "7": { state: "merged", title: "seven", ...(crossSkipped ? { crossSkipped } : {}) } } }),
  );
  const project = { root, baseBranch: "main", tracker: fakeTracker({ kind: "files" }), gates: [] } as any;
  return render(await gather(project, () => undefined), true);
};

test("with Codex's 5-hour window at 98%, a ticket's pipeline runs no cross-review, says so, and the summary names the ticket", async () => {
  const reset = NOW + 10;
  const f = fixture([reading("claude", [11, NOW + 2 * HOUR], [11, NOW + 3 * DAY]), reading("codex", [98, reset], [20, NOW + 3 * DAY])], 90);
  const { result: o, lines } = await quietly(() => f.pipeline(f.issue));
  assert.equal(o.status, "green");
  assert.deepEqual(f.passes, ["impl-7", "review-7"], "the Claude passes ran, the Codex one did not");
  assert.ok(!f.phases.includes("cross-review"));
  const line = `#7: cross-review skipped - Codex 5-hour usage 98%, resets ${clockOf(reset)}`;
  assert.ok(lines.includes(line), `printed: ${lines.join(" | ")}`);
  assert.equal(o.crossSkipped, `cross-review skipped - Codex 5-hour usage 98%, resets ${clockOf(reset)}`);
  assert.match(await summary(o.crossSkipped), /^Landed without a cross-review \(Codex plan's limit\): #7$/m);
});

test("with Codex's plan open, the cross-review runs as before and the summary says nothing of it", async () => {
  const f = fixture([reading("claude", [11, NOW + 2 * HOUR], [11, NOW + 3 * DAY]), reading("codex", [89, NOW + 2 * HOUR], [20, NOW + 3 * DAY])], 90);
  const { result: o, lines } = await quietly(() => f.pipeline(f.issue));
  assert.equal(o.status, "green");
  assert.deepEqual(f.passes, ["impl-7", "review-7", "review-codex-7"]);
  assert.equal(o.crossSkipped, undefined);
  assert.ok(!lines.some((l) => l.includes("cross-review skipped")));
  assert.doesNotMatch(await summary(o.crossSkipped), /Landed without a cross-review/);
});

test("without USAGE_PAUSE the cross-review runs whatever Codex's window reads", async () => {
  const f = fixture([reading("codex", [100, NOW + 2 * HOUR], [100, NOW + 3 * DAY])], undefined);
  await quietly(() => f.pipeline(f.issue));
  assert.deepEqual(f.passes, ["impl-7", "review-7", "review-codex-7"]);
});

test("a Codex window that has reset since its reading no longer skips the cross-review", async () => {
  const f = fixture([reading("codex", [98, NOW - HOUR], [20, NOW + 3 * DAY])], 90);
  await quietly(() => f.pipeline(f.issue));
  assert.deepEqual(f.passes, ["impl-7", "review-7", "review-codex-7"]);
});

test("Codex's weekly window spent with its reset on another day prints the weekday form, and the summary names the ticket alone", async () => {
  const reset = NOW + 3 * DAY;
  const f = fixture([reading("claude", [11, NOW + 2 * HOUR], [11, NOW + 3 * DAY]), reading("codex", [30, NOW + 2 * HOUR], [96, reset])], 90);
  const { result: o, lines } = await quietly(() => f.pipeline(f.issue));
  assert.deepEqual(f.passes, ["impl-7", "review-7"]);
  const weekday = new Date(reset * 1000).toLocaleDateString("en-US", { weekday: "short" });
  assert.ok(lines.includes(`#7: cross-review skipped - Codex weekly usage 96%, resets ${weekday} ${clockOf(reset)}`), `printed: ${lines.join(" | ")}`);
  const text = await summary(o.crossSkipped);
  assert.ok(text.split("\n").includes("Landed without a cross-review (Codex plan's limit): #7"));
});

test("burndown() wires the skip: the pipeline's port reads the usage pause, the limit pause is Claude's alone, and the ticket's record keeps the line", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /crossReviewSkip: \(\) => \{\s+const spent = usagePause\.crossReviewSpent\(\);\s+return spent && crossReviewSkippedWords\(spent\);/);
  assert.match(src, /usagePause\.limit\(\[\.\.\.planUsage\], "claude"\)/);
  assert.doesNotMatch(src, /phase === "cross-review" \? "codex"/);
  assert.match(src, /\.\.\.\(value\.crossSkipped \? \{ crossSkipped: value\.crossSkipped \} : \{\}\)/);
});
