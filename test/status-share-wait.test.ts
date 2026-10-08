// The status view when the run waits for a sandbox slot its share of the machine pool holds back. A worker
// leases its slot before it takes a ticket (slot first, src/schedule.ts), so the wait is the run's: the run
// record's `waitsForShare`, and the queued rows next to start say `waits for the run's share` - the slot goes
// to them - while the rows behind them keep their place. An older kit's record carried it as the note of each
// ticket a worker had taken, and still shows. A made-up live run record, a fake `sandcastle` and a `docker`
// that finds nothing; no Docker, no network, no model calls.
//
//   pnpm test:file test/status-share-wait.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { kitLikeProcess } from "./kit-process.ts";

const KIT = join(import.meta.dirname, "..");
const COLS = 100;
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-share-"));
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

const live = kitLikeProcess();
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
const IDS = ["301", "302", "303", "304"];

/** Renders a live run of 2 sandboxes: #301 working, #302 to #304 queued in that order, with `fields` on the record and `notes` on tickets. */
const render = (fields: Record<string, unknown>, notes: Record<string, string> = {}) => {
  writeFileSync(
    join(REPO, ".sandcastle", "logs", "run.json"),
    JSON.stringify({
      orchestrator: "fixture",
      pid: live.pid,
      startedAt: new Date((now - 600) * 1000).toISOString(),
      stage: "running",
      concurrency: 2,
      demand: 2,
      share: 1,
      issues: IDS,
      tickets: {
        301: { state: "implement", since: now - 60, started: now - 60 },
        302: { state: "queued", order: 0, since: now, ...(notes[302] ? { note: notes[302] } : {}) },
        303: { state: "queued", order: 1, since: now },
        304: { state: "queued", order: 2, since: now },
      },
      ...fields,
    }),
  );
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(utf8 ? { LC_ALL: utf8 } : {}),
      PATH: [FAKE, process.env.PATH].join(":"),
      FAKE_QUEUE: IDS.join(" "),
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: String(COLS),
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
  });
  const frame = (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, "");
  return (id: string) => frame.split("\n").find((l) => new RegExp(`^│ +#${id} +│`).test(l)) ?? "";
};

test("a run waiting for its share says so on the rows next to start, and the row behind keeps its place", () => {
  // One of the 2 sandboxes is free, so #302 and #303 are next to start.
  const row = render({ waitsForShare: true });
  assert.match(row("302"), /queued.*waits for the run's share/);
  assert.match(row("303"), /queued.*waits for the run's share/);
  assert.match(row("304"), /queued.*1 ahead of it/);
});

test("a run that waits for no share shows the row next to start as before", () => {
  const row = render({});
  assert.match(row("302"), /queued.*next to start/);
  assert.doesNotMatch(row("302"), /run's share/);
});

test("a paused run's queued rows wait for the resume, whatever the share", () => {
  const row = render({ waitsForShare: true, paused: { since: now - 30, finishing: [] } });
  assert.match(row("302"), /queued.*waits for the resume/);
});

test("an older kit's note on a ticket a worker had taken still shows", () => {
  const row = render({}, { 302: "waits for the run's share" });
  assert.match(row("302"), /queued.*waits for the run's share/);
});
