// The summary's Settings line names the concurrency the run ran at, and what it asked for when that
// differed. Made-up facts; no Docker, model or network.
//
//   pnpm test:file test/report-settings-concurrency.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { settingsLines } = await import("../src/report.ts");
type Facts = Parameters<typeof settingsLines>[0];

const facts = (settings: Record<string, unknown>): Facts =>
  ({
    base: "main",
    tracker: "github",
    started: "2026-09-30T06:41:00.000Z",
    live: false,
    dryRun: false,
    verify: { green: true, line: "ok" },
    gateCount: 1,
    tickets: {},
    runnable: [],
    blocked: [],
    standing: [],
    keptWorktrees: [],
    changed: {},
    settings,
  }) as Facts;

const base = { autonomy: "drain", turn: 1, cap: 20, crossReview: false, usageGuard: false };

test("the Settings line says the concurrency and what was asked when they differ", () => {
  const [line] = settingsLines(facts({ ...base, concurrency: 2, asked: 4 }), true);
  assert.match(line, /concurrency 2 of 4 asked/);
});

test("the Settings line says only the concurrency when it is what was asked", () => {
  const [line] = settingsLines(facts({ ...base, concurrency: 2, asked: 2 }), true);
  assert.match(line, /concurrency 2/);
  assert.doesNotMatch(line, /asked/);
});

test("the Settings line names no concurrency when the record holds none", () => {
  const [line] = settingsLines(facts(base), true);
  assert.doesNotMatch(line, /concurrency/);
});
