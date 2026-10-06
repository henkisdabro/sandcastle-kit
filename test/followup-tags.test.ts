// Out-of-scope problems the agents name in `<followup>title - evidence</followup>` lines reach the
// tracker: an agent that left one in the prose of its final message lost it, because nobody reads
// that message. The pipeline reads the lines of every pass, the run files each as a ticket for triage
// through the project's tracker (once per title), and the closing summary lists them under Needs you.
// A dry run files none. A temp repo, scripted agent passes, a fake `gh` first on PATH (plain sh, the
// same on macOS and Linux) and ticket files; no Docker, model or network.
//
//   pnpm exec tsx --test test/followup-tags.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline, fileFollowUps } = await import("../src/burndown.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { renderPrompts } = await import("../src/run.ts");
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type FollowUp = import("../src/burndown.ts").FollowUp;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-followup-"));
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
const repo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n", "start");
  return root;
};

/** One ticket's pipeline over a temp repo, its agent passes answering with `say[kind]`, every gate green. */
const pipelineSaying = async (id: string, say: Record<string, string>) => {
  const root = repo();
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}}\n");
      return [kind, join(root, `.sandcastle/.run/${kind}.md`)];
    }),
  ) as Ctx["prompts"];
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
        const kind = (opts.name ?? "").split("-")[0];
        const before = git(path, "rev-parse", "HEAD");
        if (kind === "impl") commit(path, "work.txt", "work\n");
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: say[kind] ?? "", commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };
  const followUps: FollowUp[] = [];
  const pipeline = createPipeline({
    project: { root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }], generated: [], setup: [], implement: {}, review: {}, repair: {} } as unknown as Ctx["project"],
    tracker: { ref: (t: string) => `#${t}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-05T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => ({ gates: [{ name: "test", pass: true }], failures: [] }),
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, _phase, fn) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    reports: new Map(),
    notes: [],
    followUps,
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });
  const { result } = await quietly(() => pipeline({ id, title: "a ticket", body: "", comments: [] }));
  assert.equal(result.status, "green");
  return followUps;
};

/** A tracker that records each ticket it is asked to create. */
const recording = () => {
  const made: { title: string; body: string; near?: string }[] = [];
  return {
    made,
    tracker: { ref: (id: string) => `#${id}`, create: (title: string, body: string, near?: string) => String(made.push({ title, body, near }) + 100) },
  };
};
const direct = async (fn: () => string) => fn();

const IMPL =
  "Done.\n\n" +
  "<followup>run-shards.sh leaves its background shards running on TERM - test/run-shards.sh:40 traps INT only</followup>\n" +
  "<promise>COMPLETE</promise>\n";
const REVIEW =
  "Reviewed; nothing to change.\n\n" +
  "<followup>full-check.sh Linux leg has no time limit - test/full-check.sh:88 runs docker with no timeout</followup>\n" +
  // The same problem the implementer named: one ticket, not two.
  "<followup>Run-shards.sh leaves its background  shards running on TERM - seen again in review</followup>\n";

test("two sessions' follow-ups become two tickets for triage, each naming its source ticket and phase, a duplicate title filed once", async () => {
  const followUps = await pipelineSaying("7", { impl: IMPL, review: REVIEW });
  const { made, tracker } = recording();
  const filed = await fileFollowUps(tracker, followUps, { dryRun: false, write: direct });
  assert.deepEqual(made.map((m) => m.title), ["run-shards.sh leaves its background shards running on TERM", "full-check.sh Linux leg has no time limit"]);
  assert.match(made[0].body, /test\/run-shards\.sh:40 traps INT only/);
  assert.match(made[0].body, /implement agent working on #7/);
  assert.match(made[1].body, /review agent working on #7/);
  assert.deepEqual(made.map((m) => m.near), ["7", "7"]);
  assert.deepEqual(filed, [
    { title: "run-shards.sh leaves its background shards running on TERM", from: "7", phase: "implement", id: "101" },
    { title: "full-check.sh Linux leg has no time limit", from: "7", phase: "review", id: "102" },
  ]);
});

test("a dry run files no follow-up and returns them for the summary to list", async () => {
  const followUps = await pipelineSaying("8", { impl: IMPL });
  const { made, tracker } = recording();
  const listed = await fileFollowUps(tracker, followUps, { dryRun: true, write: direct });
  assert.equal(made.length, 0);
  assert.deepEqual(listed, [{ title: "run-shards.sh leaves its background shards running on TERM", from: "8", phase: "implement" }]);
});

test("a follow-up named in prose, in a fenced block or as the echoed placeholder is not filed", async () => {
  const followUps = await pipelineSaying("9", {
    impl:
      "I could put it in a <followup>x - y</followup> tag mid-sentence.\n\n```\n<followup>an example - in a fence</followup>\n```\n\n" +
      "<followup>title - one line of evidence</followup>\n<followup>...</followup>\n",
  });
  assert.deepEqual(followUps, []);
});

test("a filing that fails is kept with its reason, and the rest are still filed", async () => {
  let calls = 0;
  const tracker = {
    ref: (id: string) => `#${id}`,
    create: () => {
      if (calls++ === 0) throw new Error("gh issue create failed: HTTP 502");
      return "12";
    },
  };
  const filed = await fileFollowUps(tracker, [
    { title: "first", evidence: "a", from: "1", phase: "review" },
    { title: "second", evidence: "b", from: "1", phase: "repair" },
  ], { dryRun: false, write: direct });
  assert.deepEqual(filed, [
    { title: "first", from: "1", phase: "review", failed: "gh issue create failed: HTTP 502" },
    { title: "second", from: "1", phase: "repair", id: "12" },
  ]);
});

test("a later turn of the same run files no title an earlier turn filed, and retries one whose filing failed", async () => {
  const seen = new Set<string>();
  let down = true;
  const { made, tracker } = recording();
  const flaky = { ...tracker, create: (title: string, body: string, near?: string) => (title === "second" && down ? assert.fail("HTTP 502") : tracker.create(title, body, near)) };
  const named = (title: string) => ({ title, evidence: "e", from: "3", phase: "implement" });
  await fileFollowUps(flaky, [named("first"), named("second")], { dryRun: false, write: direct, seen });
  down = false;
  // The re-run of a partly done ticket names both again.
  const again = await fileFollowUps(flaky, [named("First"), named("second")], { dryRun: false, write: direct, seen });
  assert.deepEqual(made.map((m) => m.title), ["first", "second"]);
  assert.deepEqual(again.map((f) => f.title), ["second"]);
});

test("with ticket files, a follow-up is a committed ticket file beside its source ticket, with the triage status", async () => {
  const root = repo();
  commit(root, ".scratch/checkout/issues/03-pay.md", "# Pay\n\nStatus: ready-for-agent\n\nBody.\n");
  const project = { root, name: "fixture", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker({ kind: "files", dir: ".scratch" }) } as unknown as Project;
  const tracker = makeTracker(project);
  const filed = await fileFollowUps(tracker, [{ title: "Refund rounds down", evidence: "src/pay.ts:12 truncates", from: "checkout-03", phase: "review" }], { dryRun: false, write: direct });
  assert.deepEqual(filed.map((f) => f.id), ["checkout-04"]);
  const file = join(root, ".scratch/checkout/issues/04-refund-rounds-down.md");
  assert.ok(existsSync(file));
  const text = readFileSync(file, "utf8");
  assert.match(text, /^# Refund rounds down\n\nStatus: needs-triage\n/);
  assert.match(text, /src\/pay\.ts:12 truncates/);
  assert.match(text, /review agent working on checkout-03/);
  assert.equal(git(root, "status", "--porcelain"), "", "the ticket file is committed");
  // Not in the queue: a person triages it first.
  assert.deepEqual(tracker.queued().map((t) => t.id), ["checkout-03"]);
});

test("with GitHub, a follow-up is a gh issue carrying the triage label, filed without it when the label is refused", async () => {
  const bin = mkdtempSync(join(TMP, "bin-"));
  const log = join(bin, "calls");
  // Refuses the label once, as a repo with no such label and no right to make one does.
  writeFileSync(
    join(bin, "gh"),
    // One log line per call - "<title> labelled|bare" - however many lines the body has.
    `#!/bin/sh\ncase "$*" in *"--label needs-triage"*) l=labelled ;; *) l=bare ;; esac\necho "$1 $2 $4 $l" >> "${log}"\n` +
      `[ "$l" = labelled ] && [ ! -f "${bin}/refused" ] && { touch "${bin}/refused"; echo "could not add label: 'needs-triage' not found" >&2; exit 1; }\n` +
      `echo "https://github.com/example/repo/issues/57"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    const tracker = makeTracker({ root: TMP, name: "fixture", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project);
    const one = { evidence: "e", from: "7", phase: "implement" };
    const filed = await fileFollowUps(tracker, [{ title: "unlabelled", ...one }, { title: "labelled", ...one }], { dryRun: false, write: direct });
    assert.deepEqual(filed.map((f) => f.id), ["57", "57"]);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(calls, ["issue create unlabelled labelled", "issue create unlabelled bare", "issue create labelled labelled"]);
  } finally {
    process.env.PATH = path;
  }
});

test("the implement, review and repair prompts ask for <followup> lines and no longer for gh issue create", () => {
  const root = repo();
  const project = { root, name: "fixture", baseBranch: "main", label: "ready-for-agent", setup: [], lean: { keep: [], dropHooks: [] }, gates: [{ name: "unit", command: "true" }], hookTests: [], land: "merge", generated: [], implement: {}, review: {}, repair: {}, tracker: fakeTracker() } as unknown as Project;
  const paths = renderPrompts(project, makeTracker(project));
  for (const kind of ["implement", "review", "rereview", "remerge", "repair"] as const) {
    const text = readFileSync(paths[kind], "utf8");
    assert.ok(text.includes("<followup>title - one line of evidence</followup>"), kind);
    assert.ok(!text.includes("gh issue create --label"), kind);
  }
});

/** A project whose run record is `record`, with a fake `gh` that lists `issues` as open triage issues. */
const reported = (record: object, issues: object[] = []) => {
  const root = repo();
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ startedAt: "2026-10-05T06:00:00Z", finishedAt: "2026-10-05T07:00:00Z", pid: 1, tickets: { "7": { state: "merged", title: "seven" } }, ...record }));
  const bin = mkdtempSync(join(TMP, "bin-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n[ "$1 $2" = "issue list" ] && printf '%s\\n' '${JSON.stringify(issues)}'\nexit 0\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return { project: { root, baseBranch: "main", tracker: fakeTracker(), gates: [] } as unknown as Project, bin };
};
const summary = async (record: object, issues: object[] = []) => {
  const { project, bin } = reported(record, issues);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    return render(await gather(project, () => undefined), true);
  } finally {
    process.env.PATH = path;
  }
};
const needsYou = (out: string) => out.slice(out.indexOf("## Needs you"), out.indexOf("##", out.indexOf("## Needs you") + 3));

test("the closing summary lists the filed follow-ups under Needs you as filed for triage, each once", async () => {
  const out = await summary(
    { followUps: [{ title: "run-shards.sh leaves its shards running", from: "7", phase: "implement", id: "57" }] },
    // The kit's own filing is also an open triage issue made during the run: listed once, as a follow-up.
    [{ number: 57, title: "run-shards.sh leaves its shards running", createdAt: "2026-10-05T06:30:00Z" }],
  );
  const lines = needsYou(out).split("\n").filter((l) => l.includes("run-shards.sh"));
  assert.deepEqual(lines, ["- #57 run-shards.sh leaves its shards running - filed for triage from #7 (implement): triage it, then queue or close it"]);
  assert.match(out, / - 1 to triage - /);
});

test("a dry run's summary lists its follow-ups as not filed", async () => {
  const out = await summary({ dryRun: true, followUps: [{ title: "full-check.sh has no time limit", from: "7", phase: "review" }] });
  assert.match(needsYou(out), /- full-check\.sh has no time limit - from #7 \(review\): a real run files it for triage/);
  // Unfiled, but what a real run would leave for triage: the maintainer decided it counts there (test/report-follow-up-counts.test.ts).
  assert.match(out, / - 0 need you - 0 need fixing - 1 to triage - /);
});
