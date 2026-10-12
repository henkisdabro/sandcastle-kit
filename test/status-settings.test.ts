// The status view's settings lane (`autonomy [2]`, the active level bracketed) and the turn in the run lane, from a run
// record's settings group or, between runs, the next run's settings the CLI passes in. A made-up
// project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm test:file test/status-settings.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { plain, readFacts, spawnStatus } from "./status-run.ts";

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

/** The facts of the view's frame at `cols` columns, with SANDCASTLE_SETTINGS only when `next` is given. */
const frame = (cols: number, next?: string) => {
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
  const r = spawnStatus(["0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const l of plain(r.stdout).split("\n")) assert.ok([...l].length <= cols, `wider than ${cols} columns: ${l}`);
  return readFacts(r.stdout, REPO);
};
/** The settings lane's items (the autonomy scale reduced to the level chosen), or none when the view draws no lane. */
const items = (cols: number, next?: string) => frame(cols, next).settings ?? [];
/** The turn the run lane shows. */
const turn = (cols: number, next?: string) => frame(cols, next).run.turn;

const group = { autonomy: 3, turn: 2, cap: 3 };

test("the settings lane shows the active autonomy level bracketed, and the run lane the turn, at every width", () => {
  record({ settings: group });
  for (const cols of [80, 99, 100, 130, 200]) {
    assert.deepEqual(items(cols), ["autonomy [3] (last run)"], `${cols} columns`);
    assert.equal(turn(cols), "2/3", `${cols} columns`);
  }
});

test("every level can be the lit one, drain included, and level 1 has a turn with no cap", () => {
  for (const l of ["0", "1", "2", "3", "drain"]) {
    record({ settings: { autonomy: l === "drain" ? l : Number(l), turn: 1 } });
    assert.deepEqual(items(100), [`autonomy [${l}] (last run)`], `level ${l}`);
    assert.equal(turn(100), "1", `level ${l}`);
  }
});

test("a record with no settings group draws no settings and no turn, whatever else it holds", () => {
  for (const extra of [{}, { settings: "junk" }, { settings: {} }]) {
    record(extra);
    assert.deepEqual(items(100), [], JSON.stringify(extra));
    assert.equal(turn(100), undefined, JSON.stringify(extra));
  }
});

test("only what the record holds is shown: no level it lacks, no turn it lacks, no cap it lacks", () => {
  record({ settings: { turn: 2, cap: 3 } });
  assert.deepEqual(items(100), []);
  assert.equal(turn(100), "2/3");
  record({ settings: { autonomy: 2 } });
  assert.deepEqual(items(100), ["autonomy [2] (last run)"]);
  assert.deepEqual(items(80), ["autonomy [2] (last run)"]);
  assert.equal(turn(100), undefined);
  // A level outside the five is a stranger's record: never drawn, never replaced by another.
  record({ settings: { autonomy: 7, turn: 1, cap: 1 } });
  assert.deepEqual(items(100), []);
  assert.equal(turn(100), "1/1");
});

test("idle: the settings `sandcastle status` passes are the next run's, over the last run's record", () => {
  record({ settings: { autonomy: 0, turn: 1, cap: 1 } });
  assert.deepEqual(items(100, JSON.stringify(group)), ["next run: autonomy 3"]);
  assert.equal(turn(100, JSON.stringify(group)), "2/3");
  assert.deepEqual(items(80, JSON.stringify(group)), ["next run: autonomy 3"]);
  // Passed with nothing in them (a bad level): no lane, not the last run's as if it were next.
  assert.deepEqual(items(100, "{}"), []);
  // Not passed (a bare status.sh): the last run's record.
  assert.deepEqual(items(100), ["autonomy [0] (last run)"]);
  assert.equal(turn(100), "1/1");
});

test("idle with no record at all draws no settings, and the next run's settings still show", () => {
  rmSync(join(LOGS, "run.json"), { force: true });
  assert.deepEqual(items(100), []);
  assert.deepEqual(items(100, JSON.stringify(group)), ["next run: autonomy 3"]);
});

test("idle with no record, the next run spending an API key is said in red in the run lane at any width", () => {
  rmSync(join(LOGS, "run.json"), { force: true });
  for (const cols of [60, 80, 100, 200]) assert.equal(frame(cols, JSON.stringify({ ...group, apiKey: true })).run.api, "API credits", `${cols} columns`);
  assert.equal(frame(100, JSON.stringify(group)).run.api, undefined);
});
