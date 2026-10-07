// A run whose merged base ended red exits 1 and records `exitCode: 1` (`sandcastle wait` hands that code to a
// harness), at every autonomy level; a green or un-gated base leaves the code alone. burndown() needs Docker,
// so the rule is `redBaseExit`, the record is a child process ending as the run does, and the call site is
// held by a source match. No Docker, model or network.
//
//   pnpm test:file test/red-base-exit.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { KIT, runNode } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { redBaseExit } = await import("../src/autonomy.ts");

const red = { verify: { green: false, line: "test red" } };
const green = { verify: { green: true, line: "all green" } };

test("a red re-gate of the merged base earns exit 1", () => {
  assert.equal(redBaseExit(red), 1);
});

test("a green, skipped or absent re-gate leaves the exit code alone", () => {
  assert.equal(redBaseExit(green), undefined);
  assert.equal(redBaseExit({ verify: null }), undefined);
  assert.equal(redBaseExit({}), undefined);
  assert.equal(redBaseExit(undefined), undefined);
});

test("a run that ends on a red base exits 1 and run.json records exitCode 1", () => {
  const work = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const root = join(work, "project");
  mkdirSync(root);
  const script = join(work, "end-red.ts");
  writeFileSync(
    script,
    [
      `import { recordRun } from ${JSON.stringify(pathToFileURL(join(KIT, "src/run.ts")).href)};`,
      `import { redBaseExit } from ${JSON.stringify(pathToFileURL(join(KIT, "src/autonomy.ts")).href)};`,
      `recordRun({ name: "demo", root: process.argv[2] } as never);`,
      `const code = redBaseExit(JSON.parse(process.argv[3]));`,
      `if (code) process.exitCode = code;`,
    ].join("\n"),
  );
  const ends = (facts: unknown) => {
    const r = runNode([script, root, JSON.stringify(facts)], { encoding: "utf8", env: process.env });
    return { status: r.status, recorded: JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")).exitCode };
  };
  assert.deepEqual(ends(red), { status: 1, recorded: 1 });
  assert.deepEqual(ends(green), { status: 0, recorded: 0 });
});

test("the run command sets the exit code from the last turn's facts after the loop, at any level", () => {
  const cli = readFileSync(join(KIT, "src/cli.ts"), "utf8");
  assert.match(cli, /const redExit = redBaseExit\(lastFacts \?\? \(ranTurn \? await gather\(project\) : undefined\)\);\n\s+if \(redExit\) process\.exitCode = redExit;/);
  // After the drain's closing lines, so they still print with the loop's other output.
  assert.ok(cli.indexOf("const redExit") > cli.indexOf("lateQueueLines(tracker, known"));
});
