// Which tab a run lays its view out in: it adopts the tab it is alone in only from a terminal.
// An agent that starts the run (or a detached run) has no terminal, and used to get the status
// view split beside it, in the tab it was working in. The decision as a pure function, then the
// view against a fake `herdr` on PATH: no Herdr, no Docker.
//
//   pnpm test:file test/herdr-adopt.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// A lone tab (one pane), and `tab create` answering with a tab and its root pane.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '%s\\n' '{"result":{"pane":{"tab_id":"t1","workspace_id":"w1"}}}' ;;
  "tab get") printf '%s\\n' '{"result":{"tab":{"pane_count":1,"label":"3"}}}' ;;
  "pane layout") printf '%s\\n' '{"result":{"layout":{"panes":[{"pane_id":"p1","rect":{"width":200}}]}}}' ;;
  "pane split") printf '%s\\n' '{"result":{"pane":{"pane_id":"p2"}}}' ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"t9","workspace_id":"w1"},"root_pane":{"pane_id":"p9"}}}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-adopt-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-adopt-cache-"));
const { adoptsTab, openSandboxView } = await import("../src/herdr.ts");

test("alone in the tab and in a terminal: adopt it", () => {
  assert.equal(adoptsTab(true, true), true);
});

test("alone in the tab but with no terminal: a tab of its own", () => {
  assert.equal(adoptsTab(true, false), false);
});

test("not alone: a tab of its own, terminal or not", () => {
  assert.equal(adoptsTab(false, true), false);
  assert.equal(adoptsTab(false, false), false);
});

const open = (tty: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-adopt-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  (process.stdout as { isTTY?: boolean }).isTTY = tty;
  const view = openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => ({}), "none");
  return { view, calls: readFileSync(log, "utf8").split("\n") };
};

test("an agent's run (no terminal) in a lone tab makes a tab of its own and leaves the agent's tab alone", () => {
  const { view, calls } = open(false);
  assert.ok(calls.some((c) => c.startsWith("tab create --workspace w1 --label sandcastle shop")), calls.join("\n"));
  assert.equal(calls.some((c) => c.startsWith("pane split p1")), false, "nothing is split beside the caller");
  assert.equal(calls.some((c) => c.startsWith("tab rename t1") || c.startsWith("pane rename p1")), false, "the caller's tab and pane keep their names");
  // The status view is the new tab's first pane.
  assert.equal(view.status, "p9");
  assert.equal(view.tab, "t9");
  assert.ok(calls.some((c) => c.startsWith("pane run p9 ") && c.includes("status")), calls.join("\n"));
});

test("a person's run (a terminal) in a lone tab adopts it", () => {
  const { view, calls } = open(true);
  assert.ok(calls.some((c) => c.startsWith("pane split p1 ")), calls.join("\n"));
  assert.equal(calls.some((c) => c.startsWith("tab create")), false);
  assert.equal(view.tab, "t1");
});
