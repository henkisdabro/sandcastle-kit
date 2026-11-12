// How a run of several turns ended stays in the closing summary after the run: the run record's `drain` is shown in
// the Run section right under the headline, as `sandcastle report` reads it from run.json. A drain shows its `Drain:`
// line; another level shows only a later turn that could not start. No gh, Docker or network.
//
//   pnpm test:file test/report-drain-line.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");

const CAUSE = "turn 2 could not start: the working tree is dirty (GLOSSARY.md)";

/** `sandcastle report`'s text for a run record on disk: turn 1 of a run, finished green, exit 0. */
const report = async (record: object) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({
      startedAt: "2026-10-17T06:00:00Z",
      finishedAt: "2026-10-17T13:00:00Z",
      stage: "report",
      exitCode: 0,
      pid: 1,
      verify: { green: true, line: "all green" },
      tickets: { "5": { state: "merged", title: "a" } },
      ...record,
    }),
  );
  const project = { root, baseBranch: "main", tracker: fakeTracker({ kind: "files" }), gates: [] } as any;
  return render(await gather(project, () => undefined), true);
};

/** The Run section: from its heading to the next. */
const runSection = (text: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("## Run"));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at, next < 0 ? undefined : next);
};

test("a drain whose turn 2 could not start shows its Drain line under the headline", async () => {
  const run = runSection(await report({ settings: { autonomy: "drain", turn: 1 }, drain: { turns: 1, landed: 15, cause: CAUSE } }));
  assert.equal(run[2], `Drain: 1 turn, 15 landed, stopped because ${CAUSE}`);
  // A green base and exit 0: the run finished, it did not end early.
  assert.equal(run[0], "## Run finished");
  assert.doesNotMatch(run.join("\n"), /ended early/);
});

test("a drain stopped for another cause shows that cause", async () => {
  const run = runSection(await report({ settings: { autonomy: "drain", turn: 3 }, drain: { turns: 3, landed: 7, cause: "no ticket is left to run again" } }));
  assert.equal(run[2], "Drain: 3 turns, 7 landed, stopped because no ticket is left to run again");
});

test("at level 2 a refused turn 2 reads as its cause", async () => {
  const run = runSection(await report({ settings: { autonomy: 2, turn: 1 }, drain: { turns: 1, landed: 15, cause: CAUSE } }));
  assert.equal(run[2], "Turn 2 could not start: the working tree is dirty (GLOSSARY.md)");
  assert.doesNotMatch(run.join("\n"), /^Drain:/m);
});

test("a record with no drain, or one of the wrong shape, renders as before", async () => {
  const plain = await report({ settings: { autonomy: "drain", turn: 1 } });
  for (const drain of [{ turns: "1", landed: 15, cause: CAUSE }, { turns: 1, landed: 15 }, "drained", null]) {
    assert.deepEqual(runSection(await report({ settings: { autonomy: "drain", turn: 1 }, drain })), runSection(plain));
  }
  assert.doesNotMatch(plain, /Drain:|could not start/);
  assert.match(runSection(plain)[2], /^Merged main re-gated/);
});
