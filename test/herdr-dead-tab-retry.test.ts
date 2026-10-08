// A herdr that fails while a finished run's tab is being told (a server Herdr has not restored yet
// when the startup hook's first tick runs, or any transient error) says nothing about the tab: the
// run's file stays awaiting for the next reader instead of being deleted, which lost the report.
// The 7-day expiry still ends it. Fake herdr that fails on demand; no Herdr, no network.
//
//   pnpm test:file test/herdr-dead-tab-retry.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";

// Every call fails while $FAKE_DOWN is set; `pane run` alone fails while $FAKE_RUN_FAILS is.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
if [ -n "$FAKE_DOWN" ]; then echo '{"error":{"code":"server_not_running"}}' >&2; exit 1; fi
case "$1 $2" in
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"w1:t2"}}}\\n' "$3" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"-zsh"}]}}}\\n' ;;
  "pane run") if [ -n "$FAKE_RUN_FAILS" ]; then echo boom >&2; exit 1; fi; echo '{}' ;;
  *) echo '{}' ;;
esac
`;
const fresh = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `sandcastle-retry-${name}-`)));
const bin = fresh("bin");
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const log = join(fresh("log"), "calls.log");
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_LOG: log, XDG_CACHE_HOME: fresh("cache") });
// The harness may itself run in Herdr: a socket of its own would make every record another server's.
delete process.env.HERDR_SOCKET_PATH;
const { replaceDeadTab, requeueAwaiting, runsLine, tellAwaiting } = await import("../src/herdr-plugin.ts");
const { viewRecord } = await import("../src/herdr.ts");
const { AWAIT_REPORT_DAYS, awaitingDir, runFile } = await import("../src/live-runs.ts");

const KIT_DIR = "/the/kit";
const DAY = 24 * 60 * 60 * 1000;
const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] };
const probe = (pid: number) => (pid === process.pid ? everyPidIsTheKit() : undefined);
const tell = (root: string) => replaceDeadTab(root, KIT_DIR);
const typed = () => (readFileSync(log, "utf8") ? readFileSync(log, "utf8").trim().split("\n") : []).filter((c) => c.startsWith("pane run "));
const reset = (down = "", runFails = "") => {
  writeFileSync(log, "");
  Object.assign(process.env, { FAKE_DOWN: down, FAKE_RUN_FAILS: runFails });
};

/** A finished project whose run file awaits its report, in a cache of its own. */
const parked = (finishedDaysAgo = 0) => {
  const root = fresh("project");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(viewRecord(root), JSON.stringify(OWN) + "\n");
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", pid: 2 ** 22 + 12345, finishedAt: new Date(Date.now() - finishedDaysAgo * DAY).toISOString() }));
  const dir = join(fresh("cache"), "sandcastle-kit/runs");
  mkdirSync(awaitingDir(dir), { recursive: true });
  writeFileSync(runFile(root, awaitingDir(dir)), root);
  return { root, dir };
};
const awaitingFiles = (dir: string) => (existsSync(awaitingDir(dir)) ? readdirSync(awaitingDir(dir)) : []);
const queued = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f !== "awaiting") : []);

test("a herdr that is down at startup keeps the awaiting file, and a later tick reports once it is back", () => {
  const { root, dir } = parked();
  reset("1");
  // The startup hook, then the first tick, both before Herdr has restored its session.
  requeueAwaiting(dir, probe);
  assert.equal(queued(dir).length, 1);
  assert.equal(runsLine(dir, undefined, probe, tell), "");
  assert.equal(queued(dir).length, 0, "the tab bar's gate is not held open");
  assert.equal(awaitingFiles(dir).length, 1, "the file is back awaiting, not deleted");
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, undefined);
  tellAwaiting(dir, tell, probe);
  assert.equal(awaitingFiles(dir).length, 1, "a second failure keeps it too");
  // Herdr is back: the next reader reports and the file goes.
  reset();
  tellAwaiting(dir, tell, probe);
  assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${root}' && '${KIT_DIR}/bin/sandcastle' report`]);
  assert.equal(awaitingFiles(dir).length, 0);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, true);
});

test("a report that herdr refuses to type keeps the awaiting file and the record unmarked", () => {
  const { root, dir } = parked();
  reset("", "1");
  tellAwaiting(dir, tell, probe);
  assert.equal(awaitingFiles(dir).length, 1);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, undefined);
  reset();
  tellAwaiting(dir, tell, probe);
  assert.equal(typed().length, 1);
  assert.equal(awaitingFiles(dir).length, 0);
});

test("a herdr that keeps failing does not keep a file past the 7-day expiry", () => {
  const { dir } = parked(AWAIT_REPORT_DAYS + 1);
  reset("1");
  tellAwaiting(dir, tell, probe);
  assert.equal(awaitingFiles(dir).length, 0);
});

test("a tab that is not to be told is still left: its file goes, with nothing typed", () => {
  const { root, dir } = parked();
  writeFileSync(viewRecord(root), JSON.stringify({ ...OWN, adopted: true }) + "\n");
  reset();
  tellAwaiting(dir, tell, probe);
  assert.equal(awaitingFiles(dir).length, 0);
  assert.deepEqual(typed(), []);
});
