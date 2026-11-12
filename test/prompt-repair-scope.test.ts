// A repair pass that committed used to run the red gate's full command and every other gate, and the orchestrator ran
// every gate again as the pass exited: the project's full suite twice per repair. The prompt now asks for the failing
// tests (the gate's `rerun` command filled with them, `{{GATE_RERUN}}`) and the typecheck gate, and says the orchestrator
// runs every gate after the pass exits. "Find every failure first" stays the one full run. Read as the resolver cases of
// test/prompt-gate-scope.test.ts read theirs. No model calls.
//
//   pnpm test:file test/prompt-repair-scope.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// run.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
const { fillRerun } = await import("../src/gates.ts");

const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "prompts", name), "utf8").replace(/\s+/g, " ");

test("the repair prompt no longer asks for every gate, or the gate command exactly as written, after a commit", () => {
  const p = read("repair.md");
  assert.doesNotMatch(p, /run all of these/);
  assert.doesNotMatch(p, /run `\{\{GATE_COMMAND\}\}` exactly as written/);
  assert.doesNotMatch(p, /then the other gates/);
});

test("the repair prompt asks for the failing tests and the typecheck gate, and says the orchestrator runs every gate", () => {
  const p = read("repair.md");
  assert.match(p, /After a commit, run only these in the repo root and make them pass: - \{\{GATE_RERUN\}\} - the typecheck gate, if the project has one/);
  assert.match(p, /The orchestrator runs every gate after you exit, the full suite included, and a fix that breaks another test is found by that run: do not run the full suite yourself/);
  assert.match(p, /run the checks under "Gates" \(the failing tests and the typecheck gate\), not the whole gate command again: the orchestrator gates the branch right after you exit/);
});

test("the repair prompt's \"Find every failure first\" section is unchanged: one run of the red gate's command without its stop-early option", () => {
  const p = read("repair.md");
  assert.match(
    p,
    /# Find every failure first The output above may show only the first failure: a gate that stops early \(`pytest -x`, `--maxfail`, `--bail`, `--fail-fast`\) hides the rest, and a fix for one test can break another\. Before you change anything, run the red gate's command once without its stop-early option, so you see the whole set, and fix all of them\./,
  );
  assert.match(p, /Gate `\{\{GATE_NAME\}\}` ran `\{\{GATE_COMMAND\}\}` and failed/);
});

test("renderPrompts leaves {{GATE_RERUN}} in the repair prompt for the orchestrator to fill, and in no other", () => {
  const project = { root: mkdtempSync(join(tmpdir(), "sandcastle-repair-scope-")), name: "fixture", label: "fixture", gates: [{ name: "test", command: "run-tests" }], tracker: fakeTracker() } as unknown as Parameters<typeof renderPrompts>[0];
  const paths = renderPrompts(project, makeTracker(project));
  assert.ok(readFileSync(paths.repair, "utf8").includes("{{GATE_RERUN}}"));
  for (const kind of ["implement", "review", "resolve"] as const) assert.ok(!readFileSync(paths[kind], "utf8").includes("{{GATE_RERUN}}"), kind);
});

test("a rerun template is filled with each failing test id quoted, and files for {files}", () => {
  assert.equal(fillRerun("pytest {tests}", [["tests/a.py::t one"], ["tests/b.py::u"]]), "pytest 'tests/a.py::t one' 'tests/b.py::u'");
  assert.equal(fillRerun("pytest {tests}", [["tests/a.py::t"], undefined]), undefined, "an unreadable run fills nothing");
  assert.equal(fillRerun(undefined, [["t"]]), undefined);
});
