// A failed tool's `! ...` line in the readable log quotes the tool's output, which can say "usage
// limit" (a test, a file, an API's own limit). Neither the run's limit check nor the status view
// reads it as a spent plan allowance. Temp dirs only; no Docker, no model calls, no network.
//
//   pnpm exec tsx --test test/tool-error-limit.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { kitLikeProcess } from "./kit-process.ts";
import { isToolFailureLine, logSaysLimit } from "../src/run.ts";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-tool-error-limit-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

test("isToolFailureLine knows the lines toolFailureLine writes, and only those", () => {
  for (const line of ["! error: No such tool", "! exit 1: boom", "! exit 2", "! exit -1: killed"]) assert.ok(isToolFailureLine(line), line);
  for (const line of ["!important", "! note", "Agent error: usage limit", "  ! exit 1: indented"]) assert.ok(!isToolFailureLine(line), line);
});

test("logSaysLimit reads the library's limit line, not a failed tool's", () => {
  assert.ok(logSaysLimit("Bash(pnpm test)\nAgent error: You've reached your usage limit\n"));
  assert.ok(!logSaysLimit("Bash(pnpm test)\n! exit 1: test/usage.test.ts: usage limit reached\nRun complete\n"));
  assert.ok(!logSaysLimit("Bash(gh api x)\n! error: API rate limit reached\n"));
  // Only the last lines count, as before.
  assert.ok(!logSaysLimit("usage limit\n" + "line\n".repeat(10)));
});

// The status view, with the harness of raw-log.test.ts: a fake sandcastle and docker, and a live run.
const frameFor = (name: string, logText: string) => {
  const root = join(TMP, name);
  const logs = join(root, ".sandcastle", "logs");
  mkdirSync(logs, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("checkout", "-q", "-b", "agent/issue-205");
  writeFileSync(join(root, "f"), "x\n");
  git("add", "f");
  git("commit", "-q", "-m", "issue 205");
  git("checkout", "-q", "main");
  writeFileSync(join(logs, "agent-issue-205-impl-205.log"), logText);
  const fake = join(TMP, "bin");
  mkdirSync(fake, { recursive: true });
  for (const [file, body] of [["sandcastle", "#!/bin/sh\nprintf '[]\\n'\n"], ["docker", "#!/bin/sh\nexit 1\n"]]) {
    writeFileSync(join(fake, file), body);
    chmodSync(join(fake, file), 0o755);
  }
  const now = Math.floor(Date.now() / 1000);
  const run = kitLikeProcess();
  writeFileSync(
    join(logs, "run.json"),
    JSON.stringify({
      orchestrator: "fixture", pid: run.pid, startedAt: new Date().toISOString(), models: "implement m/high", stage: "implementing",
      concurrency: 1, issues: ["205"], tickets: { "205": { state: "implement", since: now - 30, started: now - 60 } },
    }),
  );
  try {
    const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [fake, process.env.PATH].join(":"),
        SANDCASTLE_PROJECT: root,
        SANDCASTLE_BIN: join(fake, "sandcastle"),
        SANDCASTLE_BASE: "main",
        SANDCASTLE_NAME: "fixture",
        TERM_COLS: "120",
        TERM_ROWS: "200",
        XDG_CACHE_HOME: join(TMP, "cache"),
      },
    });
    return (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, "");
  } finally {
    run.kill();
  }
};

test("the status view flags a spent allowance from the library's line", () => {
  assert.match(frameFor("limit", "Bash(pnpm test)\nAgent error: You've reached your usage limit\n"), /USAGE LIMIT REACHED/);
});

test("the status view does not flag a failed tool whose output says usage limit", () => {
  assert.doesNotMatch(frameFor("tool", "Bash(pnpm test)\n! exit 1: test/usage.test.ts: usage limit reached\n"), /USAGE LIMIT REACHED/);
});
