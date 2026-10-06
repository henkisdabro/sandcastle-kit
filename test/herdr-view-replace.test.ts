// A run replaces the previous run's Herdr view rather than stacking another (src/herdr.ts). A status
// pane a person moved out of the previous run's tab outlived the tab's close, or the tab was already
// gone and its close threw, which skipped every pane close: the old view stayed open beside the new
// one. The record's panes are now closed by id after the tab, the status pane only while it is still
// the recorded terminal (Herdr reuses pane ids across a restart). A fake `herdr` on PATH; no Herdr.
//
//   node --test test/herdr-view-replace.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Logs every call. `pane get` of the old status pane answers with $FAKE_OLD_TERM; a `tab close` of
// the old tab fails as Herdr does for a closed tab when $FAKE_TAB_GONE is set. Plain bash 3.2.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get")
    if [ "$3" = "pOld" ]; then printf '{"result":{"pane":{"tab_id":"t1","workspace_id":"w1","terminal_id":"%s"}}}\\n' "$FAKE_OLD_TERM"
    else printf '%s\\n' '{"result":{"pane":{"tab_id":"t1","workspace_id":"w1","terminal_id":"term_new"}}}'; fi ;;
  "tab close")
    if [ -n "\${FAKE_TAB_GONE:-}" ]; then echo '{"error":{"code":"tab_not_found","message":"tab not found"}}' >&2; exit 1; fi
    printf '%s\\n' '{}' ;;
  "tab get") printf '%s\\n' '{"result":{"tab":{"pane_count":2,"label":"work"}}}' ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"t3","workspace_id":"w1"},"root_pane":{"pane_id":"p3"}}}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-herdr-replace-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-herdr-replace-cache-"));
// IN_HERDR is read when the module loads, so the environment comes first.
const { openSandboxView, viewRecord } = await import("../src/herdr.ts");

/** Opens a view over a previous run's record (its tab tOld, its status pane pOld in terminal term_old); returns herdr's calls. */
const replace = ({ tabGone = false, paneTerminal = "term_old" } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-herdr-replace-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(viewRecord(root), JSON.stringify({ tab: "tOld", adopted: false, status: "pOld", terminal_id: "term_old", panes: ["pSandbox"] }));
  const log = join(root, "herdr-calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  process.env.FAKE_OLD_TERM = paneTerminal;
  if (tabGone) process.env.FAKE_TAB_GONE = "1";
  else delete process.env.FAKE_TAB_GONE;
  openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => ({}));
  return readFileSync(log, "utf8").split("\n");
};

test("a status pane moved out of the previous run's tab is closed with the tab", () => {
  const calls = replace();
  assert.ok(calls.includes("tab close tOld"), calls.join("\n"));
  assert.ok(calls.includes("pane close pOld"), "the moved status pane is closed too");
  assert.ok(calls.includes("pane close pSandbox"));
  assert.ok(!calls.includes("pane close p1"), "never the pane the run is typed in");
});

test("a previous tab that is already gone still has its status pane closed", () => {
  const calls = replace({ tabGone: true });
  assert.ok(calls.includes("tab close tOld"));
  assert.ok(calls.includes("pane close pOld"), "the close of a gone tab no longer skips the panes");
});

test("a status pane id that now holds another terminal is left alone", () => {
  const calls = replace({ tabGone: true, paneTerminal: "term_someone_else" });
  assert.ok(!calls.includes("pane close pOld"), "Herdr reused the id after a restart: not ours to close");
});
