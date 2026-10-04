// A merged ticket left open (a criterion unmet) is the closing summary's "needs you" but a "merged"
// row in the status view, which reads git and not the agents' notes: the view names the difference
// in its note instead of showing a count that disagrees with the summary unexplained.
// A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm exec tsx --test test/status-partly-done.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-partly-"));
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

const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a]);
const land = (n: number, how: "closes" | "part of") => {
  git("checkout", "-q", "-b", `agent/issue-${n}`);
  git("commit", "-q", "--allow-empty", "-m", `work on ${n}`);
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `Merge agent/issue-${n} (${how} #${n})`, `agent/issue-${n}`);
  git("branch", "-q", "-D", `agent/issue-${n}`);
  // The row exists because the ticket has an agent log.
  writeFileSync(join(LOGS, `agent-issue-${n}-impl-${n}.log`), "done\n");
};

const frame = (issues: number[]): string => {
  const now = new Date().toISOString();
  writeFileSync(join(LOGS, "run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: now, finishedAt: now, exitCode: 0, models: "m", issues: issues.map(String), tickets: Object.fromEntries(issues.map((n) => [String(n), { state: "merged" }])), settings: { autonomy: 0, turn: 1, cap: 1 } }));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: [FAKE, process.env.PATH].join(":"),
    SANDCASTLE_PROJECT: REPO,
    SANDCASTLE_BIN: join(FAKE, "sandcastle"),
    SANDCASTLE_BASE: "main",
    SANDCASTLE_NAME: "fixture",
    TERM_COLS: "100",
    TERM_ROWS: "200",
    XDG_CACHE_HOME: join(TMP, "cache"),
  };
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.stdout.replace(/\u001b\[[0-9;]*m/g, "");
};

test("a ticket merged partly done is named in the note, counted once", () => {
  land(5, "part of");
  land(6, "closes");
  const out = frame([5, 6]);
  assert.match(out, /#5 +│ . merged .*partly done, ticket open/);
  assert.match(out, /1 merged, partly done \(ticket open\): in merged here, in needs you in the closing summary/);
  assert.match(out, /needs you 0/);
});

test("with no partly-done ticket the note is absent", () => {
  rmSync(join(LOGS, "agent-issue-5-impl-5.log"));
  assert.doesNotMatch(frame([6]), /partly done \(ticket open\)/);
});
