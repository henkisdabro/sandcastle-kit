// A run's start output says each thing once: one warning per ticket for "Blocked by" refs inside
// code (listing them all), and the verify's skip line only in the closing summary.
//
//   pnpm test:file test/start-output-repeats.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { blockerProblems } = await import("../src/blockers.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
const tracker = makeTracker(project);

test("a ticket quoting three Blocked-by refs inside code gets one warning listing them, each once", async () => {
  const body = "Notes:\n\n```\nBlocked by #12\nBlocked by #5\n```\n\nAlso `Blocked by #14` and again `Blocked by #12`.";
  const lines = await blockerProblems(project, tracker, [{ id: "1", body }]);
  assert.deepEqual(lines, ['#1 mentions "Blocked by #12, #5, #14" inside code, which a run does not read - write it as plain text if #1 should wait.']);
});

test("the run does not print the verify's skip line itself: the closing summary carries it", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "burndown.ts"), "utf8");
  assert.ok(!source.includes("verifySkippedLine"), "burndown.ts prints no skip line");
});
