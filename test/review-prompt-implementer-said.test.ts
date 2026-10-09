// The full review's prompt quotes the last paragraph of the implementer's final message, so a caveat there
// ("I did not check that the new test fails without the change") reaches the reviewer, who would otherwise
// take the tests' word for it. A narrow review is not shown it. The pipeline (`createPipeline`,
// src/burndown.ts) runs over a temp repo with a scripted agent, on the prompts `renderPrompts` really
// writes. No Docker, model, gh or network.
//
//   pnpm test:file test/review-prompt-implementer-said.test.ts

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
// The merges pass process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline, closingParagraphOf, implSaidView } = await import("../src/burndown.ts");
const { readHeads, renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-review-said-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};

const ID = "7";
const ISSUE = { id: ID, title: "seven", body: "" } as Parameters<ReturnType<typeof createPipeline>>[0];
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const RED: GateRun = (() => {
  const failure = { name: "test", command: "run-tests", exitCode: 1, output: "FAIL: first" };
  return { gates: [{ name: "test", pass: false }], failure, failures: [failure] };
})();

const CAVEAT = "I did not check that the wait tests fail without their changes.";
const MESSAGE = `Added the wait report.\n\nChanged src/wait.ts and test/wait.test.ts.\n\n${CAVEAT}\n\n<unmet>Nothing is left.</unmet>\n<changelog>Added: the wait is reported.</changelog>\n<promise>COMPLETE</promise>`;

/** What Sandcastle makes of a prompt file and the arguments a pass gave it: each `{{NAME}}` replaced in one pass. */
const filled = (promptFile: string, args: Record<string, string>) =>
  readFileSync(promptFile, "utf8").replace(/\{\{(\w+)\}\}/g, (whole, key: string) => args[key] ?? whole);

/** A project in a temp repo whose prompts are the kit's own, and a pipeline over it with every port faked. */
const harness = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n");

  const project = {
    root, name: "fixture", label: "ready-for-agent", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }],
    generated: [], setup: [], implement: {}, review: {}, repair: {}, tracker: fakeTracker(), changelog: true,
  };
  const prompts = renderPrompts(project as unknown as Parameters<typeof renderPrompts>[0], makeTracker(project as unknown as Parameters<typeof makeTracker>[0]));

  const passes: { name: string; promptFile: string; args: Record<string, string> }[] = [];
  const agents: Record<string, (worktree: string) => string> = {};
  const gates: GateRun[] = [];
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
      run: async (o: { name?: string; promptFile?: string; promptArgs?: Record<string, string> }) => {
        const name = o.name ?? "";
        passes.push({ name, promptFile: o.promptFile ?? "", args: o.promptArgs ?? {} });
        const before = git(path, "rev-parse", "HEAD");
        const stdout = agents[name.split("-")[0]]?.(path) ?? "";
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout, commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };
  const pipeline = createPipeline({
    project: project as unknown as Ctx["project"],
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-09T00:00:00.000Z",
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
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });
  const attempt = () => quietly(() => pipeline(ISSUE));
  return { root, prompts, passes, agents, gates, attempt };
};

/** An implementer that commits a file, saying `say`. */
const implementing = (say: string) => (wt: string) => {
  commit(wt, "a.txt", "a\n");
  return say;
};

test("the full review's rendered prompt quotes the implementer's closing paragraph, without its tags", async () => {
  const h = harness();
  h.agents.impl = implementing(MESSAGE);
  h.gates.push(GREEN);
  await h.attempt();
  const review = h.passes.find((p) => p.name === `review-${ID}`);
  assert.ok(review, "the full review ran");
  const prompt = filled(review.promptFile, review.args);
  assert.ok(prompt.includes(`> ${CAVEAT}`), `the caveat is quoted:\n${prompt.slice(prompt.indexOf("What the implementer said"))}`);
  assert.doesNotMatch(prompt, /\{\{IMPL_SAID\}\}/);
  assert.ok(!prompt.includes("> Changed src/wait.ts"), "only the last paragraph is passed on");
  assert.doesNotMatch(prompt, /^> .*<(promise|unmet|changelog)>/m, "the kit's own tags are not part of the quote");
});

test("a review of an implementer that said nothing in prose gets an empty IMPL_SAID", async () => {
  const h = harness();
  h.agents.impl = implementing("<promise>COMPLETE</promise>");
  h.gates.push(GREEN);
  await h.attempt();
  const review = h.passes.find((p) => p.name === `review-${ID}`);
  assert.ok(review, "the full review ran");
  assert.equal(review.args.IMPL_SAID, "");
  assert.doesNotMatch(filled(review.promptFile, review.args), /What the implementer said last/);
});

test("the review after a repair is narrow and is not shown the closing paragraph, and the head record keeps it", async () => {
  const h = harness();
  h.agents.impl = implementing(MESSAGE);
  h.agents.repair = (wt) => {
    commit(wt, "fix.txt", "fix\n");
    return "";
  };
  h.gates.push(RED, GREEN);
  await h.attempt();
  const reviews = h.passes.filter((p) => p.name === `review-${ID}`);
  assert.equal(reviews.length, 2, "a full review and the review after the repair");
  assert.match(reviews[0].args.IMPL_SAID, /did not check/);
  assert.ok(!("IMPL_SAID" in reviews[1].args) || reviews[1].args.IMPL_SAID === "", "the narrow review is shown nothing of it");
  assert.doesNotMatch(filled(reviews[1].promptFile, reviews[1].args), /did not check/);
  assert.equal(readHeads(h.root)[ID]?.implSaid, CAVEAT, "land-only and requeued attempts still have it");
});

test("closingParagraphOf takes the last prose paragraph, past tags and fenced blocks", () => {
  assert.equal(closingParagraphOf(MESSAGE), CAVEAT);
  assert.equal(closingParagraphOf("First.\n\nSecond line one\nsecond line two.\n\n```\ncode\n```\n<promise>COMPLETE</promise>"), "Second line one\nsecond line two.");
  assert.equal(closingParagraphOf("<unmet>Left.</unmet>\n<promise>COMPLETE</promise>"), undefined);
  assert.equal(closingParagraphOf(""), undefined);
});

test("implSaidView is empty with no paragraph, and quotes every line of one", () => {
  assert.equal(implSaidView(undefined), "");
  const view = implSaidView("Line one.\nLine two.");
  assert.match(view, /> Line one\.\n> Line two\.\n\n$/);
  assert.match(view, /make that check yourself/);
});
