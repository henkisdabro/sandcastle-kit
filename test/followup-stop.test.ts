// A run that stops before its end still has its agents' `<followup>` lines: each is written to the run
// record (run.json's `followUps`, no `id`) as its agent's pass ends, so a crash or a safety stop has
// them to list; the stop path files them unless writing to the tracker is unsafe, and then they stay
// in the record as "file it by hand". A normal run files each once. A temp repo, scripted agent
// passes, the real run record and the real scheduler; no Docker, model or network.
//
//   node --test test/followup-stop.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createFollowUpBook, createPipeline } = await import("../src/burndown.ts");
const { recordRun } = await import("../src/run.ts");
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-followup-stop-"));
// recordRun finishes its record in an exit handler, so the temp directory goes after it: registered once the
// first record exists, which puts it behind recordRun's own handler.
let cleanup = false;
const removeAtExit = () => {
  if (cleanup) return;
  cleanup = true;
  process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
};
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

const direct = async (fn: () => string) => fn();

const IMPL = "Done.\n\n<followup>run-shards.sh leaves its background shards running on TERM - test/run-shards.sh:40 traps INT only</followup>\n<promise>COMPLETE</promise>\n";
// The implementer's problem again, reworded, and a second one.
const REVIEW =
  "Reviewed.\n\n<followup>Run-shards.sh leaves its background  shards running on TERM - seen again in review</followup>\n" +
  "<followup>full-check.sh Linux leg has no time limit - test/full-check.sh:88 runs docker with no timeout</followup>\n";
const SHARDS = "run-shards.sh leaves its background shards running on TERM";
const LIMIT = "full-check.sh Linux leg has no time limit";

/**
 * A project with a real run record, the follow-up book burndown() makes over it (a tracker that numbers
 * what it is asked to create from 101, `made` its titles, unless `create` is given), and one ticket's
 * pipeline over a temp repo, its agent passes answering with `say[kind]`, every gate green.
 */
const run = (o: { dryRun?: boolean; seen?: Set<string>; create?: () => string } = {}) => {
  const root = repo();
  const project = { root, name: "fixture", baseBranch: "main", label: "ready-for-agent", gates: [{ name: "test", command: "run-tests" }], tracker: fakeTracker() } as unknown as Project;
  const record = recordRun(project);
  removeAtExit();
  const recorded = (): { title: string; from: string; phase: string; id?: string; failed?: string }[] =>
    JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")).followUps ?? [];
  const made: string[] = [];
  const tracker = { ref: (id: string) => `#${id}`, comment: () => {}, create: o.create ?? ((title: string) => String(made.push(title) + 100)) };
  const book = createFollowUpBook(record, { tracker, dryRun: o.dryRun ?? false, write: direct, seen: o.seen ?? new Set() });
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}}\n");
      return [kind, join(root, `.sandcastle/.run/${kind}.md`)];
    }),
  ) as Ctx["prompts"];
  const open = async (branch: string, say: Record<string, string>): Promise<Box> => {
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
  /** One ticket's pipeline, which hands each follow-up its agents say to the book. */
  const pipelineSaying = async (id: string, say: Record<string, string>) => {
    const pipeline = createPipeline({
      project: { ...project, setup: [], generated: [], implement: {}, review: {}, repair: {} } as unknown as Ctx["project"],
      tracker: { ref: (t: string) => `#${t}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
      runId: "2026-10-05T00:00:00.000Z",
      dryRun: false,
      repair: 1,
      testRedGate: false,
      prompts,
      overrides: new Map(),
      open: (branch) => open(branch, say),
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
      followUps: book,
      took: new Map(),
      keptWorktrees: [],
      tampered: new Map(),
    });
    const { result } = await quietly(() => pipeline({ id, title: "a ticket", body: "", comments: [] }));
    assert.equal(result.status, "green");
  };
  return { project, record, book, recorded, made, pipelineSaying };
};

const summary = async (project: Project) => render(await gather(project, () => undefined), true);
const needsYou = (out: string) => out.slice(out.indexOf("## Needs you"), out.indexOf("##", out.indexOf("## Needs you") + 3));

test("a follow-up is in the run record, unfiled, as soon as the agent's pass has ended - before the run files anything", async () => {
  const { pipelineSaying, recorded, made } = run();
  await pipelineSaying("7", { impl: IMPL, review: REVIEW });
  // Two problems: the reworded one is not a third.
  assert.deepEqual(recorded(), [
    { title: SHARDS, from: "7", phase: "implement" },
    { title: LIMIT, from: "7", phase: "review" },
  ]);
  assert.deepEqual(made, []);
});

test("a schedule that rejects after an agent named a follow-up leaves it in the run record; a stop where writing is unsafe lists it to file by hand", async () => {
  const { project, record, book, pipelineSaying, recorded, made } = run();
  // The scheduler rejects only when one of its workers throws, which is a bug in the kit and not something a port can
  // cause (it keeps a throwing attempt, land or tell to that ticket): this one stands in for it, rejecting once
  // ticket 7's pipeline has ended and its follow-up has arrived.
  const schedule = {
    run: async () => {
      await pipelineSaying("7", { impl: IMPL });
      throw new Error("the ledger could not write");
    },
  };
  const { result: error } = await quietly(() => schedule.run().then(() => undefined, (e: unknown) => e as Error));
  assert.match(String(error?.message), /the ledger could not write/);
  assert.deepEqual(recorded(), [{ title: SHARDS, from: "7", phase: "implement" }], "in run.json before anything has filed it");
  // The stop path, where the shared .git changed: nothing is written to the tracker.
  const { result: kept } = await quietly(() => book.file("the shared .git changed"));
  assert.deepEqual(made, []);
  assert.deepEqual(kept, [{ title: SHARDS, from: "7", phase: "implement", failed: "the shared .git changed" }]);
  assert.deepEqual(recorded(), kept);
  record.update({ stopped: "the shared .git changed" });
  const lines = needsYou(await summary(project)).split("\n").filter((l) => l.includes(SHARDS));
  assert.deepEqual(lines, [`- ${SHARDS} - from #7 (implement): filing it for triage failed (the shared .git changed) - file it by hand`]);
});

test("a crash where writing is safe files the follow-ups before the summary, which lists them as filed", async () => {
  const { project, record, book, pipelineSaying, recorded, made } = run();
  await pipelineSaying("7", { impl: IMPL, review: REVIEW });
  await quietly(() => book.file());
  assert.deepEqual(made, [SHARDS, LIMIT]);
  assert.deepEqual(recorded(), [
    { title: SHARDS, from: "7", phase: "implement", id: "101" },
    { title: LIMIT, from: "7", phase: "review", id: "102" },
  ]);
  record.update({ stopped: "the ledger could not write" });
  const lines = needsYou(await summary(project)).split("\n").filter((l) => l.includes("filed for triage"));
  assert.deepEqual(lines, [
    `- #101 ${SHARDS} - filed for triage from #7 (implement): triage it, then queue or close it`,
    `- #102 ${LIMIT} - filed for triage from #7 (review): triage it, then queue or close it`,
  ]);
});

test("a normal run files each follow-up once: filing again, after a stop's filing or the notes, makes no second ticket", async () => {
  const { book, pipelineSaying, recorded, made } = run();
  await pipelineSaying("7", { impl: IMPL, review: REVIEW });
  const first = await book.file();
  const second = await book.file();
  assert.deepEqual(made, [SHARDS, LIMIT]);
  assert.deepEqual(first.map((f) => f.id), ["101", "102"]);
  assert.deepEqual(second, []);
  assert.deepEqual(recorded().map((f) => f.id), ["101", "102"]);
});

test("a title an earlier turn of the run filed is not listed or filed again", async () => {
  const { book, pipelineSaying, recorded, made } = run({ seen: new Set([SHARDS.toLowerCase()]) });
  await pipelineSaying("7", { impl: IMPL, review: REVIEW });
  assert.deepEqual(recorded(), [{ title: LIMIT, from: "7", phase: "review" }]);
  await book.file();
  assert.deepEqual(made, [LIMIT]);
});

test("a dry run keeps its follow-ups unfiled in the record, and a stop files nothing for it either", async () => {
  const { book, pipelineSaying, recorded, made } = run({ dryRun: true });
  await pipelineSaying("7", { impl: IMPL });
  const { result: listed } = await quietly(() => book.file("the shared .git changed"));
  assert.deepEqual(listed, [{ title: SHARDS, from: "7", phase: "implement" }]);
  assert.deepEqual(recorded(), [{ title: SHARDS, from: "7", phase: "implement" }]);
  assert.deepEqual(made, []);
});

test("a filing that fails keeps its reason in the record, and a later filing does not try it again", async () => {
  let calls = 0;
  const { book, pipelineSaying, recorded } = run({
    create: () => {
      calls++;
      throw new Error("gh issue create failed: HTTP 502");
    },
  });
  await pipelineSaying("7", { impl: IMPL });
  await book.file();
  assert.deepEqual(recorded(), [{ title: SHARDS, from: "7", phase: "implement", failed: "gh issue create failed: HTTP 502" }]);
  assert.deepEqual(await book.file(), []);
  assert.equal(calls, 1);
});

// burndown() needs Docker, so no test drives it: both of its stops are held to filing the follow-ups by its source.
test("burndown files the follow-ups before the summary on both of its stops, and writes none to the tracker after a safety stop", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const stop = src.slice(src.indexOf("const stopLanding = "), src.indexOf("const { endings, stop } = await schedule"));
  assert.ok(stop.includes("await fileTheFollowUps("), "stopLanding files them");
  assert.ok(stop.indexOf("await fileTheFollowUps(") < stop.indexOf("closingReport"), "before the summary reads the record");
  // Named by what moved, not "the shared .git changed" when only the base branch moved.
  assert.match(stop, /safety \? `\$\{guardWords\(error\)\.what\}, so nothing more was written to the tracker` : undefined/, "a safety stop gives the reason it writes nothing");
  const after = src.slice(src.indexOf("const { endings, stop } = await schedule"));
  assert.match(after, /return stopLanding\(error, host\.failed !== undefined\)/, "a crash of the schedule");
  assert.match(after, /await stopLanding\(stopError\(headline\), true\)/, "a safety stop after the pipelines");
  assert.match(after, /await stopLanding\(stopError\(stop\.headline!\), true\)/, "a safety stop at a note");
  assert.match(after, /\n {2}await fileTheFollowUps\(\);/, "the end of a run that did not stop");
});
