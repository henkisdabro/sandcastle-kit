// The status view's settings row: `settings  autonomy 0 1 [2] 3 drain · turn 2/3`, from a run
// record's settings group or, between runs, the next run's settings the CLI passes in. A made-up
// project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   node --test test/status-settings.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-settings-"));
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
/** A finished run's record, so the view draws no live run, with the given extra fields. */
const record = (extra: Record<string, unknown>) =>
  writeFileSync(join(LOGS, "run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: now, finishedAt: now, exitCode: 0, models: "m", issues: [], ...extra }));

/** The view's lines at `cols` columns, colour stripped, with SANDCASTLE_SETTINGS only when `next` is given. */
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
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const lines = r.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  for (const l of lines) assert.ok([...l].length <= cols, `wider than ${cols} columns: ${l}`);
  return lines;
};
/** The settings row's text between the bars, trimmed, or undefined when the view draws none. */
const row = (lines: string[]) => lines.find((l) => /^│ settings /.test(l))?.replace(/^│ /, "").replace(/ *│$/, "");

const group = { autonomy: 3, turn: 2, cap: 3 };

test("the row shows every level with the active one bracketed, and the turn, from 100 columns", () => {
  record({ settings: group });
  for (const cols of [100, 130, 200]) assert.equal(row(frame(cols)), "settings  autonomy 0 1 2 [3] drain · turn 2/3 (last run)", `${cols} columns`);
});

test("below 100 columns only the active level stays", () => {
  record({ settings: group });
  for (const cols of [80, 99]) assert.equal(row(frame(cols)), "settings  autonomy 3 · turn 2/3 (last run)", `${cols} columns`);
});

test("every level can be the lit one, drain included, and level 1 has a turn with no cap", () => {
  const levels = ["0", "1", "2", "3", "drain"];
  for (const l of levels) {
    record({ settings: { autonomy: l === "drain" ? l : Number(l), turn: 1 } });
    const want = levels.map((x) => (x === l ? `[${x}]` : x)).join(" ");
    assert.equal(row(frame(100)), `settings  autonomy ${want} · turn 1 (last run)`, `level ${l}`);
  }
});

test("a record with no settings group draws no row, whatever else it holds", () => {
  record({});
  assert.equal(row(frame(100)), undefined);
  record({ settings: "junk" });
  assert.equal(row(frame(100)), undefined);
  record({ settings: {} });
  assert.equal(row(frame(100)), undefined);
});

test("only what the record holds is shown: no level it lacks, no turn it lacks, no cap it lacks", () => {
  record({ settings: { turn: 2, cap: 3 } });
  assert.equal(row(frame(100)), "settings  turn 2/3 (last run)");
  record({ settings: { autonomy: 2 } });
  assert.equal(row(frame(100)), "settings  autonomy 0 1 [2] 3 drain (last run)");
  assert.equal(row(frame(80)), "settings  autonomy 2 (last run)");
  // A level outside the five is a stranger's record: never drawn, never replaced by another.
  record({ settings: { autonomy: 7, turn: 1, cap: 1 } });
  assert.equal(row(frame(100)), "settings  turn 1/1 (last run)");
});

test("idle: the settings `sandcastle status` passes are the next run's, over the last run's record", () => {
  record({ settings: { autonomy: 0, turn: 1, cap: 1 } });
  assert.equal(row(frame(100, JSON.stringify(group))), "settings  next run: autonomy 0 1 2 [3] drain · turn 2/3");
  assert.equal(row(frame(80, JSON.stringify(group))), "settings  next run: autonomy 3 · turn 2/3");
  // Passed with nothing in them (a bad level): no row, not the last run's as if it were next.
  assert.equal(row(frame(100, "{}")), undefined);
  // Not passed (a bare status.sh): the last run's record.
  assert.equal(row(frame(100)), "settings  autonomy [0] 1 2 3 drain · turn 1/1 (last run)");
});

test("idle with no record at all draws no row, and the next run's settings still show", () => {
  rmSync(join(LOGS, "run.json"), { force: true });
  assert.equal(row(frame(100)), undefined);
  assert.equal(row(frame(100, JSON.stringify(group))), "settings  next run: autonomy 0 1 2 [3] drain · turn 2/3");
});
