// The follow-ups already named from a ticket: shown to its agents so they do not name them again, and met by the
// run's follow-up book when a later run's agent does. A review was never shown the implementer's `<followup>`
// lines, and a later `sandcastle run` knew nothing of what an earlier one filed. A temp repo, a pipeline over
// faked ports (as test/pipeline.test.ts), a fake tracker and a history.jsonl fixture; no Docker, model or network.
//
//   pnpm test:file test/followup-already-named.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { alreadyNamedView, createFollowUpBook, createPipeline, filedBefore } = await import("../src/burndown.ts");
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-already-named-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
};
const commit = (cwd: string, file: string, text: string) => {
  write(cwd, file, text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};

const ID = "7";
const ISSUE = { id: ID, title: "seven", body: "" } as Parameters<ReturnType<typeof createPipeline>>[0];
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const NAMED = "Coverage run fails under the test pool";
const FILED = "Retry count is never reset in src/net/client.ts:40";

/** A history.jsonl as `recordRun` leaves it: one run that filed #41 from ticket 7, one dry run, one line that is no JSON. */
const historyLines = [
  JSON.stringify({ startedAt: "2026-10-01T00:00:00.000Z", followUps: [{ title: FILED, from: "7", phase: "review", id: "41" }, { title: "Never filed", from: "7", phase: "review" }, { title: "Failed", from: "7", phase: "review", failed: "x" }] }),
  JSON.stringify({ startedAt: "2026-10-02T00:00:00.000Z", dryRun: true, followUps: [{ title: "Dry", from: "7", phase: "review", id: "99" }] }),
  "{not json",
  JSON.stringify({ startedAt: "2026-10-03T00:00:00.000Z", followUps: [{ title: "Other ticket's", from: "8", phase: "implement", id: "42" }] }),
];
const withHistory = (root: string, lines = historyLines) => write(root, ".sandcastle/logs/history.jsonl", lines.join("\n") + "\n");

/** The pipeline test's harness, trimmed: a scripted agent per pass, and a follow-up book the test hands in. */
const harness = (opts: { history?: boolean } = {}) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n");
  if (opts.history) withHistory(root);
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}} {{FOLLOWUPS_NAMED}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const passes: { name: string; args: Record<string, string> }[] = [];
  const agents: Record<string, (worktree: string) => string | void> = {};
  const gates: GateRun[] = [];
  const bookRecord: unknown[] = [];
  const book = createFollowUpBook(
    { update: (f) => void bookRecord.push(f) },
    {
      tracker: { ref: (id: string) => `#${id}`, create: () => "100", comment: () => {} },
      dryRun: false,
      write: async (fn) => fn(),
      exists: () => false,
      earlier: filedBefore(root),
    },
  );

  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const box = {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (o: { name?: string; promptArgs?: Record<string, string> }) => {
        const name = o.name ?? "";
        const kind = name.split("-")[0];
        passes.push({ name, args: o.promptArgs ?? {} });
        const before = git(path, "rev-parse", "HEAD");
        const stdout = agents[kind]?.(path) ?? "";
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout, commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    };
    return box as unknown as Box;
  };

  const pipeline = createPipeline({
    project: { root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }], generated: [], setup: [], implement: {}, review: {}, repair: {}, changelog: true } as unknown as Ctx["project"],
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-04T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      const next = gates.shift();
      assert.ok(next, "a gate run the test did not expect");
      return next;
    },
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
    followUps: book,
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });
  const attempt = async () => (await quietly(() => pipeline(ISSUE))).result;
  return { agents, gates, passes, attempt };
};

const implementing = (say: string) => (wt: string) => {
  commit(wt, "a.txt", "a\n");
  return say;
};

test("the review is shown the follow-up the implementer named, and only that ticket's", async () => {
  const h = harness();
  h.agents.impl = implementing(`<followup>${NAMED} - evidence</followup>`);
  h.agents.review = () => "All criteria met.";
  h.gates.push(GREEN);
  await h.attempt();
  const impl = h.passes.find((p) => p.name.startsWith("impl-"));
  const review = h.passes.find((p) => p.name.startsWith("review-"));
  assert.equal(impl?.args.FOLLOWUPS_NAMED, "", "the implementer has not named anything yet");
  assert.ok(review?.args.FOLLOWUPS_NAMED.startsWith("# Follow-ups already named from this ticket\n\n"));
  assert.ok(review?.args.FOLLOWUPS_NAMED.includes(`- ${NAMED} (named by this ticket's implement pass)\n`));
});

test("a review of an implementer that named nothing gets an empty argument", async () => {
  const h = harness();
  h.agents.impl = implementing("Done.");
  h.agents.review = () => "All criteria met.";
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.passes.filter((p) => p.name.startsWith("review-")).map((p) => p.args.FOLLOWUPS_NAMED), [""]);
});

test("the implement pass of a ticket an earlier run filed a follow-up from is shown it with its ref", async () => {
  const h = harness({ history: true });
  h.agents.impl = implementing("Done.");
  h.agents.review = () => "All criteria met.";
  h.gates.push(GREEN);
  await h.attempt();
  const shown = h.passes.find((p) => p.name.startsWith("impl-"))?.args.FOLLOWUPS_NAMED ?? "";
  assert.equal(
    shown,
    "# Follow-ups already named from this ticket\n\n" +
      "These problems outside this ticket are filed already, or will be when this run lands. Do not give a `<followup>` line for any of them again, in any wording; a problem not on this list gets its own line.\n\n" +
      `- #41 ${FILED}\n\n`,
    "neither the unfiled, the failed, the dry run's, nor another ticket's",
  );
  assert.ok(h.passes.find((p) => p.name.startsWith("review-"))?.args.FOLLOWUPS_NAMED.includes("#41"));
});

test("the view lists a filed follow-up with its ref and an unfiled one with the pass that named it", () => {
  assert.equal(alreadyNamedView([], (id) => `#${id}`), "");
  const view = alreadyNamedView([{ title: FILED, id: "41" }, { title: NAMED, phase: "implement" }], (id) => `#${id}`);
  assert.ok(view.endsWith(`- #41 ${FILED}\n- ${NAMED} (named by this ticket's implement pass)\n\n`));
});

test("renderPrompts renders the kit's own templates with the placeholder for the five kinds that name follow-ups", () => {
  const project = { root: TMP, name: "fixture", label: "fixture", gates: [{ name: "test", command: "run-tests" }], tracker: fakeTracker() } as unknown as Parameters<typeof renderPrompts>[0];
  const paths = renderPrompts(project, makeTracker(project));
  for (const kind of ["implement", "review", "rereview", "remerge", "repair"] as const) {
    assert.ok(readFileSync(paths[kind], "utf8").includes("{{FOLLOWUPS_NAMED}}"), `${kind}: the placeholder is left for Sandcastle to fill`);
  }
});

/** A book over a recording tracker, given the filings of an earlier run. */
const bookWith = (earlier: Parameters<typeof createFollowUpBook>[1]["earlier"]) => {
  const made: string[] = [];
  const comments: { id: string; text: string }[] = [];
  const book = createFollowUpBook(
    { update: () => {} },
    {
      tracker: { ref: (id: string) => `#${id}`, create: (title: string) => String(made.push(title) + 100), comment: (id: string, text: string) => void comments.push({ id, text }) },
      dryRun: false,
      write: async (fn) => fn(),
      exists: () => false,
      earlier,
    },
  );
  return { book, made, comments };
};

test("a title an earlier run filed from ticket 7 is a comment on that issue from ticket 7, and a new issue from ticket 8", async () => {
  const { book, made, comments } = bookWith([{ title: "Flaky test", from: "7", phase: "review", id: "41" }]);
  book.push({ title: "Flaky test", evidence: "seen again", from: "7", phase: "implement" });
  assert.deepEqual(await book.file(), [], "nothing new to triage");
  assert.deepEqual(made, []);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "41");
  assert.match(comments[0].text, /Named again by the implement agent working on #7/);

  // Per source ticket, as a repeat within a run is: the same title from ticket 8 was never filed.
  const other = bookWith([{ title: "Flaky test", from: "7", phase: "review", id: "41" }]);
  other.book.push({ title: "Flaky test", evidence: "ticket 8's own", from: "8", phase: "implement" });
  const filed = await other.book.file();
  assert.deepEqual(other.made, ["Flaky test"]);
  assert.equal(filed[0].from, "8");
  assert.deepEqual(other.comments, []);
});

test("the same title is met however the evidence of the repeat places it: history kept no evidence of the filing", async () => {
  const made: string[] = [];
  const comments: string[] = [];
  const book = createFollowUpBook(
    { update: () => {} },
    {
      tracker: { ref: (id: string) => `#${id}`, create: (title: string) => String(made.push(title) + 100), comment: (id: string) => void comments.push(id) },
      dryRun: false,
      write: async (fn) => fn(),
      exists: (path) => path === "src/net/client.ts",
      earlier: [{ title: "Flaky test", from: "7", phase: "review", id: "41" }],
    },
  );
  book.push({ title: "Flaky test", evidence: "src/net/client.ts:12 times out", from: "7", phase: "implement" });
  assert.deepEqual(await book.file(), []);
  assert.deepEqual(made, []);
  assert.deepEqual(comments, ["41"]);
});

test("filedBefore reads the filed follow-ups of the tickets asked for, and none from a project with no history", () => {
  const root = join(TMP, `history${n++}`);
  mkdirSync(root);
  assert.deepEqual(filedBefore(root), []);
  withHistory(root);
  assert.deepEqual(filedBefore(root, new Set(["7"])).map((f) => [f.from, f.id]), [["7", "41"]]);
  assert.deepEqual(filedBefore(root).map((f) => [f.from, f.id]), [["7", "41"], ["8", "42"]]);
});

test("burndown() gives the follow-up book the earlier filings of the tickets it runs, and the passes fill the section", () => {
  // burndown() needs Docker, so no test drives it: its wiring of the helpers tested above is held by its source.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /earlier: filedBefore\(project\.root, new Set\(candidates\.map\(\(c\) => c\.id\)\), \(id\) => tracker\.isClosed\(id\)\)/);
  assert.match(src, /FOLLOWUPS_NAMED: alreadyNamedView\(ctx\.followUps\?\.namedFrom\?\.\(issue\.id\) \?\? \[\], ref\)/);
});
