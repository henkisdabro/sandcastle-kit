// The Herdr TUI sidebar and run agent (openSandboxView, src/herdr.ts) count a ticket a later autonomy turn re-runs by
// itself as `later`, not as needing a person - while the view is open. The closed view's last report has no retried set:
// it cannot know whether another turn follows. Against a fake `herdr` on PATH; no Herdr, no Docker.
//
//   pnpm test:file test/herdr-retried-sidebar.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { TicketRecord } from "../mod/hooks/run-record.ts";
import type { Project } from "../src/config.ts";

const FAKE = `#!/usr/bin/env bash
printf '%s\\037' "$@" >> "$FAKE_LOG"; printf '\\n' >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '%s\\n' '{"result":{"pane":{"tab_id":"t1","workspace_id":"w1"}}}' ;;
  "tab get") printf '%s\\n' '{"result":{"tab":{"pane_count":1,"label":"3"}}}' ;;
  "pane layout") printf '%s\\n' '{"result":{"layout":{"panes":[{"pane_id":"p1","rect":{"width":200}}]}}}' ;;
  "pane split") printf '%s\\n' '{"result":{"pane":{"pane_id":"p2"}}}' ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"t9","workspace_id":"w1"},"root_pane":{"pane_id":"p9"}}}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-retried-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-retried-cache-"));
const { lineText, openSandboxView, runCounts } = await import("../src/herdr.ts");

const tickets: Record<string, TicketRecord> = { a: { state: "not landed" }, b: { state: "merged" } };

/** An open view with no sandbox panes (the run is one agent), its calls to herdr since the call that follows. */
const open = (retried?: () => ReadonlySet<string>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-retried-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  (process.stdout as { isTTY?: boolean }).isTTY = false;
  const view = openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => tickets, "none", () => undefined, () => false, retried);
  writeFileSync(log, "");
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\u001f").slice(0, -1));
  return { view, calls };
};
const messageOf = (calls: string[][]) => {
  const agent = calls.filter((c) => c[0] === "pane" && c[1] === "report-agent").at(-1)!;
  const token = calls.filter((c) => c[0] === "workspace" && c[1] === "report-metadata").at(-1)!;
  return { state: agent[agent.indexOf("--state") + 1], message: agent[agent.indexOf("--message") + 1], token: token[token.indexOf("--token") + 1] };
};

test("with a retried closure naming the ticket: the run agent and the sidebar token have no needs-you count", () => {
  const { view, calls } = open(() => new Set(["a"]));
  view.landed("a", true, "failed to land");
  const said = messageOf(calls());
  assert.equal(said.message, "1/2");
  assert.equal(said.token, "sandcastle=♜ 1/2");
  assert.equal(lineText("shop", runCounts(tickets, false, new Set(["a"]))), "shop 1/2");
});

test("with no retried closure: the same ticket needs you, as before", () => {
  const { view, calls } = open();
  view.landed("a", false, "failed to land");
  const said = messageOf(calls());
  assert.equal(said.message, "1/2 · 1 needs you");
  assert.equal(said.token, "sandcastle=♜ 1/2 · 1 needs you");
});

test("the closed view's last report uses no retried set: blocked, as it needs you", () => {
  const { view, calls } = open(() => new Set(["a"]));
  view.close("1 merged, 1 not landed");
  const said = messageOf(calls());
  assert.equal(said.state, "blocked");
  assert.equal(said.message, "1/2 · 1 needs you");
  assert.equal(said.token, "sandcastle=♜ 1/2 · 1 needs you");
});
