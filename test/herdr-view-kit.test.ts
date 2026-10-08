// The kit a run was started from is the one its tab's status view and closing report run. The tab
// bar's tick runs the checkout the plugin is linked from, so a run of a second checkout must not
// get the first one's view or report: the view record names the run's kit and wins over the
// caller's. A record without `kit` (an older kit's) keeps the caller's, and so does one whose `kit`
// is not an absolute path to a checkout with `bin/sandcastle` (a hostile clone can force-add the
// record, and a relative kit would run a script from inside the repo). The fake `herdr` logs
// every call; no Herdr, no network.
//
//   pnpm test:file test/herdr-view-kit.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"%s"}}}\\n' "$3" "$FAKE_PANE_TAB" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"%s"}]}}}\\n' "$FAKE_FG" ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"w1:t2","workspace_id":"w1"},"root_pane":{"pane_id":"w1:t2-1"}}}' ;;
  *) echo '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-viewkit-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const log = join(mkdtempSync(join(tmpdir(), "sandcastle-viewkit-log-")), "calls.log");
Object.assign(process.env, {
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  FAKE_LOG: log,
  FAKE_PANE_TAB: "w1:t2",
  FAKE_FG: "-zsh",
  HERDR_ENV: "1",
  XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-viewkit-cache-")),
});
// The harness may itself run in Herdr: a socket or pane of its own would change what is recorded.
delete process.env.HERDR_SOCKET_PATH;
delete process.env.HERDR_PANE_ID;
const { openSandboxView, restartStatusView, statusCommand, tellDeadTab, viewRecord } = await import("../src/herdr.ts");
const { KIT } = await import("../src/sandbox.ts");

const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] };
const kitAt = (dir: string) => {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin/sandcastle"), "#!/bin/sh\n");
  return dir;
};
const RUN_KIT = kitAt(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-viewkit-run-"))));
const CALLER_KIT = "/the/plugin/kit";
const typed = () => readFileSync(log, "utf8").trim().split("\n").filter((c) => c.startsWith("pane run "));
const project = (view: object) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-viewkit-project-")));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(viewRecord(root), JSON.stringify(view) + "\n");
  writeFileSync(log, "");
  return root;
};

test("openSandboxView records the kit it was started from", () => {
  const root = project(OWN);
  (process.stdout as { isTTY?: boolean }).isTTY = false;
  openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => ({}), "none");
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).kit, KIT);
});

test("a restarted status view runs the record's kit, not the caller's", () => {
  const root = project({ ...OWN, kit: RUN_KIT });
  assert.equal(restartStatusView(root, CALLER_KIT), true);
  assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${root}' && '${RUN_KIT}/bin/sandcastle' status`]);
});

test("a dead tab's report runs the record's kit, not the caller's", () => {
  const root = project({ ...OWN, kit: RUN_KIT });
  assert.equal(tellDeadTab(root, CALLER_KIT), "reported");
  assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${root}' && '${RUN_KIT}/bin/sandcastle' report`]);
});

test("a record without a kit keeps the caller's", () => {
  const restart = project(OWN);
  assert.equal(restartStatusView(restart, CALLER_KIT), true);
  assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${restart}' && '${CALLER_KIT}/bin/sandcastle' status`]);
  const dead = project(OWN);
  assert.equal(tellDeadTab(dead, CALLER_KIT), "reported");
  assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${dead}' && '${CALLER_KIT}/bin/sandcastle' report`]);
});

test("a record's kit that is relative, has no bin/sandcastle or is not a path falls back to the caller's", () => {
  for (const kit of [".", "kit", "../kit", join(tmpdir(), "sandcastle-viewkit-missing"), 1]) {
    const restart = project({ ...OWN, kit });
    assert.equal(restartStatusView(restart, CALLER_KIT), true, String(kit));
    assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${restart}' && '${CALLER_KIT}/bin/sandcastle' status`], String(kit));
    const dead = project({ ...OWN, kit });
    assert.equal(tellDeadTab(dead, CALLER_KIT), "reported", String(kit));
    assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${dead}' && '${CALLER_KIT}/bin/sandcastle' report`], String(kit));
  }
});

test("a relative kit is not run even when the project has a bin/sandcastle of its own", () => {
  const root = project({ ...OWN, kit: "." });
  kitAt(root);
  assert.equal(restartStatusView(root, CALLER_KIT), true);
  assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${root}' && '${CALLER_KIT}/bin/sandcastle' status`]);
});

test("a kit path with $, a backtick, a double or a single quote reaches the shell quoted", () => {
  const kit = kitAt(realpathSync(mkdtempSync(join(tmpdir(), 'sandcastle-viewkit-$HOME`id`"it\'s-'))));
  const quoted = `'${kit.replaceAll("'", "'\\''")}/bin/sandcastle'`;
  const restart = project({ ...OWN, kit });
  assert.equal(restartStatusView(restart, CALLER_KIT), true);
  assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${restart}' && ${quoted} status`]);
  const dead = project({ ...OWN, kit });
  assert.equal(tellDeadTab(dead, CALLER_KIT), "reported");
  assert.deepEqual(typed(), [`pane run w1:t2-1 cd '${dead}' && ${quoted} report`]);
});

test("the status command quotes a kit with $ for a shell", () => {
  assert.equal(statusCommand("/a/$HOME/kit"), "'/a/$HOME/kit/bin/sandcastle' status");
});
