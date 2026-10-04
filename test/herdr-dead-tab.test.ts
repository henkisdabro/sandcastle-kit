// A run that is no longer live leaves its Herdr tab behind (after a cold server restart, as idle
// shells): on the tab bar's next tick the tab the kit opened for it gets the closing report, once.
// A live run's tab, a tab adopted from a person's terminal and a tab that is not the recorded one
// are left alone. The fake `herdr` logs every call; no Herdr, no network.
//
//   pnpm exec tsx --test test/herdr-dead-tab.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { HERDR_PLUGIN, runKit } from "./cli-spawn.ts";
import { everyPidIsTheKit } from "./kit-process.ts";

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
const bin = mkdtempSync(join(tmpdir(), "sandcastle-deadtab-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const log = join(mkdtempSync(join(tmpdir(), "sandcastle-deadtab-log-")), "calls.log");
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_LOG: log, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-deadtab-cache-")) });
const { runsLine } = await import("../src/herdr-plugin.ts");
const { reportInDeadTab, viewRecord } = await import("../src/herdr.ts");

const KIT_DIR = "/the/kit";
const calls = () => (readFileSync(log, "utf8") ? readFileSync(log, "utf8").trim().split("\n") : []);
const reset = (paneTab = "w1:t2", fg = "-zsh") => {
  writeFileSync(log, "");
  Object.assign(process.env, { FAKE_PANE_TAB: paneTab, FAKE_FG: fg });
};

/** A project whose run is registered, with the Herdr view record it left. */
const project = (dir: string, record: object, view?: object) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-deadtab-project-")));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, Math.random().toString(16).slice(2)), root);
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", startedAt: "2026-10-02T01:00:00Z", ...record }));
  if (view) writeFileSync(viewRecord(root), JSON.stringify(view) + "\n");
  return root;
};
const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] };
const DEAD = { pid: 2 ** 22 + 12345 };
const tick = (dir: string) => runsLine(dir, undefined, (pid) => (pid === process.pid ? everyPidIsTheKit() : undefined), (root) => void reportInDeadTab(root, KIT_DIR));
const runs = () => mkdtempSync(join(tmpdir(), "sandcastle-deadtab-runs-"));

test("a dead run's own tab: the status pane runs the report, once", () => {
  reset();
  const dir = runs();
  const root = project(dir, DEAD, OWN);
  assert.equal(tick(dir), "");
  assert.deepEqual(calls(), ["pane get w1:t2-1", "pane process-info --pane w1:t2-1", `pane run w1:t2-1 cd '${root}' && '${KIT_DIR}/bin/sandcastle' report`]);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, true);
  // The record says it was shown: another reader of the record (a file left again, a second plugin
  // process) does not run it a second time.
  reset();
  assert.equal(reportInDeadTab(root, KIT_DIR), false);
  assert.deepEqual(calls(), []);
  // And the file is gone, so the next tick has no run to look at.
  assert.equal(readdirSync(dir).length, 0);
  assert.equal(tick(dir), "");
  assert.deepEqual(calls(), []);
});

test("a run that finished is replaced like one whose pid is gone", () => {
  reset();
  const dir = runs();
  project(dir, { pid: process.pid, finishedAt: "2026-10-02T04:00:00Z" }, OWN);
  tick(dir);
  assert.equal(calls().filter((c) => c.startsWith("pane run ")).length, 1, calls().join("\n"));
});

test("a live run's tab is untouched", () => {
  reset();
  const dir = runs();
  const root = project(dir, { pid: process.pid }, OWN);
  assert.match(tick(dir), /^♜ shop /);
  assert.deepEqual(calls(), []);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, undefined);
});

test("a tab adopted from a person's terminal is untouched", () => {
  reset();
  const dir = runs();
  project(dir, DEAD, { ...OWN, adopted: true });
  tick(dir);
  assert.deepEqual(calls(), []);
});

test("no view record (a run without Herdr), or a record with no status pane: nothing to replace", () => {
  reset();
  const dir = runs();
  project(dir, DEAD);
  project(dir, DEAD, { tab: "w1:t2", adopted: false });
  tick(dir);
  assert.deepEqual(calls(), []);
});

test("a status pane that is not in the recorded tab (ids renumbered by a restart) is not touched", () => {
  reset("w1:t7");
  const dir = runs();
  project(dir, DEAD, OWN);
  tick(dir);
  assert.deepEqual(calls(), ["pane get w1:t2-1"]);
});

test("a status pane still running the status view already shows how the run ended", () => {
  reset("w1:t2", "bash /kit/status.sh 5");
  const dir = runs();
  const root = project(dir, DEAD, OWN);
  tick(dir);
  assert.equal(calls().some((c) => c.startsWith("pane run")), false);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, undefined);
});

test("a pane Herdr no longer has leaves the tab and the record as they were", () => {
  const dir = runs();
  const root = project(dir, DEAD, OWN);
  // A herdr that fails every call, as when the server is not running.
  const broken = mkdtempSync(join(tmpdir(), "sandcastle-deadtab-broken-"));
  writeFileSync(join(broken, "herdr"), "#!/bin/sh\necho '{\"error\":{\"code\":\"server_not_running\"}}' >&2\nexit 1\n");
  chmodSync(join(broken, "herdr"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${broken}${delimiter}${path}`;
  try {
    assert.equal(reportInDeadTab(root, KIT_DIR), false);
  } finally {
    process.env.PATH = path;
  }
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, undefined);
  assert.equal(tick(dir), "");
});

test("`sandcastle herdr line`, the tab bar's own command, replaces the dead run's tab", () => {
  reset();
  const cache = mkdtempSync(join(tmpdir(), "sandcastle-deadtab-line-"));
  const dir = join(cache, "sandcastle-kit/runs");
  const root = project(dir, DEAD, OWN);
  const r = runKit(["herdr", "line"], { script: HERDR_PLUGIN, encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cache } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.ok(calls().some((c) => c.startsWith(`pane run w1:t2-1 cd '${root}' && `) && c.endsWith("/bin/sandcastle' report")), calls().join("\n"));
});
