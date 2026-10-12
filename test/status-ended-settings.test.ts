// An ended run's status view: the settings are the next run's, so the whole lane is prefixed
// `next run:` and never reads as the settings the closing summary recorded for the run that ended.
// A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm test:file test/status-ended-settings.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { plain, readFacts, spawnStatus } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-ended-"));
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
// The ended run drained its queue: its record says so, and the next run would start at level 0.
writeFileSync(
  join(LOGS, "run.json"),
  JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: now, finishedAt: now, exitCode: 0, models: "m", issues: [], settings: { autonomy: "drain", turn: 1, cap: 20 } }),
);

/** The settings lane's items (the autonomy scale reduced to the level chosen) at `cols` columns. */
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
  const r = spawnStatus(["0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const l of plain(r.stdout).split("\n")) assert.ok([...l].length <= cols, `wider than ${cols} columns: ${l}`);
  return readFacts(r.stdout, REPO).settings ?? [];
};
test("an ended run's settings for the next run are prefixed, with no mark at their end", () => {
  const next = JSON.stringify({ autonomy: 0, turn: 1, cap: 1 });
  for (const cols of [60, 80, 100, 140]) {
    const items = frame(cols, next);
    assert.equal(items.length, 1, `${cols} columns`);
    assert.match(items[0]!, /^next run: autonomy /, `${cols} columns`);
    assert.doesNotMatch(items[0]!, /\((next|last) run\)/, `${cols} columns`);
  }
});

test("settings spread over several rows carry the prefix once, on the first", () => {
  const items = frame(240, JSON.stringify({ autonomy: 0, turn: 1, cap: 1, repair: 2, concurrency: 4, crossReview: true, crossReviewModel: "gpt-6-astra", crossReviewEffort: "high", usageGuard: true, usageStop: 90 }));
  assert.match(items[0] ?? "", /^next run: /);
  assert.match(items.at(-1) ?? "", /usage-guard 90%/);
  assert.equal(items.join("\n").match(/next run:/g)?.length, 1);
});

test("the ended run's own recorded settings keep the suffix mark, never the prefix", () => {
  const items = frame(100);
  assert.equal(items.length, 1);
  assert.match(items[0]!, /drain.*\(last run\)/);
  assert.doesNotMatch(items[0]!, /next run:/);
});
