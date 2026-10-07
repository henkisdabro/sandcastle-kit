// A run reuses the previous run's Herdr status pane when it is still there, wherever the person put
// it, instead of opening a tab at the end of the tab bar: the same terminal (Herdr reuses pane ids
// across a restart), this run's workspace, and running the old status view, the plugin's report or a
// bare shell. A person's command in it, a new terminal or another workspace means a new tab, as
// before. Stopping the old view must not leave the `quit` mark status.sh's INT trap writes when the
// record names the pane: the fake `herdr` runs that trap's own jq on the record at the Ctrl-C. A
// fake `herdr` on PATH; no Herdr.
//
//   node --test test/herdr-view-reuse.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// `pane get` of the old status pane (pOld) answers with $FAKE_OLD_TAB, $FAKE_OLD_TERM and $FAKE_OLD_WS, of
// the run's own pane (p1) with its tab tMine; `pane process-info` of pOld with $FAKE_FG until a
// `pane send-keys` reached it (then a bare shell, unless $FAKE_STUCK). The send-keys runs status.sh's
// mark_quit jq on $FAKE_RECORD, as the view's INT trap does. Plain bash 3.2.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get")
    if [ "$3" = "pOld" ]; then printf '{"result":{"pane":{"tab_id":"%s","workspace_id":"%s","terminal_id":"%s"}}}\\n' "$FAKE_OLD_TAB" "$FAKE_OLD_WS" "$FAKE_OLD_TERM"
    elif [ "$3" = "p1" ]; then printf '%s\\n' '{"result":{"pane":{"tab_id":"tMine","workspace_id":"w1","terminal_id":"term_mine"}}}'
    else printf '%s\\n' '{"result":{"pane":{"tab_id":"tNew","workspace_id":"w1","terminal_id":"term_new"}}}'; fi ;;
  "pane process-info")
    fg="$FAKE_FG"
    if [ -e "$FAKE_LOG.stopped" ] && [ -z "\${FAKE_STUCK:-}" ]; then fg="-zsh"; fi
    printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"%s"}]}}}\\n' "$fg" ;;
  "pane send-keys")
    : > "$FAKE_LOG.stopped"
    tmp="$FAKE_RECORD.quit"
    jq -c --arg pane "$3" 'select(.status == $pane) | .quit = true' "$FAKE_RECORD" > "$tmp" 2>/dev/null && [ -s "$tmp" ] && mv -f "$tmp" "$FAKE_RECORD"
    rm -f "$tmp"; cp "$FAKE_RECORD" "$FAKE_LOG.after-stop"; printf '%s\\n' '{}' ;;
  "tab get") printf '%s\\n' '{"result":{"tab":{"pane_count":2,"label":"work"}}}' ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"tCreated","workspace_id":"w1"},"root_pane":{"pane_id":"pCreated"}}}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-herdr-reuse-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-herdr-reuse-cache-"));
delete process.env.HERDR_SOCKET_PATH;
delete process.env.HERDR_WORKSPACE_ID;
(process.stdout as { isTTY?: boolean }).isTTY = false;
// Every opened view hangs an exit handler on the process; ten cases outnumber Node's default limit.
process.setMaxListeners(40);
// IN_HERDR is read when the module loads, so the environment comes first.
const { openSandboxView, viewRecord, STATUS_COMMAND } = await import("../src/herdr.ts");

type Setup = { tab?: string; term?: string; workspace?: string; fg?: string; stuck?: boolean; adopted?: boolean; recordTab?: string };
/** Opens a view over a previous run's record (own tab tOld, status pane pOld in term_old, a sandbox pane pSandbox); returns herdr's calls and the new record. */
const open = ({ tab = "tPerson", term = "term_old", workspace = "w1", fg = "bash /kit/status.sh 3", stuck = false, adopted = false, recordTab = "tOld" }: Setup = {}) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-herdr-reuse-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(viewRecord(root), JSON.stringify({ tab: recordTab, adopted, status: "pOld", terminal_id: "term_old", panes: ["pSandbox"] }));
  const log = join(root, "herdr-calls.log");
  writeFileSync(log, "");
  Object.assign(process.env, { FAKE_LOG: log, FAKE_RECORD: viewRecord(root), FAKE_OLD_TAB: tab, FAKE_OLD_TERM: term, FAKE_OLD_WS: workspace, FAKE_FG: fg });
  if (stuck) process.env.FAKE_STUCK = "1";
  else delete process.env.FAKE_STUCK;
  const view = openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => ({}));
  return { calls: readFileSync(log, "utf8").split("\n"), record: JSON.parse(readFileSync(viewRecord(root), "utf8")), view, root };
};
const created = (calls: string[]) => calls.some((c) => c.startsWith("tab create"));

test("a status pane a person moved to another tab of the workspace is reused", () => {
  const { calls, record, view, root } = open();
  assert.ok(!created(calls), calls.join("\n"));
  assert.ok(calls.includes("pane send-keys pOld ctrl+c"), "the old view is stopped");
  assert.ok(calls.includes(`pane run pOld cd '${root}' && ${STATUS_COMMAND}`), "the status command runs in that pane");
  assert.ok(!calls.includes("pane close pOld"));
  assert.ok(calls.includes("pane close pSandbox"), "the earlier run's sandbox panes are closed as before");
  assert.equal(record.status, "pOld");
  assert.equal(record.tab, "tPerson");
  assert.equal(record.adopted, true, "a tab with a person's panes is never closed whole");
  assert.equal(record.terminal_id, "term_old");
  assert.equal(view.status, "pOld");
  assert.equal(view.tab, "tPerson");
});

test("stopping the old view leaves no quit mark on the record, at the stop or after", () => {
  const { record, root } = open();
  // The record as the stopped view's trap left it: the new record written later would hide a mark.
  const stopped = JSON.parse(readFileSync(join(root, "herdr-calls.log.after-stop"), "utf8"));
  assert.equal(stopped.quit, undefined);
  assert.equal(record.quit, undefined);
});

test("a status pane still in the kit's own tab is reused there, the tab kept", () => {
  const { calls, record } = open({ tab: "tOld" });
  assert.ok(!created(calls), calls.join("\n"));
  assert.ok(!calls.includes("tab close tOld"), "the tab holds the reused pane");
  assert.ok(!calls.includes("pane close pOld"));
  assert.ok(calls.some((c) => c.startsWith("pane run pOld ")));
  assert.deepEqual([record.tab, record.status, record.adopted], ["tOld", "pOld", false]);
});

test("a status pane in a person's tab, whose recorded tab is gone, is reused and not left beside a new one", () => {
  const { calls, record } = open({ tab: "tPerson", recordTab: "tGone" });
  assert.ok(!created(calls), calls.join("\n"));
  assert.ok(!calls.includes("pane close pOld"));
  assert.deepEqual([record.tab, record.status, record.adopted], ["tPerson", "pOld", true]);
});

test("a pane already at a bare shell is reused with nothing sent to stop it", () => {
  const { calls, record } = open({ fg: "-zsh" });
  assert.ok(!created(calls));
  assert.ok(!calls.some((c) => c.startsWith("pane send-keys")));
  assert.equal(record.status, "pOld");
});

test("the plugin's report running in the pane is stopped and the pane reused", () => {
  const { calls, record } = open({ fg: "node --no-maglev /kit/src/cli.ts report" });
  assert.ok(!created(calls));
  assert.ok(calls.includes("pane send-keys pOld ctrl+c"));
  assert.equal(record.status, "pOld");
});

test("a pane whose terminal changed (Herdr restarted) is not reused: a new tab, the pane left alone", () => {
  const { calls, record } = open({ term: "term_someone_else" });
  assert.ok(created(calls));
  assert.ok(!calls.includes("pane close pOld"));
  assert.ok(!calls.some((c) => c.startsWith("pane send-keys")));
  assert.deepEqual([record.tab, record.status, record.adopted], ["tCreated", "pCreated", false]);
});

test("a pane running a person's command is not reused: replaced as before", () => {
  const { calls, record } = open({ fg: "vim notes.md" });
  assert.ok(created(calls));
  assert.ok(!calls.some((c) => c.startsWith("pane send-keys")), "their command is not interrupted");
  assert.ok(calls.includes("pane close pOld"));
  assert.equal(record.status, "pCreated");
});

test("a pane in another workspace is not reused", () => {
  const { calls, record } = open({ workspace: "w9" });
  assert.ok(created(calls));
  assert.equal(record.status, "pCreated");
});

test("a pane that does not stop is not reused", { timeout: 30_000 }, () => {
  const { calls, record } = open({ stuck: true });
  assert.ok(calls.includes("pane send-keys pOld ctrl+c"));
  assert.ok(created(calls));
  assert.equal(record.status, "pCreated");
  assert.equal(record.quit, undefined);
});
