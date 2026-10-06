// The settings group's `concurrency` is for the settings row only: the view's free-slot and ETA
// maths keep reading the record's top-level `concurrency` (the sandboxes at once, after the ticket
// count), so a record that gains the group draws its tickets and its end time as before.
//
//   node --test test/run-settings-concurrency-eta.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { kitLikeProcess } from "./kit-process.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-eta-"));
const live = kitLikeProcess();
after(() => {
  live.kill();
  rmSync(TMP, { recursive: true, force: true });
});
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

const now = Math.floor(Date.now() / 1000);
// One sandbox at once and one ticket in it: the second queued ticket is behind the first, and the
// end is three typical tickets away. Read as 6, the settings' value, both would be wrong.
const record = (settings?: Record<string, unknown>) =>
  writeFileSync(
    join(LOGS, "run.json"),
    JSON.stringify({
      orchestrator: "fixture",
      pid: live.pid,
      startedAt: new Date((now - 60) * 1000).toISOString(),
      models: "m",
      stage: "running",
      concurrency: 1,
      typical: { issue: 600 },
      issues: ["1", "2", "3"],
      tickets: {
        "1": { state: "implement", since: now, started: now },
        "2": { state: "queued", order: 2, since: now },
        "3": { state: "queued", order: 3, since: now },
      },
      ...(settings ? { settings } : {}),
    }),
  );
const frame = (): string[] => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: [FAKE, process.env.PATH].join(":"),
    SANDCASTLE_PROJECT: REPO,
    SANDCASTLE_BIN: join(FAKE, "sandcastle"),
    SANDCASTLE_BASE: "main",
    SANDCASTLE_NAME: "fixture",
    TERM_COLS: "120",
    TERM_ROWS: "200",
    XDG_CACHE_HOME: join(TMP, "cache"),
  };
  delete env.SANDCASTLE_SETTINGS;
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(import.meta.dirname, "..", "status.sh"), "0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
};
const line = (lines: string[], re: RegExp) => lines.find((l) => re.test(l)) ?? "(missing)";
// The parts the free-slot and ETA maths draw.
const figures = (lines: string[]) => [line(lines, /^│ +#2 +│/), line(lines, /^│ +#3 +│/), line(lines, /\bends +~/)];

test("a settings group's concurrency leaves the free-slot and ETA figures as the top-level value draws them", () => {
  record();
  let before = frame();
  record({ autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 6, asked: 8 });
  let withGroup = frame();
  // The end time is "now" plus a fixed span: renders either side of a minute boundary differ, so once more.
  if (figures(before)[2] !== figures(withGroup)[2]) {
    record();
    before = frame();
    record({ autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 6, asked: 8 });
    withGroup = frame();
  }
  assert.match(line(withGroup, /^│ settings /), /concurrency 6 \(asked 8\)/);
  assert.match(figures(before)[0], /next to start/);
  assert.match(figures(before)[1], /1 ahead of it/);
  assert.match(figures(before)[2], /ends +~\d\d:\d\d/);
  assert.deepEqual(figures(withGroup), figures(before));
});
