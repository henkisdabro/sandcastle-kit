// A Herdr restart mid-run leaves the run's own tab as idle shells: the status view died with the
// server. While the run is live, each tab-bar tick that finds the recorded status pane a bare shell
// starts the view there again. A run that then ends (cleanly, or stopped by the restart's hangup)
// leaves its live-runs file while its own tab is unreported, so the tick reports there once and the
// file goes; a run in a tab adopted from a person's terminal removes its file at exit as before.
// Real child processes for the exit, a fake `herdr` that logs every call; no Herdr, no network.
//
//   pnpm exec tsx --test test/herdr-restart.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { HERDR_PLUGIN, KIT, runKit } from "./cli-spawn.ts";
import { everyPidIsTheKit, kitLikeProcess } from "./kit-process.ts";

// `pane get` answers with $FAKE_PANE_TAB as the pane's tab, `pane process-info` with $FAKE_FG as
// its foreground command; anything else is logged and answered with `{}`.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"%s"}}}\\n' "$3" "$FAKE_PANE_TAB" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"%s"}]}}}\\n' "$FAKE_FG" ;;
  *) echo '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-restart-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const log = join(mkdtempSync(join(tmpdir(), "sandcastle-restart-log-")), "calls.log");
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_LOG: log, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-restart-cache-")) });
// The harness may itself run in Herdr: a socket of its own would make every record another server's.
delete process.env.HERDR_SOCKET_PATH;
const { replaceDeadTab, runsLine } = await import("../src/herdr-plugin.ts");
const { restartStatusView, viewRecord } = await import("../src/herdr.ts");
const { runFile } = await import("../src/live-runs.ts");

const KIT_DIR = "/the/kit";
const calls = () => (readFileSync(log, "utf8") ? readFileSync(log, "utf8").trim().split("\n") : []);
const typed = () => calls().filter((c) => c.startsWith("pane run "));
const reset = (fg = "-zsh", paneTab = "w1:t2") => {
  writeFileSync(log, "");
  Object.assign(process.env, { FAKE_PANE_TAB: paneTab, FAKE_FG: fg });
};
const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] };
const record = (root: string) => JSON.parse(readFileSync(viewRecord(root), "utf8"));
const fresh = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `sandcastle-restart-${name}-`)));
const project = (view?: object) => {
  const root = fresh("project");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  if (view) writeFileSync(viewRecord(root), JSON.stringify(view) + "\n");
  return root;
};
const tick = (dir: string, probe = (pid: number) => (pid === process.pid ? everyPidIsTheKit() : undefined)) =>
  runsLine(dir, undefined, probe, (root) => replaceDeadTab(root, KIT_DIR), (root) => void restartStatusView(root, KIT_DIR));
const startedView = (root: string) => `pane run w1:t2-1 cd '${root}' && "${KIT_DIR}/bin/sandcastle" status`;
const report = (root: string) => `pane run w1:t2-1 cd '${root}' && '${KIT_DIR}/bin/sandcastle' report`;

// ---------------------------------------------------------------------------
// The run's exit: a process of its own, which records itself and registers as burndown.ts does.
// ---------------------------------------------------------------------------

const href = (f: string) => JSON.stringify(pathToFileURL(join(KIT, f)).href);
const fixture = join(fresh("fixture"), "run.mts");
writeFileSync(
  fixture,
  `import { registerRun } from ${href("src/live-runs.ts")};
import { exitOnSignal, recordRun } from ${href("src/run.ts")};
const root = process.env.FIXTURE_ROOT as string;
recordRun({ root, name: "shop" } as any, { dryRun: true });
registerRun(root);
const sig = process.env.FIXTURE_SIGNAL as NodeJS.Signals | undefined;
if (sig) {
  exitOnSignal();
  process.kill(process.pid, sig);
  setTimeout(() => {}, 30_000);
}
`,
);
/** Runs the fixture to its end and returns the runs directory it registered in. */
const runToEnd = (root: string, signal?: string) => {
  const cache = fresh("cache");
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cache, FIXTURE_ROOT: root, ...(signal ? { FIXTURE_SIGNAL: signal } : {}) };
  // An attached run: a detached one ignores SIGHUP.
  for (const k of ["SANDCASTLE_DETACHED", "CLAUDE_CODE_SESSION_ID", "HERDR_ENV", "HERDR_PANE_ID"]) delete env[k];
  const res = runKit([], { script: fixture, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(signal ? res.signal : res.status, signal ?? 0, res.stderr);
  const dir = join(cache, "sandcastle-kit/runs");
  assert.ok(existsSync(join(dir, "..")), "the run registered");
  return dir;
};

test("a clean exit with its own tab unreported keeps its live-runs file", () => {
  const root = project(OWN);
  const dir = runToEnd(root);
  assert.equal(readFileSync(runFile(root, dir), "utf8"), root);
  assert.ok(JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")).finishedAt);
});

test("a stop on the restart's hangup keeps it too", () => {
  const root = project(OWN);
  const dir = runToEnd(root, "SIGHUP");
  assert.ok(existsSync(runFile(root, dir)));
  assert.equal(JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")).stoppedBy, "SIGHUP");
});

test("an adopted tab, a tab already reported, or no view record: the file goes at exit as before", () => {
  for (const view of [{ ...OWN, adopted: true }, { ...OWN, reported: true }, undefined]) {
    const root = project(view);
    const dir = runToEnd(root);
    assert.equal(existsSync(runFile(root, dir)), false, JSON.stringify(view));
  }
  const adopted = project({ ...OWN, adopted: true });
  assert.equal(existsSync(runFile(adopted, runToEnd(adopted, "SIGTERM"))), false, "a signal too");
});

test("a finished run's bare-shell status pane gets the report once, and the file goes", () => {
  const root = project(OWN);
  const dir = runToEnd(root);
  // Herdr restarted after the run ended, or the hangup that stopped it was the restart's.
  reset("-zsh");
  assert.equal(tick(dir), "");
  assert.deepEqual(typed(), [report(root)]);
  assert.equal(record(root).reported, true);
  assert.equal(readdirSync(dir).length, 0);
  reset("-zsh");
  tick(dir);
  assert.deepEqual(calls(), []);
});

test("a finished run whose status view still runs keeps its file, with nothing typed", () => {
  const root = project(OWN);
  const dir = runToEnd(root);
  reset("bash /kit/status.sh 5");
  for (const _ of [1, 2]) assert.equal(tick(dir), "");
  assert.deepEqual(typed(), []);
  assert.ok(existsSync(runFile(root, dir)));
  assert.equal(record(root).reported, undefined);
});

// ---------------------------------------------------------------------------
// A live run's tab after a restart.
// ---------------------------------------------------------------------------

/** A live run's project (this process's pid) and its runs directory. */
const liveRun = (view: object) => {
  const root = project(view);
  const dir = fresh("runs");
  writeFileSync(join(dir, "run"), root);
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", startedAt: "2026-10-04T01:00:00Z", pid: process.pid }));
  return { root, dir };
};

test("a live run's bare-shell status pane gets the status view started once per tick that finds it bare", () => {
  const { root, dir } = liveRun(OWN);
  reset("-zsh");
  assert.match(tick(dir), /^♜ shop /);
  assert.deepEqual(typed(), [startedView(root)]);
  // No once-per-restart mark: the next tick that finds it bare starts it again.
  reset("-zsh");
  tick(dir);
  assert.deepEqual(typed(), [startedView(root)]);
  // Once it runs, nothing is typed.
  reset("bash /the/kit/status.sh");
  for (const _ of [1, 2]) tick(dir);
  assert.deepEqual(typed(), []);
  assert.equal(record(root).reported, undefined, "a live run's record is not marked");
  assert.equal(readdirSync(dir).length, 1);
});

test("a live run's tab is left alone when adopted, already reported, elsewhere, or busy with anything else", () => {
  for (const [view, fg, paneTab] of [
    [{ ...OWN, adopted: true }, "-zsh", "w1:t2"],
    [{ ...OWN, reported: true }, "-zsh", "w1:t2"],
    [OWN, "vim notes.md", "w1:t2"],
    [OWN, "-zsh", "w1:t7"],
    [{ tab: "w1:t2", adopted: false }, "-zsh", "w1:t2"],
  ] as const) {
    const { dir } = liveRun(view);
    reset(fg, paneTab);
    assert.match(tick(dir), /^♜ shop /);
    assert.deepEqual(typed(), [], JSON.stringify({ view, fg, paneTab }));
  }
  // A record naming another Herdr server: no herdr call at all.
  const { dir } = liveRun({ ...OWN, socket: "/run/herdr-a.sock" });
  reset("-zsh");
  process.env.HERDR_SOCKET_PATH = "/run/herdr-b.sock";
  try {
    tick(dir);
  } finally {
    delete process.env.HERDR_SOCKET_PATH;
  }
  assert.deepEqual(calls(), []);
});

test("`sandcastle herdr line`, the tab bar's own command, starts a live run's status view with the kit's command", () => {
  const run = kitLikeProcess();
  try {
    const cache = fresh("line");
    const dir = join(cache, "sandcastle-kit/runs");
    mkdirSync(dir, { recursive: true });
    const root = project(OWN);
    writeFileSync(join(dir, "run"), root);
    writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", startedAt: "2026-10-04T01:00:00Z", pid: run.pid }));
    reset("-zsh");
    const r = runKit(["herdr", "line"], { script: HERDR_PLUGIN, encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cache } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^♜ shop /);
    assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${root}' && "${join(KIT, "bin/sandcastle")}" status`]);
  } finally {
    run.kill();
  }
});
