// The status view's flags on a step that runs long: past twice the step's usual time the AGE turns
// red and the note says what usual is; past three times it the note says so in words, since an agent
// pass is bounded by nothing but its idle timeout. A made-up live run record, a fake `sandcastle`
// and a `docker` that finds nothing; no Docker, no network, no model calls.
//
//   pnpm exec tsx --test test/status-slow-step.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const COLS = 80;
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-slow-"));
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

const TYPICAL = 600;
const now = Math.floor(Date.now() / 1000);
// Ticket id -> seconds in the state, against an implement step that usually takes ten minutes.
const AGES: Record<string, number> = { 201: 300, 202: 1300, 203: 1900 };
writeFileSync(
  join(REPO, ".sandcastle", "logs", "run.json"),
  JSON.stringify({
    orchestrator: "fixture",
    pid: live.pid,
    startedAt: new Date((now - 3600) * 1000).toISOString(),
    stage: "running",
    concurrency: 3,
    typical: { implement: TYPICAL, issue: 900 },
    issues: Object.keys(AGES),
    tickets: Object.fromEntries(Object.entries(AGES).map(([id, age]) => [id, { state: "implement", since: now - age, started: now - age }])),
  }),
);

const frame = (() => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(utf8 ? { LC_ALL: utf8 } : {}),
      PATH: [FAKE, process.env.PATH].join(":"),
      FAKE_QUEUE: Object.keys(AGES).join(" "),
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: String(COLS),
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
  });
  return (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, "");
})();
const rowOf = (id: string) => frame.split("\n").find((l) => new RegExp(`^│ +#${id} +│`).test(l)) ?? "";

test("a step within twice its usual time carries no flag", () => {
  assert.match(rowOf("201"), /impl/);
  assert.doesNotMatch(rowOf("201"), /usually|3x/);
});

test("a step past twice its usual time says what usual is", () => {
  assert.match(rowOf("202"), /usually 10m/);
  assert.doesNotMatch(rowOf("202"), /3x/);
});

test("a step past three times its usual time says so", () => {
  assert.match(rowOf("203"), /3x over, usually 10m/);
});
