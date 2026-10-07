// Once a run has ended, the status view infers its rows from git and the logs, and their TIME was how
// long ago each ticket's log last changed: a 9-minute ticket and a 2-hour one both read "5h" the morning
// after, under a legend that says "once finished, start to end". A ticket the ended run's record holds
// finished now shows its whole length, as the live view did; one the record has no start for keeps the
// time since its log changed. A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   node --test test/status-ended-time.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a]);
execFileSync("git", ["-C", REPO, "init", "-q", "-b", "main"]);
git("commit", "-q", "--allow-empty", "-m", "base");

const now = Math.floor(Date.now() / 1000);
// Merged and closed, with an agent log last written two hours ago, when the run ended.
for (const n of [5, 6]) {
  git("checkout", "-q", "-b", `agent/issue-${n}`);
  git("commit", "-q", "--allow-empty", "-m", `work on ${n}`);
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `Merge agent/issue-${n} (closes #${n})`, `agent/issue-${n}`);
  git("branch", "-q", "-D", `agent/issue-${n}`);
  const log = join(LOGS, `agent-issue-${n}-impl-${n}.log`);
  writeFileSync(log, "done\n");
  utimesSync(log, now - 7200, now - 7200);
}
const ended = new Date((now - 7200) * 1000).toISOString();
writeFileSync(
  join(LOGS, "run.json"),
  JSON.stringify({
    orchestrator: "fixture",
    // Not a process of the kit: the run has ended.
    pid: 1,
    startedAt: ended,
    finishedAt: ended,
    exitCode: 0,
    models: "m",
    issues: ["5", "6"],
    tickets: { "5": { state: "merged", since: now - 7200, started: now - 7200 - 3000 }, "6": { state: "merged" } },
    settings: { autonomy: 0, turn: 1, cap: 1 },
  }),
);

const frame = (() => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: [FAKE, process.env.PATH].join(":"),
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: "100",
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
  });
  return r.stdout.replace(/\u001b\[[0-9;]*m/g, "");
})();
const time = (id: string) => (frame.split("\n").find((l) => new RegExp(`^│ +#${id} `).test(l)) ?? "").split("│").map((c) => c.trim())[3];

test("an ended run's finished ticket shows its whole length, not how long ago its log changed", () => {
  assert.equal(time("5"), "50m", frame);
});

test("a ticket the ended record has no start for keeps the time since its log changed", () => {
  assert.equal(time("6"), "2h", frame);
});
