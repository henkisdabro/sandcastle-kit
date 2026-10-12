// Herdr finds the status view in a pane by the pane's command line: the run's pane reuse (Ctrl-C, then wait for
// a shell), a dead run's tab (a pane still showing the view gets no report) and the restart (a pane still showing
// it is left alone) all go by it. Whichever view status.sh runs - its own, or the TypeScript one it `exec`s when
// the switch says ts - is the command line Herdr sees. Here the real view runs on a pty, started through
// status.sh, and a fake `herdr` answers `pane process-info` with that process's command line from `ps` and
// `pane send-keys ... ctrl+c` with an INT to it, as the terminal would. No Herdr, no Docker, no network.
//
//   pnpm test:file test/herdr-status-pane.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";
import { buildFixture } from "./status-fixture.ts";
import { needsScript, startSession } from "./status-run.ts";

// `pane get pOld` answers in the record's own tab and terminal; `pane process-info` with the view's command line
// while it runs (a zombie or no process is a bare shell); `pane send-keys` sends the view INT. Plain bash 3.2.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get")
    if [ "$3" = "pOld" ]; then printf '%s\\n' '{"result":{"pane":{"tab_id":"tOld","workspace_id":"w1","terminal_id":"term_old"}}}'
    else printf '%s\\n' '{"result":{"pane":{"tab_id":"tMine","workspace_id":"w1","terminal_id":"term_mine"}}}'; fi ;;
  "pane process-info")
    cmd=$(ps -o command= -p "$FAKE_VIEW_PID" 2>/dev/null)
    case "$cmd" in ""|*defunct*) cmd="-zsh" ;; esac
    cmd=$(printf '%s' "$cmd" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
    printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"%s"}]}}}\\n' "$cmd" ;;
  "pane send-keys") kill -INT "$FAKE_VIEW_PID"; printf '%s\\n' '{}' ;;
  "tab get") printf '%s\\n' '{"result":{"tab":{"pane_count":2,"label":"work"}}}' ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"tCreated","workspace_id":"w1"},"root_pane":{"pane_id":"pCreated"}}}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-herdr-status-pane-")));
const bin = join(TMP, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const log = join(TMP, "herdr-calls.log");
Object.assign(process.env, {
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  FAKE_LOG: log,
  HERDR_ENV: "1",
  HERDR_PANE_ID: "p1",
  XDG_CACHE_HOME: join(TMP, "cache"),
  // The view is started through status.sh, which picks the view itself from the switch in the view's environment.
  SANDCASTLE_TEST_STATUS_IMPL: "bash",
});
delete process.env.HERDR_SOCKET_PATH;
delete process.env.HERDR_WORKSPACE_ID;
(process.stdout as { isTTY?: boolean }).isTTY = false;
// IN_HERDR is read when the module loads, so the environment comes first.
const { openSandboxView, restartStatusView, tellDeadTab, viewRecord, STATUS_COMMAND } = await import("../src/herdr.ts");

const fixture = buildFixture("legacy", join(TMP, "fixture"));
after(() => {
  fixture.stop();
  rmSync(TMP, { recursive: true, force: true });
});

const RECORD = { tab: "tOld", adopted: false, status: "pOld", terminal_id: "term_old", panes: [] };
const record = () => JSON.parse(readFileSync(viewRecord(fixture.root), "utf8"));
const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);

for (const [view, file] of [["bash", "status.sh"], ["ts", "status-view.ts"]] as const) {
  test(`the ${view} view in the status pane is seen as the view: not reported over, not restarted, stopped and reused`, needsScript, async () => {
    writeFileSync(viewRecord(fixture.root), JSON.stringify(RECORD) + "\n");
    writeFileSync(log, "");
    const session = await startSession(fixture, { env: { SANDCASTLE_TEST_STATUS_IMPL: view === "ts" ? "ts" : "", HERDR_ENV: "1", HERDR_PANE_ID: "pOld" } });
    try {
      await session.frame();
      process.env.FAKE_VIEW_PID = String(session.pid);
      const command = spawnSync("ps", ["-o", "command=", "-p", String(session.pid)], { encoding: "utf8" }).stdout;
      assert.ok(command.includes(file), `status.sh runs the ${view} view: ${command}`);

      // A dead run's tab whose pane still shows the view: no report typed, the record left for later.
      assert.equal(tellDeadTab(fixture.root, "/the/kit"), "showing");
      // A live run's: the view is not typed in again over itself.
      assert.equal(restartStatusView(fixture.root, "/the/kit"), false);
      assert.deepEqual(calls().filter((c) => c.startsWith("pane run ") || c.startsWith("pane send-keys ")), []);

      // A new run reuses the pane: the view is stopped by Ctrl-C, with no quit mark, and the pane gets the new view.
      openSandboxView({ root: fixture.root, name: "shop" } as Project, 1, (id) => `#${id}`, () => ({}));
      const ended = await session.ended("the reuse's Ctrl-C");
      assert.equal(ended.status, 130);
      assert.ok(calls().includes("pane send-keys pOld ctrl+c"));
      assert.ok(calls().includes(`pane run pOld cd '${fixture.root}' && ${STATUS_COMMAND}`), calls().join("\n"));
      assert.ok(!calls().some((c) => c.startsWith("tab create")), "the pane was replaced, not reused");
      assert.equal(record().status, "pOld");
      assert.equal(record().quit, undefined, "the stopped view marked the reused pane quit");
    } finally {
      session.close();
    }
  });
}
