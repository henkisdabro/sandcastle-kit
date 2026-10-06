// An ended run's status view: the settings row is the next run's, so the whole row is prefixed
// `next run:` and never reads as the settings the closing summary recorded for the run that ended.
// A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   node --test test/status-ended-settings.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
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
// The settings row and the lines it wrapped onto, which carry no label: up to the cell's border.
const settingsLines = (lines: string[]) => {
  const at = lines.findIndex((l) => /^│ settings /.test(l));
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && !/^│ {11}\S/.test(l));
  return lines.slice(at, end < 0 ? undefined : end);
};

test("an ended run's row for the next run is prefixed, with no mark at its end", () => {
  const next = JSON.stringify({ autonomy: 0, turn: 1, cap: 1 });
  for (const cols of [60, 80, 100, 140]) {
    const rows = settingsLines(frame(cols, next));
    assert.equal(rows.length, 1, `${cols} columns`);
    assert.match(rows[0], /^│ settings {2}next run: autonomy /, `${cols} columns`);
    assert.doesNotMatch(rows[0], /\((next|last) run\)/, `${cols} columns`);
  }
});

test("a row wrapped over several lines carries the prefix once, on the first", () => {
  const rows = settingsLines(frame(80, JSON.stringify({ autonomy: 0, turn: 1, cap: 1, repair: 2, concurrency: 4, crossReview: true, crossReviewModel: "gpt-6-astra", crossReviewEffort: "high", usageGuard: true, usageStop: 90 })));
  assert.ok(rows.length > 1, `the row did not wrap:\n${rows.join("\n")}`);
  assert.match(rows[0], /^│ settings {2}next run: /);
  assert.match(rows.at(-1) ?? "", /usage-guard 90%/);
  const text = rows.join("\n");
  assert.equal(text.match(/next run:/g)?.length, 1);
});

test("the ended run's own recorded settings keep the suffix mark, never the prefix", () => {
  const rows = settingsLines(frame(100));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /\[drain\].*\(last run\)/);
  assert.doesNotMatch(rows[0], /next run:/);
});
