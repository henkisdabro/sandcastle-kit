// The status view's TIME column: a working row shows how long it has been in its state (red at twice
// the step's usual time), a finished row shows its whole length from first start to the end, and a
// queued row shows `-`. A made-up live run record, a fake `sandcastle` and a `docker` that finds
// nothing; no Docker, no network, no model calls.
//
//   node --test test/status-time-column.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-time-"));
const REPO = join(TMP, "my repo");
const FAKE = join(TMP, "bin");
mkdirSync(join(REPO, ".sandcastle", "logs"), { recursive: true });
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
script(join(FAKE, "sandcastle"), `#!/usr/bin/env bash
printf '['; sep=""
for id in $FAKE_QUEUE; do printf '%s{"id":"%s","title":"t","updated":null,"blockedOn":[]}' "$sep" "$id"; sep=","; done
printf ']\\n'
`);
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
execFileSync("git", ["-C", REPO, "init", "-q", "-b", "main"]);
execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base"]);

// A process of the kit as far as status.sh can tell: its command line holds the kit's entry.
const live: ChildProcess = spawn("bash", ["-c", 'exec -a "node src/cli.ts" sleep 600'], { stdio: "ignore" });
after(() => {
  live.kill();
  rmSync(TMP, { recursive: true, force: true });
});

const utf8 = (() => {
  try {
    return execFileSync("locale", ["-a"], { encoding: "utf8" }).split("\n").find((l) => /^(c|en_US)\.utf-?8$/i.test(l));
  } catch {
    return undefined;
  }
})();

const now = Math.floor(Date.now() / 1000);
// The record is written with `since` fixed in the past, so the finished rows' figures hold whatever the clock.
const tickets: Record<string, Record<string, unknown>> = {
  // Finished: since - started is the length, however long ago it ended.
  301: { state: "merged", since: now - 100, started: now - 100 - 3000, note: "merged and closed" },
  302: { state: "held", since: now - 20, started: now - 20 - 4500, note: "human merge: .github/" },
  303: { state: "red", since: now - 20, started: now - 20 - 45, note: "pytest red" },
  // Working: time in the state, not the ticket's age; gates usually take 5 minutes, this one 21.
  304: { state: "gates", since: now - 1300, started: now - 5000, note: "2/3 pytest" },
  305: { state: "gates", since: now - 120, started: now - 5000, note: "2/3 pytest" },
  306: { state: "queued", order: 6, since: now },
};
writeFileSync(
  join(REPO, ".sandcastle", "logs", "run.json"),
  JSON.stringify({
    orchestrator: "fixture",
    pid: live.pid,
    startedAt: new Date((now - 7200) * 1000).toISOString(),
    stage: "running",
    concurrency: 3,
    typical: { gates: 300, issue: 900 },
    issues: Object.keys(tickets),
    tickets,
  }),
);

const render = (cols: string) => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(utf8 ? { LC_ALL: utf8 } : {}),
      PATH: [FAKE, process.env.PATH].join(":"),
      FAKE_QUEUE: "306",
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: cols,
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
  });
  return (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, "");
};
const frame = render("120");
const lineOf = (text: string, id: string) => text.split("\n").find((l) => new RegExp(`^.{0,40}#${id} `).test(l.replace(/\u001b\[[0-9;]*m/g, ""))) ?? "";
const cells = (id: string) => lineOf(frame, id).split("│").map((c) => c.trim());

test("the table's third column is headed TIME, and the legend says what it counts", () => {
  assert.match(frame, /^│ +TICKET +│ +STATE +│ +TIME +│ +COMMITS +│/m);
  assert.doesNotMatch(frame, /\bAGE\b/);
  assert.match(frame, /time = in state; once finished, start to end/);
  assert.match(frame, /red time = past twice the usual/);
});

// A note wider than the frame is cut, and an 81-character one lost what red means in a standard terminal.
test("at 80 columns the legend's notes are whole", () => {
  const narrow = render("80");
  assert.match(narrow, /time = in state; once finished, start to end/);
  assert.match(narrow, /red time = past twice the usual/);
  assert.doesNotMatch(narrow.split("\n").slice(-8).join("\n"), /…/);
});

test("a merged ticket shows its length from start to end, whatever the clock", () => {
  assert.equal(cells("301")[3], "50m");
});

test("a finished ticket over an hour long reads 1h15m", () => {
  assert.equal(cells("302")[3], "1h15m");
});

test("a finished ticket under a minute reads in seconds", () => {
  assert.equal(cells("303")[3], "45s");
});

test("a ticket in gates shows its time in that state, not since its start", () => {
  assert.equal(cells("304")[3], "21m");
  assert.equal(cells("305")[3], "2m");
});

// Colour is off when stdout is not a terminal, so the red is seen by its note: the same twice-the-usual test sets both.
test("a working ticket past twice its step's usual time is flagged, a finished one never is", () => {
  assert.match(lineOf(frame, "304"), /usually 5m/);
  assert.doesNotMatch(lineOf(frame, "305"), /usually/);
  assert.doesNotMatch(lineOf(frame, "301"), /usually/);
});

test("a queued ticket shows -", () => {
  assert.equal(cells("306")[3], "-");
});
