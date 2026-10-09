// A run's start line and record name the kit version, so a log or summary ties to the code that wrote it.
// `versionsLine` is driven directly; burndown() needs Docker, so its side is a source match. No Docker, model or network.
//
//   pnpm test:file test/run-kit-version.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { versionsLine } = await import("../src/versions.ts");

const v = { claude: "2.1.300", codex: "0.160.1", channel: "latest", source: "network" as const };

test("a start line given the kit version leads with it", () => {
  assert.equal(
    versionsLine(v, "0.11.0 +2 (abc1234)"),
    "sandcastle-kit 0.11.0 +2 (abc1234) · Claude Code 2.1.300 (latest) · Codex 0.160.1",
  );
});

test("the line without a kit version is the build command's, unchanged", () => {
  assert.equal(versionsLine(v), "Claude Code 2.1.300 (latest) · Codex 0.160.1");
});

const source = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");

test("burndown reads the kit version once per process, not on each turn", () => {
  assert.equal(source.match(/kitVersion\(\)/g)?.length, 1);
  assert.match(source, /^let kitAtStart: string \| undefined;$/m);
  assert.match(source, /kitAtStart \?\?= kitVersion\(\);/);
});

test("burndown names the kit in the start line and the run record", () => {
  assert.match(source, /versionsLine\(versions, kitAtStart\)/);
  assert.match(source, /versions: \{ kit: kitAtStart, claude: versions\.claude, codex: versions\.codex \}/);
});
