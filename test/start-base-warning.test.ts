// The run's start output tells the operator the base branch is the run's until it ends: a commit
// on it mid-run stops the run. burndown() needs Docker, so the line is read from its source (as
// start-output-order.test.ts does) and the text is the helper's.
//
//   pnpm test:file test/start-base-warning.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { baseIsTheRunsLine } = await import("../src/run.ts");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the start line names the base and says a commit, pull or merge on it stops the run", () => {
  const line = baseIsTheRunsLine("trunk");
  assert.match(line, /Do not commit, pull or merge on trunk in this checkout until the run ends/);
  assert.match(line, /another worktree/);
  assert.match(line, /stops the run/);
  // Another worktree shares .git/config: an upstream for its own branch is let through (the guard
  // compares by key), and the line says what still stops the run.
  assert.match(line, /Worktrees share \.git\/config: an upstream for your own branch there .* is fine, but any other change to it stops the run/);
  assert.match(line, /upstream on trunk or an agent\/issue-\* branch/);
});

test("a run prints that line, for its own base branch, after the keep-awake line", () => {
  const src = read("../src/burndown.ts");
  const awake = src.indexOf("Keep awake: ${await keepAwake()}");
  const said = src.indexOf("console.log(baseIsTheRunsLine(project.baseBranch));");
  assert.ok(awake > 0 && said > awake);
});

test("skill/run.md and the README's safety model say the same", () => {
  const run = read("../skill/run.md");
  assert.match(run, /commits, pulls or merges on the base/);
  assert.match(run, /sandcastle status/);
  assert.match(read("../README.md"), /cannot tell a person's commit on the base from a sandbox's/);
});
