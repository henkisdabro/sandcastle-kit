// The usage guard in the run settings: the resolver's two fields, the record a turn writes (and
// the reading it says was lost, read back), and the settings row's frames. A stubbed fetch and a
// made-up project with a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm test:file test/usage-guard-settings.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RunRecord } from "../mod/hooks/run-record.ts";
import { plain, readFacts, spawnStatus } from "./status-run.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.USAGE_CHECK = "1";
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");
const { usageLine, usageReadingLost } = await import("../src/usage.ts");
const { recordRun } = await import("../src/run.ts");
const { OperatorError } = await import("../src/errors.ts");
type Project = Parameters<typeof recordRun>[0];

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-usage-guard-settings-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const resolve = (env: Record<string, string | undefined>) => resolveSettings({ env, project: {}, machine: {} });

test("resolver: the guard unset, on with the default threshold, on with a set threshold", () => {
  assert.deepEqual(resolve({}), { autonomy: 0, repair: 1, concurrency: { asked: 4, effective: 4 }, crossReview: { on: false }, usageGuard: false, loadPause: 60, keepWarm: true });
  assert.deepEqual(resolve({ USAGE_CHECK: "0" }), { autonomy: 0, repair: 1, concurrency: { asked: 4, effective: 4 }, crossReview: { on: false }, usageGuard: false, loadPause: 60, keepWarm: true });
  assert.deepEqual(resolve({ USAGE_CHECK: "1" }), { autonomy: 0, repair: 1, concurrency: { asked: 4, effective: 4 }, crossReview: { on: false }, usageGuard: true, usageStop: 90, loadPause: 60, keepWarm: true });
  assert.deepEqual(resolve({ USAGE_CHECK: "1", USAGE_STOP: "" }), { autonomy: 0, repair: 1, concurrency: { asked: 4, effective: 4 }, crossReview: { on: false }, usageGuard: true, usageStop: 90, loadPause: 60, keepWarm: true });
  assert.deepEqual(resolve({ USAGE_CHECK: "1", USAGE_STOP: "75" }), { autonomy: 0, repair: 1, concurrency: { asked: 4, effective: 4 }, crossReview: { on: false }, usageGuard: true, usageStop: 75, loadPause: 60, keepWarm: true });
});

test("resolver: a USAGE_STOP is only read, and so only refused, while the guard is on", () => {
  assert.deepEqual(resolve({ USAGE_STOP: "abc" }), { autonomy: 0, repair: 1, concurrency: { asked: 4, effective: 4 }, crossReview: { on: false }, usageGuard: false, loadPause: 60, keepWarm: true });
  assert.throws(() => resolve({ USAGE_CHECK: "1", USAGE_STOP: "abc" }), OperatorError);
  assert.throws(() => resolve({ USAGE_CHECK: "1", USAGE_STOP: "101" }), OperatorError);
});

test("the settings group carries the guard, its threshold and a lost reading beside them", () => {
  const on = resolve({ USAGE_CHECK: "1" });
  assert.deepEqual(settingsGroup(on, 1), { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4, crossReview: false, usageGuard: true, usageStop: 90, loadPause: 60, keepWarm: true });
  assert.deepEqual(settingsGroup(on, 1, true), { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4, crossReview: false, usageGuard: true, usageStop: 90, usageReading: "unavailable", loadPause: 60, keepWarm: true });
  assert.deepEqual(settingsGroup(resolve({}), 1), { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4, crossReview: false, usageGuard: false, loadPause: 60, keepWarm: true });
  // A guard that is off has no reading to lose.
  assert.deepEqual(settingsGroup(resolve({}), 1, true), { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4, crossReview: false, usageGuard: false, loadPause: 60, keepWarm: true });
});

test("a record written for a guard that lost its reading says so, read back", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-usage-guard-project-"));
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  const project = { root, name: "fixture" } as unknown as Project;
  const read = () => JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")) as RunRecord;
  const settings = resolve({ USAGE_CHECK: "1", USAGE_STOP: "85" });
  const run = recordRun(project, { settings: settingsGroup(settings, 1, usageReadingLost()) });
  assert.deepEqual(read().settings, { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4, crossReview: false, usageGuard: true, usageStop: 85, loadPause: 60, keepWarm: true });
  // A 403: the guard goes off for the run, and the record says it has no reading. The setting is unchanged.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  try {
    await usageLine({ CLAUDE_CODE_OAUTH_TOKEN: "token-403" });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(usageReadingLost(), true);
  run.update({ settings: settingsGroup(settings, 1, usageReadingLost()) });
  assert.deepEqual(read().settings, { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4, crossReview: false, usageGuard: true, usageStop: 85, usageReading: "unavailable", loadPause: 60, keepWarm: true });
});

// The view ----------------------------------------------------------------------------------

const REPO = join(TMP, "repo");
const FAKE = join(TMP, "bin");
const LOGS = join(REPO, ".sandcastle", "logs");
mkdirSync(LOGS, { recursive: true });
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
script(join(FAKE, "sandcastle"), "#!/usr/bin/env bash\nprintf '[]\\n'\n");
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
execFileSync("git", ["-C", REPO, "init", "-q", "-b", "main"]);
execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);

const now = new Date().toISOString();
const record = (settings: unknown) =>
  writeFileSync(join(LOGS, "run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: now, finishedAt: now, exitCode: 0, models: "m", issues: [], settings }));

/** The view's frame at `cols` columns, colour stripped. */
const text = (cols: number): string => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: [FAKE, process.env.PATH].join(":"),
    SANDCASTLE_PROJECT: REPO,
    SANDCASTLE_BIN: join(FAKE, "sandcastle"),
    SANDCASTLE_BASE: "main",
    SANDCASTLE_NAME: "fixture",
    TERM_COLS: String(cols),
    TERM_ROWS: "200",
    XDG_CACHE_HOME: join(TMP, "cache"),
  };
  delete env.SANDCASTLE_SETTINGS;
  const r = spawnStatus(["0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out = plain(r.stdout);
  for (const l of out.split("\n")) assert.ok([...l].length <= cols, `wider than ${cols} columns: ${l}`);
  return out;
};
/** The settings lane's items at `cols` columns (the autonomy scale reduced to the level chosen), joined by ` · `. */
const row = (cols: number): string => (readFacts(text(cols), REPO).settings ?? []).join(" · ");

const base = { autonomy: 0, turn: 1, cap: 1 };

test("on: ● usage-guard with its threshold, whole from 80 columns and begun below", () => {
  record({ ...base, usageGuard: true, usageStop: 90 });
  for (const cols of [80, 100, 130]) assert.match(text(cols), /● usage-guard 90% \(last run\)/, `${cols} columns`);
  for (const cols of [100, 130]) assert.match(row(cols), / · ● usage-guard 90% \(last run\)$/, `${cols} columns`);
  // In a pane this narrow the summary line is cut where the pane ends, but the item has begun.
  assert.match(text(60), /● usage/);
});

test("on with no threshold in the record shows no number", () => {
  record({ ...base, usageGuard: true });
  assert.match(row(100), / · ● usage-guard \(last run\)$/);
});

test("off: ○ usage-guard, from 80 columns", () => {
  record({ ...base, usageGuard: false });
  for (const cols of [80, 100, 130]) assert.match(text(cols), /○ usage-guard \(last run\)/, `${cols} columns`);
});

test("no reading: the warning stays at every width, with the threshold", () => {
  record({ ...base, usageGuard: true, usageStop: 90, usageReading: "unavailable" });
  for (const cols of [100, 130]) assert.match(row(cols), /● usage-guard 90% \(no reading - not guarding\) \(last run\)$/, `${cols} columns`);
  // Narrower, the summary line is cut where the pane ends: the warning is the start of what is left.
  assert.match(text(80), /● usage-guard 90% \(no reading - not guarding\)/);
  assert.match(text(60), /● usage/);
});

test("a record without the guard's fields shows nothing about the guard", () => {
  record(base);
  assert.doesNotMatch(row(100), /usage-guard/);
  assert.equal(row(100), "autonomy [0] (last run)");
  // A reading with no guard field beside it is not drawn on its own, nor with the guard off.
  record({ ...base, usageReading: "unavailable" });
  assert.doesNotMatch(text(100), /usage-guard/);
  record({ ...base, usageGuard: false, usageReading: "unavailable" });
  assert.doesNotMatch(text(100), /no reading/);
});

test("the usage pause: ● usage-pause with its percent beside the guard", () => {
  record({ ...base, usageGuard: false, usagePause: 90 });
  for (const cols of [80, 100, 130]) assert.match(text(cols), /● usage-pause 90% \(last run\)/, `${cols} columns`);
  record({ ...base, usageGuard: false });
  assert.doesNotMatch(text(100), /usage-pause/);
});
