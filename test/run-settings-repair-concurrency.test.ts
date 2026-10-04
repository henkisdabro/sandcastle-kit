// The run settings' repair attempts and concurrency (src/run-settings.ts): the resolver's
// sources and the machine cap, the group each turn's record carries, and the status view's row
// for them. A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm exec tsx --test test/run-settings-repair-concurrency.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");
const { OperatorError } = await import("../src/errors.ts");

type Sources = Parameters<typeof resolveSettings>[0];
const resolve = (s: Partial<Sources>) => resolveSettings({ env: {}, project: {}, machine: {}, ...s });

test("repair attempts: the default is 1, 0 turns repair off, and a set value is kept", () => {
  assert.equal(resolve({}).repair, 1);
  assert.equal(resolve({ project: { repair: {} } }).repair, 1);
  assert.equal(resolve({ project: { repair: { attempts: 0 } } }).repair, 0);
  assert.equal(resolve({ project: { repair: { attempts: 3 } } }).repair, 3);
  assert.throws(() => resolve({ project: { repair: { attempts: -1 } } }), OperatorError);
  assert.throws(() => resolve({ project: { repair: { attempts: "many" } } }), OperatorError);
});

test("concurrency: the environment (which `--concurrency` sets) beats the config, which beats the default of 4", () => {
  const table: [string, Partial<Sources>, number][] = [
    ["default", {}, 4],
    ["config", { project: { concurrency: 3 } }, 3],
    ["environment", { env: { CONCURRENCY: "5" } }, 5],
    ["environment over config", { env: { CONCURRENCY: "2" }, project: { concurrency: 5 } }, 2],
  ];
  for (const [name, s, want] of table) assert.deepEqual(resolve(s).concurrency, { asked: want, effective: want }, name);
  assert.throws(() => resolve({ env: { CONCURRENCY: "0" } }), OperatorError);
  assert.throws(() => resolve({ env: { CONCURRENCY: "lots" } }), OperatorError);
});

test("the machine-wide sandbox cap clamps the effective value and leaves the one asked for", () => {
  // The default cap is 6 sandboxes, one kept for landing: 5 pipelines.
  assert.deepEqual(resolve({ env: { CONCURRENCY: "8" } }).concurrency, { asked: 8, effective: 5 });
  assert.deepEqual(resolve({ project: { concurrency: 8 }, machine: { maxSandboxes: 4 } }).concurrency, { asked: 8, effective: 3 });
  assert.deepEqual(resolve({ project: { concurrency: 8 }, env: { SANDCASTLE_MAX_SANDBOXES: "3", CONCURRENCY: "6" }, machine: { maxSandboxes: 9 } }).concurrency, { asked: 6, effective: 2 });
  // Never fewer than one, and a dry run lands nothing so keeps no slot for it.
  assert.equal(resolve({ machine: { maxSandboxes: 1 } }).concurrency.effective, 1);
  assert.deepEqual(resolve({ env: { CONCURRENCY: "8", DRY_RUN: "1" } }).concurrency, { asked: 8, effective: 6 });
  // A cap above the ask is no clamp.
  assert.deepEqual(resolve({ env: { CONCURRENCY: "2" } }).concurrency, { asked: 2, effective: 2 });
});

test("the settings group carries repair, the effective concurrency and the one asked for", () => {
  const group = settingsGroup(resolve({ env: { CONCURRENCY: "8" }, project: { repair: { attempts: 0 } } }), 1);
  assert.equal(group.repair, 0);
  assert.equal(group.concurrency, 5);
  assert.equal(group.asked, 8);
});

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-repair-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
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
const record = (extra: Record<string, unknown>) =>
  writeFileSync(join(LOGS, "run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: now, finishedAt: now, exitCode: 0, models: "m", issues: [], ...extra }));
const frame = (cols: number, next?: string): string[] => {
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
  if (next !== undefined) env.SANDCASTLE_SETTINGS = next;
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(import.meta.dirname, "..", "status.sh"), "0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const lines = r.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  for (const l of lines) assert.ok([...l].length <= cols, `wider than ${cols} columns: ${l}`);
  return lines;
};
const row = (lines: string[]) => lines.find((l) => /^│ settings /.test(l))?.replace(/^│ /, "").replace(/ *│$/, "");

test("the row shows repair attempts and an unclamped concurrency with no (asked)", () => {
  record({ settings: { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4 } });
  assert.equal(row(frame(100)), "settings  autonomy [0] 1 2 3 drain · turn 1/1 · repair 1 · concurrency 4 (last run)");
  assert.equal(row(frame(80)), "settings  autonomy 0 · turn 1/1 · repair 1 · concurrency 4 (last run)");
  // A record from before `asked` has the effective value only.
  record({ settings: { repair: 2, concurrency: 3 } });
  assert.equal(row(frame(100)), "settings  repair 2 · concurrency 3 (last run)");
});

test("a clamped concurrency shows the value asked for", () => {
  record({ settings: { repair: 1, concurrency: 6, asked: 8 } });
  assert.equal(row(frame(100)), "settings  repair 1 · concurrency 6 (asked 8) (last run)");
});

test("repair 0 is a greyed ○ repair, and it drops below 80 columns", () => {
  record({ settings: { repair: 0, concurrency: 4, asked: 4 } });
  assert.equal(row(frame(100)), "settings  ○ repair · concurrency 4 (last run)");
  assert.equal(row(frame(80)), "settings  ○ repair · concurrency 4 (last run)");
  assert.equal(row(frame(79)), "settings  concurrency 4 (last run)");
});

test("idle: the next run's repair and concurrency come from the settings passed in", () => {
  record({ settings: { repair: 1, concurrency: 4, asked: 4 } });
  assert.equal(row(frame(100, JSON.stringify({ repair: 0, concurrency: 5, asked: 8 }))), "settings  next run: ○ repair · concurrency 5 (asked 8)");
});

test("a field the record lacks, or holds as junk, is not drawn", () => {
  record({ settings: { turn: 1, repair: "x", concurrency: -1, asked: 4 } });
  assert.equal(row(frame(100)), "settings  turn 1 (last run)");
});
