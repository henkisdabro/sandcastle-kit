// After a run has ended, the status view shows a ticket landed partly done (`Merge ... (part of #n)`)
// as partly done, not as "queued for the next run": it is open and in the queue by design, and its
// own comment moves the issue after the merge, which `requeued` read as a person putting it back.
// Where the run record's `unmet` says the remainder is a person's decision, the row says so, as the
// closing summary does. A ticket that landed with "closes" and was relabelled after still reads queued.
// A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm exec tsx --test test/status-partly-done-ended.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-partly-ended-"));
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
execFileSync("git", ["-C", REPO, "init", "-q", "-b", "main"]);
execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");

const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a]);
const land = (n: number, how: "closes" | "part of") => {
  git("checkout", "-q", "-b", `agent/issue-${n}`);
  git("commit", "-q", "--allow-empty", "-m", `work on ${n}`);
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `Merge agent/issue-${n} (${how} #${n})`, `agent/issue-${n}`);
  git("branch", "-q", "-D", `agent/issue-${n}`);
  writeFileSync(join(LOGS, `agent-issue-${n}-impl-${n}.log`), "done\n");
};

/** The ended run's frame, with each ticket open in the queue and its issue updated an hour after the merge. */
const frame = (unmet: Record<number, string>, ids: number[]): string => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  script(join(FAKE, "sandcastle"), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(ids.map((n) => ({ id: String(n), updated: later, blockedOn: [] })))}\nJSON\n`);
  const now = new Date().toISOString();
  writeFileSync(
    join(LOGS, "run.json"),
    JSON.stringify({
      orchestrator: "fixture",
      pid: 1,
      startedAt: now,
      finishedAt: now,
      exitCode: 0,
      models: "m",
      issues: ids.map(String),
      tickets: Object.fromEntries(ids.map((n) => [String(n), { state: "merged", ...(unmet[n] ? { unmet: unmet[n] } : {}) }])),
      settings: { autonomy: 0, turn: 1, cap: 1 },
    }),
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: [FAKE, process.env.PATH].join(":"),
    SANDCASTLE_PROJECT: REPO,
    SANDCASTLE_BIN: join(FAKE, "sandcastle"),
    SANDCASTLE_BASE: "main",
    SANDCASTLE_NAME: "fixture",
    TERM_COLS: "110",
    TERM_ROWS: "200",
    XDG_CACHE_HOME: join(TMP, "cache"),
  };
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.stdout.replace(/\u001b\[[0-9;]*m/g, "");
};

test("an ended run's partly-done landing reads partly done, not queued for the next run", () => {
  land(5, "part of");
  land(6, "closes");
  const out = frame({ 5: "the retry path is not covered" }, [5, 6]);
  assert.match(out, /#5 +│ . merged .*partly done, ticket open/);
  assert.doesNotMatch(out, /#5 .*for the next run/);
  // Landed with "closes" and open again afterwards: put back by someone, so still queued.
  assert.match(out, /#6 +│ . queued .*for the next run/);
});

test("the run record's unmet says the remainder needs a person's decision, as the summary does", () => {
  const out = frame({ 5: "which of the two formats to keep is the maintainer's decision" }, [5, 6]);
  assert.match(out, /#5 +│ . merged .*partly done - needs a person's decision/);
  assert.doesNotMatch(out, /#5 .*for the next run/);
});
