// A finished run whose own Herdr tab is still to be told how it ended waits in the awaiting
// directory, beside the live-runs directory, not in it: the tab bar's gate (`ls -A runs`) starts the
// kit only while `runs` has a file, and a kept file there started it every tick for as long as the
// status view ran, or for good on a Herdr server that never came back. The awaiting directory is
// read by the plugin's startup hook and by the tab bar while live runs keep it ticking, and a
// record whose run ended more than AWAIT_REPORT_DAYS ago is gone. Fake herdr; no Herdr, no network.
//
//   pnpm exec tsx --test test/herdr-awaiting.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { HERDR_PLUGIN, runKit } from "./cli-spawn.ts";
import { everyPidIsTheKit, kitLikeProcess } from "./kit-process.ts";

// `pane get` answers with the recorded tab, `pane process-info` with $FAKE_FG as the foreground.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"w1:t2"}}}\\n' "$3" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"%s"}]}}}\\n' "$FAKE_FG" ;;
  *) echo '{}' ;;
esac
`;
const fresh = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `sandcastle-awaiting-${name}-`)));
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
const calls = () => (readFileSync(log, "utf8") ? readFileSync(log, "utf8").trim().split("\n") : []);
const typed = () => calls().filter((c) => c.startsWith("pane run "));
const reset = (fg = "-zsh") => {
  writeFileSync(log, "");
  process.env.FAKE_FG = fg;
};
const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] };
const SHOWING = "bash /the/kit/status.sh 5";
const probe = (pid: number) => (pid === process.pid ? everyPidIsTheKit() : undefined);
const tell = (root: string) => replaceDeadTab(root, KIT_DIR);
const report = (root: string) => `pane run w1:t2-1 cd '${root}' && '${KIT_DIR}/bin/sandcastle' report`;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** A project with its view record and run record, and a runs directory (in a cache of its own) whose sibling is the awaiting one. */
const project = (view: object, run: object, cache = fresh("kit-cache")) => {
  const root = fresh("project");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(viewRecord(root), JSON.stringify(view) + "\n");
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", startedAt: "2026-10-01T01:00:00Z", ...run }));
  const dir = join(cache, "sandcastle-kit/runs");
  mkdirSync(dir, { recursive: true });
  return { root, dir };
};
const register = (root: string, dir: string) => writeFileSync(runFile(root, dir), root);
const park = (root: string, dir: string) => {
  mkdirSync(awaitingDir(dir), { recursive: true });
  writeFileSync(runFile(root, awaitingDir(dir)), root);
};
const awaitingFiles = (dir: string) => (existsSync(awaitingDir(dir)) ? readdirSync(awaitingDir(dir)) : []);

test("a finished run with its view still showing leaves runs/ empty, its file awaiting", () => {
  const { root, dir } = project(OWN, { pid: process.pid, finishedAt: daysAgo(0) });
  register(root, dir);
  reset(SHOWING);
  assert.equal(runsLine(dir, undefined, probe, tell), "");
  assert.deepEqual(readdirSync(dir), [], "the tab bar's gate finds nothing: no kit started on the next tick");
  assert.deepEqual(awaitingFiles(dir), [runFile(root, dir).split(/[\\/]/).pop()]);
  assert.deepEqual(typed(), []);
  // The tab bar, ticking for a live run, looks at it again: still showing, it stays awaiting.
  tellAwaiting(dir, tell, probe);
  assert.equal(awaitingFiles(dir).length, 1);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, undefined);
});

test("the tab bar's read of the awaiting directory reports a tab whose view has gone, once", () => {
  const { root, dir } = project(OWN, { pid: process.pid, finishedAt: daysAgo(1) });
  park(root, dir);
  reset("-zsh");
  tellAwaiting(dir, tell, probe);
  assert.deepEqual(typed(), [report(root)]);
  assert.deepEqual(awaitingFiles(dir), []);
  reset("-zsh");
  tellAwaiting(dir, tell, probe);
  assert.deepEqual(calls(), []);
});

test("a stale elsewhere record expires, and a recent one stays for its server", () => {
  const view = { ...OWN, socket: "/run/herdr-a.sock" };
  const cache = fresh("kit-cache");
  const stale = project(view, { pid: process.pid, finishedAt: daysAgo(AWAIT_REPORT_DAYS + 1) }, cache);
  const recent = project(view, { pid: process.pid, finishedAt: daysAgo(AWAIT_REPORT_DAYS - 1) }, cache);
  const { dir } = stale;
  park(stale.root, dir);
  park(recent.root, dir);
  reset("-zsh");
  process.env.HERDR_SOCKET_PATH = "/run/herdr-b.sock";
  try {
    tellAwaiting(dir, tell, probe);
  } finally {
    delete process.env.HERDR_SOCKET_PATH;
  }
  assert.deepEqual(calls(), [], "another server's tab: no herdr call");
  assert.deepEqual(awaitingFiles(dir), [runFile(recent.root, dir).split(/[\\/]/).pop()]);
});

test("a killed run's record expires by its last change, as it has no finishedAt", () => {
  const cache = fresh("kit-cache");
  const old = project(OWN, { pid: 2 ** 22 + 12345 }, cache);
  const young = project(OWN, { pid: 2 ** 22 + 12346 }, cache);
  const then = new Date(Date.now() - (AWAIT_REPORT_DAYS + 1) * DAY);
  utimesSync(join(old.root, ".sandcastle/logs/run.json"), then, then);
  park(old.root, old.dir);
  park(young.root, old.dir);
  reset(SHOWING);
  tellAwaiting(old.dir, tell, probe);
  assert.deepEqual(awaitingFiles(old.dir), [runFile(young.root, old.dir).split(/[\\/]/).pop()]);
  // The startup hook drops an expired record too, rather than putting it back.
  park(old.root, old.dir);
  requeueAwaiting(old.dir, probe);
  assert.deepEqual(readdirSync(old.dir), [runFile(young.root, old.dir).split(/[\\/]/).pop()]);
  assert.deepEqual(awaitingFiles(old.dir), []);
});

test("a project running again drops its awaiting file, with nothing typed into the new run's tab", () => {
  const { root, dir } = project(OWN, { pid: process.pid });
  park(root, dir);
  reset("-zsh");
  tellAwaiting(dir, tell, probe);
  assert.deepEqual(typed(), []);
  assert.deepEqual(awaitingFiles(dir), []);
});

test("the startup hook puts each awaiting file back, keeping a file a new run wrote", () => {
  const cache = fresh("kit-cache");
  const a = project(OWN, { pid: 2 ** 22 + 12345, finishedAt: daysAgo(1) }, cache);
  const b = project(OWN, { pid: 2 ** 22 + 12346, finishedAt: daysAgo(1) }, cache);
  park(a.root, a.dir);
  park(b.root, a.dir);
  writeFileSync(runFile(b.root, a.dir), "/the/new/run/as/given");
  requeueAwaiting(a.dir, probe);
  assert.deepEqual(awaitingFiles(a.dir), []);
  assert.equal(readFileSync(runFile(a.root, a.dir), "utf8"), a.root);
  assert.equal(readFileSync(runFile(b.root, a.dir), "utf8"), "/the/new/run/as/given");
});

// ---------------------------------------------------------------------------
// The plugin's own verbs, as Herdr runs them.
// ---------------------------------------------------------------------------

const kitEnv = (cache: string): NodeJS.ProcessEnv => ({ ...process.env, XDG_CACHE_HOME: cache, HERDR_PLUGIN_STATE_DIR: fresh("state") });

test("`sandcastle herdr startup` moves the awaiting files back, and the next tick reports", () => {
  const cache = fresh("kit-cache");
  const { root, dir } = project(OWN, { pid: 2 ** 22 + 12345, finishedAt: daysAgo(1) }, cache);
  park(root, dir);
  reset("-zsh");
  const r = runKit(["herdr", "startup"], { script: HERDR_PLUGIN, encoding: "utf8", env: kitEnv(cache) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(dir), [runFile(root, dir).split(/[\\/]/).pop()]);
  assert.deepEqual(awaitingFiles(dir), []);
  assert.deepEqual(typed(), [], "the hook itself types nothing");
  runsLine(dir, undefined, probe, tell);
  assert.deepEqual(typed(), [report(root)]);
  assert.deepEqual(readdirSync(dir), []);
});

test("`sandcastle herdr line` reads the awaiting directory only while a live run exists", () => {
  const cache = fresh("kit-cache");
  const parked = project(OWN, { pid: 2 ** 22 + 12345, finishedAt: daysAgo(1) }, cache);
  park(parked.root, parked.dir);
  reset("-zsh");
  const line = () => runKit(["herdr", "line"], { script: HERDR_PLUGIN, encoding: "utf8", env: kitEnv(cache) });
  const idle = line();
  assert.equal(idle.status, 0, idle.stderr);
  assert.deepEqual(typed(), []);
  assert.equal(awaitingFiles(parked.dir).length, 1);
  const run = kitLikeProcess();
  try {
    // A live run in an adopted tab: nothing of its own is typed.
    const live = project({ ...OWN, adopted: true }, { pid: run.pid }, cache);
    register(live.root, live.dir);
    const r = line();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^♜ shop /);
    assert.equal(typed().length, 1, typed().join("\n"));
    assert.ok(typed()[0].startsWith(`pane run w1:t2-1 cd '${parked.root}' && `) && typed()[0].endsWith("/bin/sandcastle' report"), typed().join("\n"));
    assert.deepEqual(awaitingFiles(parked.dir), []);
  } finally {
    run.kill();
  }
});
