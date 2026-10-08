// The run's Herdr status pane going away mid-run (closed by a person, moved to another tab, lost to a
// Herdr hiccup) is no broken view: with no sandbox panes the workspace's token and the end
// notification still go, and the run says once, in words, that the pane closed. Any other herdr error
// still turns the view off once, with Herdr's own message and not its JSON.
// A fake `herdr` on PATH answers by the mode in $FAKE_MODE and logs every call: no Herdr, no Docker.
//
//   pnpm test:file test/herdr-status-pane-closed.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { TicketRecord } from "../mod/hooks/run-record.ts";
import type { Project } from "../src/config.ts";
import type { SandboxPanes } from "../src/herdr.ts";
import { quietly } from "./quiet.ts";

// `gone`: the status pane (p9) is answered as Herdr answers a closed pane, for a report about it;
// `broken`: the same calls fail with another error; `garbled`: with words over two lines, not JSON.
// Anything else is answered as usual.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
mode=$(cat "$FAKE_MODE")
case "$1 $2" in
  "pane get") printf '%s\\n' '{"result":{"pane":{"tab_id":"t1","workspace_id":"w1"}}}' ;;
  "tab get") printf '%s\\n' '{"result":{"tab":{"pane_count":1,"label":"3"}}}' ;;
  "pane split")
    if [ "$3" = p9 ] && [ "$mode" = gone ]; then
      printf '%s\\n' '{"error":{"code":"pane_not_found","message":"pane p9 not found"}}' >&2
      exit 1
    fi
    printf '%s\\n' '{"result":{"pane":{"pane_id":"p20"}}}' ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"t9","workspace_id":"w1"},"root_pane":{"pane_id":"p9"}}}' ;;
  "pane report-agent"|"pane report-metadata")
    if [ "$3" = p9 ] && [ "$mode" = gone ]; then
      printf '%s\\n' '{"error":{"code":"pane_not_found","message":"pane p9 not found"}}' >&2
      exit 1
    fi
    if [ "$3" = p9 ] && [ "$mode" = broken ]; then
      printf '%s\\n' '{"error":{"code":"server_busy","message":"the server is busy"}}' >&2
      exit 1
    fi
    if [ "$3" = p9 ] && [ "$mode" = garbled ]; then
      printf '%s\\n' 'thread main panicked' 'at src/server.rs:12' >&2
      exit 1
    fi
    printf '%s\\n' '{}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-statusgone-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const mode = join(bin, "mode");
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
process.env.FAKE_MODE = mode;
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-statusgone-cache-"));
// Not a terminal, as a detached run: the view is a tab of its own, its first pane the status view (p9).
(process.stdout as { isTTY?: boolean }).isTTY = false;
const { openSandboxView, viewRecord } = await import("../src/herdr.ts");

const open = async (answer: "ok" | "gone" | "broken" | "garbled", panes: SandboxPanes = "none") => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-statusgone-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  writeFileSync(mode, "ok");
  process.env.FAKE_LOG = log;
  const tickets: Record<string, TicketRecord> = { "12": { state: "implement" } };
  const { result: view } = await quietly(() => openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => tickets, panes));
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const say = (fn: () => void) => quietly(fn).then((r) => r.lines);
  return { root, view, calls, say, answer: () => writeFileSync(mode, answer) };
};
const spaceTokens = (calls: string[]) => calls.filter((c) => c.startsWith("workspace report-metadata w1"));

test("a status pane herdr no longer has leaves the workspace's token and the end notification going, and is told once without JSON", async () => {
  const run = await open("gone");
  run.answer();
  const first = await run.say(() => run.view.phase("12", "implement"));
  assert.deepEqual(first, ["Herdr status pane closed - `sandcastle status` shows the run."]);
  const before = spaceTokens(run.calls()).length;
  assert.ok(before >= 1, "the workspace token of the call that found the pane gone is still sent");
  const later = await run.say(() => {
    run.view.refresh();
    run.view.phase("12", "review");
    run.view.close("merged 0 of 1");
  });
  assert.deepEqual(later, [], "said once");
  assert.equal(spaceTokens(run.calls()).length, before + 3, "every later call re-sends the workspace token");
  assert.ok(run.calls().some((c) => c.startsWith("notification show Sandcastle shop --body merged 0 of 1")), run.calls().join("\n"));
  const statusCalls = run.calls().filter((c) => /^pane report-(agent|metadata) p9/.test(c));
  assert.equal(statusCalls.length, 1, "nothing more is sent to the closed pane");
  assert.equal(JSON.parse(readFileSync(viewRecord(run.root), "utf8")).status, undefined, "the record forgets the pane");
});

test("another herdr error turns the view off once, in one line with herdr's message", async () => {
  const run = await open("broken");
  run.answer();
  const first = await run.say(() => run.view.phase("12", "implement"));
  assert.deepEqual(first, ["Herdr sandbox view off for this run (the server is busy)."]);
  const before = run.calls().length;
  const later = await run.say(() => {
    run.view.phase("12", "review");
    run.view.close("merged 0 of 1");
  });
  assert.deepEqual(later, []);
  assert.equal(run.calls().length, before, "no herdr call after the view went off");
});

test("an error herdr gives in words over several lines is told on one", async () => {
  const run = await open("garbled");
  run.answer();
  const said = await run.say(() => run.view.phase("12", "implement"));
  assert.deepEqual(said, ["Herdr sandbox view off for this run (thread main panicked at src/server.rs:12)."]);
});

const CLOSED = "Herdr status pane closed - `sandcastle status` shows the run.";

test("a status pane found closed by the first sandbox pane's split is told as closed, not as a broken view", async () => {
  const run = await open("gone", "all");
  run.answer();
  const claimed = await run.say(() => run.view.claim("12", "a ticket"));
  assert.deepEqual(claimed, [CLOSED]);
  assert.equal(run.calls().filter((c) => c.startsWith("pane split")).length, 1, "the one split that found the pane gone");
  const later = await run.say(() => {
    run.view.claim("13", "another");
    run.view.refresh();
    run.view.close("merged 0 of 2");
  });
  assert.deepEqual(later, [], "said once; no further split, no view off");
  assert.equal(run.calls().filter((c) => c.startsWith("pane split")).length, 1);
  assert.equal(run.calls().filter((c) => c.startsWith("tab create")).length, 1, "no status pane is reopened");
  assert.ok(spaceTokens(run.calls()).length >= 2, "the workspace token is still sent");
  assert.ok(run.calls().some((c) => c.startsWith("notification show Sandcastle shop --body merged 0 of 2")), run.calls().join("\n"));
});
