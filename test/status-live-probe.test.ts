// The status view's liveness probe when `ps` cannot answer: a live run's frame keeps its PLAN lane.
// Under a full suite's load a `ps` can fail on its own (a fork refused, say); read as "no such process",
// one failed probe drew a live run as ended and its frame lost PLAN (the status-usage flake). A stub `ps`
// ahead on PATH fails for the run's pid, once or every time, and delegates everything else to the real one.
// A pid that is really gone still reads as ended at once. No Docker, no network.
//
//   pnpm test:file test/status-live-probe.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { kitLikeProcess } from "./kit-process.ts";
import { plain, spawnStatus } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-live-probe-"));
const live = kitLikeProcess();
after(() => {
  live.kill();
  rmSync(TMP, { recursive: true, force: true });
});
const REPO = join(TMP, "repo");
const FAKE = join(TMP, "bin");
const COUNT = join(TMP, "ps-failures");
mkdirSync(join(REPO, ".sandcastle", "logs"), { recursive: true });
mkdirSync(FAKE);
const realPs = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
assert.ok(realPs, "ps is on PATH");
const script = (name: string, body: string) => {
  writeFileSync(join(FAKE, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(FAKE, name), 0o755);
};
script("sandcastle", "echo '[]'");
script("docker", "exit 1");
// Fails a probe of PS_FAIL_PID while fewer than PS_FAILS have failed, counting each failure in PS_COUNT.
script(
  "ps",
  [
    `if [ "$1" = "-p" ] && [ "$2" = "$PS_FAIL_PID" ]; then`,
    `  n=$(cat "$PS_COUNT" 2>/dev/null || echo 0)`,
    `  if [ "$n" -lt "$PS_FAILS" ]; then echo $((n + 1)) > "$PS_COUNT"; echo "ps: fork: Resource temporarily unavailable" >&2; exit 1; fi`,
    `fi`,
    `exec ${realPs} "$@"`,
  ].join("\n"),
);
const git = (...a: string[]) => spawnSync("git", ["-C", REPO, "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");

const now = Math.floor(Date.now() / 1000);
const record = (pid: number) =>
  writeFileSync(
    join(REPO, ".sandcastle", "logs", "run.json"),
    JSON.stringify({
      orchestrator: "fixture",
      pid,
      startedAt: new Date().toISOString(),
      models: "m",
      stage: "running",
      issues: [],
      tickets: {},
      usage: { provider: "claude", at: now - 120, windows: { fiveHour: { percent: 14, resetsAt: now + 7200 }, week: { percent: 93, resetsAt: now + 3 * 86400 } } },
    }),
  );

/** One `status 0` frame, as plain text, with `ps` failing `fails` times for `pid`; and how many probes failed. */
const frame = (pid: number, fails: number) => {
  rmSync(COUNT, { force: true });
  const r = spawnStatus(["0"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${FAKE}:${process.env.PATH}`,
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: "160",
      TERM_ROWS: "60",
      NO_COLOR: "1",
      XDG_CACHE_HOME: join(TMP, "cache"),
      PS_FAIL_PID: String(pid),
      PS_FAILS: String(fails),
      PS_COUNT: COUNT,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  let failed = 0;
  try {
    failed = Number(readFileSync(COUNT, "utf8").trim());
  } catch {
    // no probe failed
  }
  return { out: plain(r.stdout), failed };
};
/** The PLAN lane, one reading on one row: `plan  claude 5h ... 93%`. */
const hasPlan = (out: string) => /\bplan +claude 5h .* 93%/.test(out);

test("a live run whose ps probe fails once is still read as live, and its frame keeps PLAN", () => {
  record(live.pid);
  const { out, failed } = frame(live.pid, 1);
  assert.equal(failed, 1, "the stub's one failure was met");
  assert.ok(hasPlan(out), `the frame dropped PLAN:\n${out}`);
  assert.ok(!out.includes("ended"), "a live run reads as ended");
});

test("a live run whose ps never answers while its pid exists is read as live, and its frame keeps PLAN", () => {
  record(live.pid);
  const { out, failed } = frame(live.pid, 1000);
  assert.ok(failed >= 1, "the stub failed the probe");
  assert.ok(hasPlan(out), `the frame dropped PLAN:\n${out}`);
});

test("a pid that is really gone still reads as ended, without PLAN", () => {
  const gone = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  const pid = Number(gone.stdout.trim());
  record(pid);
  const { out } = frame(pid, 0);
  assert.ok(!hasPlan(out), `a gone run kept PLAN:\n${out}`);
});
