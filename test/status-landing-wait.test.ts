// The status view when the run's wait for a sandbox slot is held back by the slot kept for landing, not by
// its share: the run record's `waitsFor: "landing"` (beside the older `waitsForShare` boolean), and the rows
// next to start say `waits: slot kept to land`. A record with `waitsFor: "share"`, or only the older
// boolean, still says `waits for the run's share`. A made-up live run record, a fake `sandcastle` and a
// `docker` that finds nothing; no Docker, no network, no model calls. Also `createSlotWaits`, which writes it.
// Drawn at 100 columns, where the activity cell is 26 characters wide: the words fit whole, as `waits for the run's share` does.
//
//   pnpm test:file test/status-landing-wait.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { kitLikeProcess } from "./kit-process.ts";

const { createSlotWaits } = await import("../src/burndown.ts");

const KIT = join(import.meta.dirname, "..");
const COLS = 100;
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-landing-"));
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

/** Renders a live run of 2 sandboxes: #301 working, #302 to #304 queued in that order, with `fields` on the record. */
const render = (fields: Record<string, unknown>) => {
  writeFileSync(
    join(REPO, ".sandcastle", "logs", "run.json"),
    JSON.stringify({
      orchestrator: "fixture",
      pid: live.pid,
      startedAt: new Date((now - 600) * 1000).toISOString(),
      stage: "running",
      concurrency: 2,
      demand: 2,
      share: 2,
      issues: IDS,
      tickets: {
        301: { state: "implement", since: now - 60, started: now - 60 },
        302: { state: "queued", order: 0, since: now },
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

test("a run whose slot is kept for landing says so on the row next to start, not that it waits for its share", () => {
  const row = render({ waitsForShare: true, waitsFor: "landing" });
  assert.match(row("302"), /queued.*waits: slot kept to land/);
  assert.doesNotMatch(row("302"), /…/);
  assert.doesNotMatch(row("302"), /run's share/);
  assert.match(row("303"), /queued.*waits: slot kept to land/);
  assert.doesNotMatch(row("303"), /…/);
  assert.match(row("304"), /queued.*1 ahead of it/);
});

test("a record with waitsFor share, or only an older kit's boolean, still says the run's share", () => {
  for (const fields of [{ waitsForShare: true, waitsFor: "share" }, { waitsForShare: true }, { waitsFor: "share" }]) {
    const row = render(fields);
    assert.match(row("302"), /queued.*waits for the run's share/, JSON.stringify(fields));
    assert.doesNotMatch(row("302"), /…/, JSON.stringify(fields));
    assert.doesNotMatch(row("302"), /slot kept to land/);
  }
});

test("a paused run's queued rows wait for the resume, whatever holds the slot", () => {
  const row = render({ waitsForShare: true, waitsFor: "landing", paused: { since: now - 30, finishing: [] } });
  assert.match(row("302"), /queued.*waits for the resume/);
});

test("the run record says which of the share and the kept slot holds a wait back, and the share wins while both are open", () => {
  const told: [boolean, string | undefined][] = [];
  const waits = createSlotWaits((held, waitsFor) => told.push([held, waitsFor]));
  const kept = waits.begin();
  const capped = waits.begin();
  const full = waits.begin();
  full.onWait("slots");
  assert.deepEqual(told, [], "a full pool is neither");
  kept.onWait("landing");
  assert.deepEqual(told, [[true, "landing"]]);
  capped.onWait("share");
  assert.deepEqual(told.at(-1), [true, "share"], "the share wins");
  capped.end();
  assert.deepEqual(told.at(-1), [true, "landing"], "the kept slot still holds the other back");
  kept.onWait("slots");
  assert.deepEqual(told.at(-1), [false, undefined]);
});

test("burndown() writes what createSlotWaits tells into the run record, the reason beside the older boolean", () => {
  // burndown() needs Docker, so its call site is held by its text: without `waitsFor` the view never says the kept slot.
  const src = readFileSync(join(KIT, "src", "burndown.ts"), "utf8");
  assert.match(src, /createSlotWaits\(\(held, waitsFor\) => \{\s*try \{\s*run\.update\(\{ waitsForShare: held \|\| undefined, waitsFor \}\);/);
});
