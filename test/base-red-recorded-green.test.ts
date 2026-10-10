// A ticket's red gate is not run on the base when the green-base record already holds the base's tip, and a base run
// that does happen leaves a timings line, through the pipeline and fakes of test/base-red-harness.ts and the timing
// helper's own file, and the record's answer from a temp repo. No Docker, model, gh or network.
//
//   pnpm test:file test/base-red-recorded-green.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commit, CLOCK, git, GREEN, harness } from "./base-red-harness.ts";

const { BASE_RED, baseRecordedGreen, noteGreenCommit, timedGate } = await import("../src/gates.ts");
type Project = import("../src/config.ts").Project;

test("a red on a base tip the green-base record holds goes to its repair with no gate run on the base", async () => {
  const h = harness(() => [CLOCK, GREEN], CLOCK, () => true);
  h.agents.repair = (id, wt) => commit(wt, `src/fix-${id}.ts`, "fix\n");
  const o = await h.attempt("1");
  assert.deepEqual(h.baseRuns, []);
  assert.deepEqual(h.repairs, ["1"]);
  assert.equal(o.status, "green");
  assert.deepEqual(h.toldRed, []);
});

test("a red on a base tip the record does not hold still runs the gates on the base", async () => {
  const h = harness(() => [CLOCK], CLOCK, () => false);
  const o = await h.attempt("1");
  assert.equal(h.baseRuns.length, 1);
  assert.deepEqual(h.repairs, []);
  assert.equal(o.status, "gate-failed");
  assert.deepEqual(h.toldRed, [["test/clock.test.ts"]]);
});

test("a base run a ticket's red asked for leaves a base-red line with the slot wait out of its time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-base-red-line-"));
  try {
    const timings = join(dir, "timings.jsonl");
    await timedGate(BASE_RED, timings, { run: "r1", project: "fixture", issue: "7", carried: true }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { ...CLOCK, waitMs: 40 };
    });
    const [line] = readFileSync(timings, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(line.phase, "base-red");
    assert.equal(line.issue, "7");
    assert.equal(line.run, "r1");
    assert.equal(line.ok, false);
    assert.equal(line.carried, true);
    assert.equal(line.waitMs, 40);
    assert.deepEqual(line.red, ["test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the run gives the pipeline the record's answer and times the base run under its ticket", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /baseRecordedGreen: \(\) => baseRecordedGreen\(gateProject, image, planFile\)/);
  assert.match(src, /timedGate\(BASE_RED, timings, \{ run: runId, project: project\.name, issue: id/);
});

test("the green-base record holds the base's tip whatever its proof's kind, and no longer once the base moves on", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-base-recorded-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Operator Example");
    git(root, "config", "user.email", "operator@example.com");
    git(root, "config", "commit.gpgsign", "false");
    commit(root, "a.txt", "a\n");
    mkdirSync(join(root, ".sandcastle"));
    const plan = join(root, ".sandcastle/plan.json");
    writeFileSync(plan, "{}\n");
    const project = { root, name: "fixture", baseBranch: "main", setup: [], gates: [{ name: "test", command: "run-tests" }] } as unknown as Project;
    assert.equal(baseRecordedGreen(project, "img:1", plan), false);
    noteGreenCommit(project, "img:1", plan, git(root, "rev-parse", "main"), "3", "ticket-sandbox");
    assert.equal(baseRecordedGreen(project, "img:1", plan), true);
    // Another image is another key: its gates never ran on this tip.
    assert.equal(baseRecordedGreen(project, "img:2", plan), false);
    commit(root, "b.txt", "b\n");
    assert.equal(baseRecordedGreen(project, "img:1", plan), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
