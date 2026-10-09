// The run's other tickets, and what their agents named, shown to every agent pass: a problem another ticket of the
// run covers is that ticket's work, and was filed anyway. A temp repo and a pipeline over faked ports (as
// test/pipeline.test.ts) with one follow-up book shared by the run's tickets; no Docker, model or network.
//
//   pnpm test:file test/followup-run-tickets.test.ts

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
const { createFollowUpBook, createPipeline } = await import("../src/burndown.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-run-tickets-"));
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

const ISSUE = (id: string, title: string) => ({ id, title, body: "" }) as Parameters<ReturnType<typeof createPipeline>>[0];
const SEVEN = ISSUE("7", "Seven: retry the upload");
const EIGHT = ISSUE("8", "Eight: document the upload flags");
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const NAMED = "The upload flags page is stale";

/** The pipeline test's harness, trimmed: a scripted agent per pass, one follow-up book, and `tickets` as the run's. */
const harness = (tickets?: { id: string; title: string }[]) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n");
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
  const book = createFollowUpBook(
    { update: () => {} },
    { tracker: { ref: (id: string) => `#${id}`, create: () => "100", comment: () => {} }, dryRun: false, write: async (fn) => fn(), exists: () => false },
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
    ...(tickets ? { tickets } : {}),
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });
  const attempt = async (issue: typeof SEVEN) => (await quietly(() => pipeline(issue))).result;
  return { agents, gates, passes, attempt };
};

const implementing = (file: string, say: string) => (wt: string) => {
  commit(wt, file, "a\n");
  return say;
};
const shownTo = (h: ReturnType<typeof harness>, prefix: string, at = 0) => h.passes.filter((p) => p.name.startsWith(prefix))[at]?.args.FOLLOWUPS_NAMED ?? "";

test("the implement pass of ticket 7, in a run of 7 and 8, is shown ticket 8's title and not its own", async () => {
  const h = harness([SEVEN, EIGHT]);
  h.agents.impl = implementing("a.txt", "Done.");
  h.agents.review = () => "All criteria met.";
  h.gates.push(GREEN);
  await h.attempt(SEVEN);
  const shown = shownTo(h, "impl-");
  assert.ok(shown.startsWith("# Other tickets in this run\n\n"));
  assert.ok(shown.includes("\n- #8 Eight: document the upload flags\n"));
  assert.ok(!shown.includes("Seven: retry the upload"), "not its own ticket");
  assert.ok(!shown.includes("# Named by other tickets this run"), "nothing has been named yet");
  assert.ok(/a problem one of them covers is that ticket's work/i.test(shown.replace(/\s+/g, " ")));
});

test("a review of ticket 8 that starts after ticket 7's implementer named a follow-up is shown that title", async () => {
  const h = harness([SEVEN, EIGHT]);
  h.agents.impl = implementing("a.txt", `<followup>${NAMED} - evidence</followup>`);
  h.agents.review = () => "All criteria met.";
  h.gates.push(GREEN);
  await h.attempt(SEVEN);
  assert.ok(!shownTo(h, "impl-").includes(NAMED), "ticket 7's own line is not shown to ticket 7 under the other tickets' list");
  h.agents.impl = implementing("b.txt", "Done.");
  h.gates.push(GREEN);
  await h.attempt(EIGHT);
  const shown = shownTo(h, "review-", 1);
  assert.ok(shown.includes("# Named by other tickets this run\n\n"));
  assert.ok(shown.includes(`- ${NAMED} (named by #7's implement pass)\n`));
  assert.ok(shown.includes("\n- #7 Seven: retry the upload\n"));
  assert.ok(!shown.includes("# Follow-ups already named from this ticket"), "none of them is from ticket 8");
});

test("in a run of one ticket with no follow-ups, the lists are left out", async () => {
  const h = harness([SEVEN]);
  h.agents.impl = implementing("a.txt", "Done.");
  h.agents.review = () => "All criteria met.";
  h.gates.push(GREEN);
  await h.attempt(SEVEN);
  assert.deepEqual(h.passes.map((p) => p.args.FOLLOWUPS_NAMED), h.passes.map(() => ""));
  assert.ok(h.passes.length >= 2);
});

test("a pipeline given no tickets shows no list of them", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt", "Done.");
  h.agents.review = () => "All criteria met.";
  h.gates.push(GREEN);
  await h.attempt(SEVEN);
  assert.equal(shownTo(h, "impl-"), "");
});

test("burndown() hands the pipeline the tickets it may run", () => {
  // burndown() needs Docker, so no test drives it: its wiring of the helpers tested above is held by its source.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /followUps,\n\s+tickets: candidates,/);
  assert.match(src, /runTicketsView\(ctx\.tickets\?\.filter\(\(t\) => t\.id !== issue\.id\)/);
});
