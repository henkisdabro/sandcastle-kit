// A person who quits the status view (Ctrl-C) in the run's own status pane keeps that pane as their
// shell: status.sh's INT trap marks the view record `quit`, and while the pane's Herdr terminal_id is
// the one recorded, the tab bar neither types the view back in during the run nor the report after
// it. A new terminal_id is a Herdr restart: the mark is cleared and the view comes back. A record
// without terminal_id (an older kit's) acts as before. The fake `herdr` logs every call, and a fake
// `sleep` sends status.sh its signal mid-loop; no Herdr, no network.
//
//   pnpm exec tsx --test test/herdr-view-quit.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { KIT } from "./cli-spawn.ts";
import { everyPidIsTheKit } from "./kit-process.ts";

// `pane get` answers with $FAKE_PANE_TAB as the pane's tab and $FAKE_TERM as its terminal,
// `pane process-info` with $FAKE_FG as its foreground command; anything else is logged and
// answered with `{}`, or with a new pane for a split.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"%s","terminal_id":"%s"}}}\\n' "$3" "$FAKE_PANE_TAB" "$FAKE_TERM" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"%s"}]}}}\\n' "$FAKE_FG" ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"w1:t2","workspace_id":"w1"},"root_pane":{"pane_id":"w1:t2-1"}}}' ;;
  "pane split") printf '%s\\n' '{"result":{"pane":{"pane_id":"w1:t2-2"}}}' ;;
  *) echo '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-quit-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const log = join(mkdtempSync(join(tmpdir(), "sandcastle-quit-log-")), "calls.log");
Object.assign(process.env, {
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  FAKE_LOG: log,
  HERDR_ENV: "1",
  XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-quit-cache-")),
});
// The harness may itself run in Herdr: a socket or pane of its own would change what is recorded.
delete process.env.HERDR_SOCKET_PATH;
delete process.env.HERDR_PANE_ID;
const { replaceDeadTab, runsLine } = await import("../src/herdr-plugin.ts");
const { openSandboxView, restartStatusView, tellDeadTab, viewRecord } = await import("../src/herdr.ts");

const KIT_DIR = "/the/kit";
const calls = () => (readFileSync(log, "utf8") ? readFileSync(log, "utf8").trim().split("\n") : []);
const typed = () => calls().filter((c) => c.startsWith("pane run "));
const reset = (term = "term-1", fg = "-zsh") => {
  writeFileSync(log, "");
  Object.assign(process.env, { FAKE_PANE_TAB: "w1:t2", FAKE_FG: fg, FAKE_TERM: term });
};
const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] };
const QUIT = { ...OWN, terminal_id: "term-1", quit: true };
const record = (root: string) => JSON.parse(readFileSync(viewRecord(root), "utf8"));
const fresh = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `sandcastle-quit-${name}-`)));
const probe = (pid: number) => (pid === process.pid ? everyPidIsTheKit() : undefined);
/** A project with the given view record, its run (live: this process's pid) registered in a runs directory of its own. */
const registered = (view: object, run: object) => {
  const root = fresh("project");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(viewRecord(root), JSON.stringify(view) + "\n");
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", startedAt: "2026-10-04T01:00:00Z", ...run }));
  const dir = fresh("runs");
  writeFileSync(join(dir, "run"), root);
  return { root, dir };
};
const LIVE = { pid: process.pid };
const DEAD = { pid: 2 ** 22 + 12345 };
const tick = (dir: string) =>
  runsLine(dir, undefined, probe, (root) => replaceDeadTab(root, KIT_DIR), (root) => void restartStatusView(root, KIT_DIR));
const startedView = (root: string) => `pane run w1:t2-1 cd '${root}' && '${KIT_DIR}/bin/sandcastle' status`;
const report = (root: string) => `pane run w1:t2-1 cd '${root}' && '${KIT_DIR}/bin/sandcastle' report`;

// ---------------------------------------------------------------------------
// The tab bar's ticks.
// ---------------------------------------------------------------------------

test("a view quit during a live run gets nothing typed into its shell, tick after tick", () => {
  const { root, dir } = registered(QUIT, LIVE);
  for (const fg of ["-zsh", "-zsh"]) {
    reset("term-1", fg);
    assert.match(tick(dir), /^♜ shop /);
  }
  assert.deepEqual(typed(), []);
  assert.deepEqual(record(root), QUIT, "the record is left as it was");
});

test("a changed terminal_id is a Herdr restart: the mark is cleared, the new id recorded, the view started", () => {
  const { root, dir } = registered(QUIT, LIVE);
  reset("term-2");
  tick(dir);
  assert.deepEqual(typed(), [startedView(root)]);
  assert.equal(record(root).quit, undefined);
  assert.equal(record(root).terminal_id, "term-2");
  // A quit after that holds again, against the new id.
  writeFileSync(viewRecord(root), JSON.stringify({ ...record(root), quit: true }) + "\n");
  reset("term-2");
  tick(dir);
  assert.deepEqual(typed(), []);
});

test("a changed terminal_id whose pane is busy with something else is left, mark and all", () => {
  const { root, dir } = registered(QUIT, LIVE);
  reset("term-2", "vim notes.md");
  tick(dir);
  assert.deepEqual(typed(), []);
  assert.deepEqual(record(root), QUIT);
});

test("a record without terminal_id restarts as before, and has the id from then on", () => {
  const { root, dir } = registered({ ...OWN, quit: true }, LIVE);
  reset("term-1");
  tick(dir);
  assert.deepEqual(typed(), [startedView(root)]);
  assert.deepEqual(record(root), { ...OWN, terminal_id: "term-1" });
  // An unquit record without the id gets it too, when its view is restarted.
  const plain = registered(OWN, LIVE);
  reset("term-1");
  tick(plain.dir);
  assert.deepEqual(typed(), [startedView(plain.root)]);
  assert.equal(record(plain.root).terminal_id, "term-1");
});

test("after the run, a view quit in the same terminal gets no report: the record is marked and the file goes", () => {
  const { root, dir } = registered(QUIT, DEAD);
  reset("term-1");
  assert.equal(tick(dir), "");
  assert.deepEqual(typed(), []);
  assert.equal(record(root).reported, true);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(readdirSync(join(root, ".sandcastle/logs")).sort(), ["herdr-view.json", "run.json"], "no claim file is left");
  // Whatever runs in that shell now, it is not looked at again.
  reset("term-1", "vim notes.md");
  assert.equal(tellDeadTab(root, KIT_DIR), "left");
  assert.deepEqual(calls(), []);
});

test("after the run, a quit view whose terminal_id changed gets the report as before", () => {
  const { root, dir } = registered(QUIT, DEAD);
  reset("term-2");
  tick(dir);
  assert.deepEqual(typed(), [report(root)]);
  assert.equal(record(root).reported, true);
  assert.deepEqual(readdirSync(dir), []);
});

test("after the run, a quit record without terminal_id gets the report as before", () => {
  const { root } = registered({ ...OWN, quit: true }, DEAD);
  reset("term-1");
  assert.equal(tellDeadTab(root, KIT_DIR), "reported");
  assert.deepEqual(typed(), [report(root)]);
});

// ---------------------------------------------------------------------------
// The run's own writes of the record.
// ---------------------------------------------------------------------------

test("openSandboxView records the status pane's terminal_id, and its rewrites keep a quit mark", () => {
  const root = fresh("open");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  // An earlier run's mark is not this run's.
  writeFileSync(viewRecord(root), JSON.stringify({ ...QUIT, terminal_id: "term-0" }) + "\n");
  reset("term-1");
  (process.stdout as { isTTY?: boolean }).isTTY = false;
  const view = openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => ({}), "all");
  assert.equal(record(root).terminal_id, "term-1");
  assert.equal(record(root).quit, undefined);
  // The person quits; then a sandbox pane opens, and the run rewrites the record.
  writeFileSync(viewRecord(root), JSON.stringify({ ...record(root), quit: true }) + "\n");
  view.claim("7", "a ticket");
  assert.deepEqual(record(root).panes, ["w1:t2-2"], "the rewrite happened");
  assert.equal(record(root).quit, true);
  assert.equal(record(root).terminal_id, "term-1");
  // A terminal the tab bar recorded for a restarted view is kept as well.
  writeFileSync(viewRecord(root), JSON.stringify({ ...record(root), terminal_id: "term-5" }) + "\n");
  view.finish("7", "merged", true);
  assert.equal(record(root).terminal_id, "term-5");
});

// ---------------------------------------------------------------------------
// status.sh's traps.
// ---------------------------------------------------------------------------

const viewRepo = () => {
  const repo = fresh("repo");
  mkdirSync(join(repo, ".sandcastle/logs"), { recursive: true });
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(viewRecord(repo), JSON.stringify({ ...OWN, terminal_id: "term-1" }) + "\n");
  return repo;
};
const fakes = (signal: string) => {
  const dir = fresh(`fakes-${signal}`);
  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  };
  script("sandcastle", "#!/bin/sh\necho '[]'\n");
  script("docker", "#!/bin/sh\nexit 1\n");
  // The loop's only pause: the signal arrives as the view waits out its interval, as Ctrl-C would.
  script("sleep", `#!/bin/sh\nkill -${signal} "$PPID"\nexit 0\n`);
  return dir;
};
/** The live view (interval 1) in the pane `pane`, sent `signal` once its first frame is drawn. */
const viewGets = (signal: string, env: NodeJS.ProcessEnv) => {
  const repo = viewRepo();
  const r = spawnSync("bash", [join(KIT, "status.sh"), "1"], {
    encoding: "utf8",
    // Three frames at most: a signal that never came ends the view with status 0, not a hang.
    env: { ...process.env, PATH: `${fakes(signal)}${delimiter}${process.env.PATH}`, SANDCASTLE_PROJECT: repo, SANDCASTLE_BASE: "main", STATUS_FRAMES: "3", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { r, view: record(repo), repo };
};

test("status.sh: Ctrl-C (INT) in the recorded status pane marks the view quit", () => {
  const { r, view, repo } = viewGets("INT", { HERDR_ENV: "1", HERDR_PANE_ID: "w1:t2-1" });
  assert.equal(r.status, 130, r.stderr);
  assert.deepEqual(view, { ...OWN, terminal_id: "term-1", quit: true });
  assert.deepEqual(readdirSync(join(repo, ".sandcastle/logs")), ["herdr-view.json"], "no temp file is left");
});

test("status.sh: a hangup, a TERM, another pane or no Herdr marks nothing", () => {
  for (const [signal, env] of [
    ["HUP", { HERDR_ENV: "1", HERDR_PANE_ID: "w1:t2-1" }],
    ["TERM", { HERDR_ENV: "1", HERDR_PANE_ID: "w1:t2-1" }],
    ["INT", { HERDR_ENV: "1", HERDR_PANE_ID: "w1:t9-1" }],
    ["INT", { HERDR_ENV: "", HERDR_PANE_ID: "w1:t2-1" }],
  ] as const) {
    const { r, view } = viewGets(signal, env);
    assert.ok(r.signal === "SIGHUP" || r.status === 130, `${signal}: ${r.status} ${r.signal} ${r.stderr}`);
    assert.equal(view.quit, undefined, JSON.stringify({ signal, env }));
  }
});
