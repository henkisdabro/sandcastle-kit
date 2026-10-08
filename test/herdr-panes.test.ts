// Sandbox panes are off by default: the run's tab holds the status view alone, and the run is
// one agent on that pane - working while tickets work, blocked or idle at the end. `all` keeps a
// pane per sandbox. Against a fake `herdr` on PATH that records its calls: no Herdr, no Docker.
//
//   pnpm test:file test/herdr-panes.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { loadProject, type Project } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";
import type { TicketRecord } from "../mod/hooks/run-record.ts";

const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '%s\\n' '{"result":{"pane":{"tab_id":"t1","workspace_id":"w1"}}}' ;;
  "tab get") printf '%s\\n' '{"result":{"tab":{"pane_count":1,"label":"3"}}}' ;;
  "pane split") printf '%s\\n' '{"result":{"pane":{"pane_id":"p2"}}}' ;;
  "tab create") printf '%s\\n' '{"result":{"tab":{"tab_id":"t9","workspace_id":"w1"},"root_pane":{"pane_id":"p9"}}}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-panes-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-panes-cache-"));
// Not a terminal, as a detached run: the view is a tab of its own, its first pane the status view.
(process.stdout as { isTTY?: boolean }).isTTY = false;
const { openSandboxView, runAgent, sandboxPanes } = await import("../src/herdr.ts");

const open = (mode: "none" | "all", tickets: () => Record<string, TicketRecord>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-panes-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  const view = openSandboxView({ root, name: "shop" } as Project, 2, (id) => `#${id}`, tickets, mode);
  return { view, calls: () => readFileSync(log, "utf8").split("\n") };
};

test("panes none: no sandbox pane opens, and the run is one agent on the status pane", () => {
  const tickets: Record<string, TicketRecord> = { "12": { state: "queued" }, "13": { state: "queued" } };
  const run = open("none", () => tickets);
  tickets["12"] = { state: "implement" };
  run.view.claim("12", "Add CSV export");
  run.view.phase("12", "implement");
  let calls = run.calls();
  assert.equal(calls.some((c) => c.startsWith("pane split")), false, calls.join("\n"));
  assert.equal(calls.some((c) => c.startsWith("pane report-agent p2")), false, "no sandbox agent");
  const reported = calls.filter((c) => c.startsWith("pane report-agent p9"));
  assert.equal(reported.length, 1, "the same state is sent once, not per call");
  assert.ok(reported[0].includes("--source sandcastle-kit --agent sandcastle --state working --message 0/2 · 1 working"), reported[0]);
  const meta = calls.filter((c) => c.startsWith("pane report-metadata p9")).at(-1) ?? "";
  assert.ok(meta.includes("--agent sandcastle --title shop run --display-agent sandcastle"), meta);
  // The workspace token is #119's, unchanged.
  assert.ok(calls.includes("workspace report-metadata w1 --source sandcastle-kit --token sandcastle=♜ 0/2 · 1 working --ttl-ms 150000"), calls.join("\n"));

  // One merged, one red: while the run goes it is still working; at the end it needs you.
  tickets["12"] = { state: "merged" };
  tickets["13"] = { state: "red" };
  run.view.finish("12", "green", true);
  run.view.landed("12", true, "merged");
  assert.ok(run.calls().filter((c) => c.startsWith("pane report-agent p9")).at(-1)?.includes("--state working --message 1/2 · 1 needs you"), run.calls().join("\n"));
  run.view.close("merged 1 of 2");
  calls = run.calls();
  assert.ok(calls.filter((c) => c.startsWith("pane report-agent p9")).at(-1)?.includes("--state blocked --message 1/2 · 1 needs you"), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("notification show")), "the end-of-run notification stays");
});

test("panes none: a run that ends with nothing left to do is idle", () => {
  const tickets: Record<string, TicketRecord> = { "12": { state: "merged" } };
  const run = open("none", () => tickets);
  run.view.close("merged 1 of 1");
  assert.ok(run.calls().filter((c) => c.startsWith("pane report-agent p9")).at(-1)?.includes("--state idle --message 1/1"), run.calls().join("\n"));
});

test("runAgent: working until the end; then blocked if anything needs a person", () => {
  assert.deepEqual(runAgent({ working: 0, needsYou: 2, merged: 1, total: 3 }, false).state, "working");
  assert.deepEqual(runAgent({ working: 0, needsYou: 2, merged: 1, total: 3 }, true).state, "blocked");
  assert.deepEqual(runAgent({ working: 0, needsYou: 0, merged: 3, total: 3 }, true).state, "idle");
});

test("panes all: a pane per sandbox, as before, and the status pane is not an agent", () => {
  const tickets: Record<string, TicketRecord> = { "12": { state: "implement" } };
  const run = open("all", () => tickets);
  run.view.claim("12", "Add CSV export");
  const calls = run.calls();
  assert.ok(calls.some((c) => c.startsWith("pane split p9 --direction right")), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("pane report-agent p2") && c.includes("--state working --message setup")), calls.join("\n"));
  assert.equal(calls.some((c) => c.startsWith("pane report-agent p9")), false, calls.join("\n"));
  assert.ok(calls.includes("pane rename p2 #12 Add CSV export"));
});

test("sandboxPanes: none by default, the project's key, the environment above both", () => {
  assert.equal(sandboxPanes({}, {}), "none");
  assert.equal(sandboxPanes({ herdr: { panes: "all" } }, {}), "all");
  assert.equal(sandboxPanes({ herdr: { panes: "all" } }, { SANDBOX_PANES: "none" }), "none");
  assert.equal(sandboxPanes({}, { SANDBOX_PANES: "all" }), "all");
  assert.equal(sandboxPanes({ herdr: { panes: "all" } }, { SANDBOX_PANES: "" }), "all");
  assert.throws(() => sandboxPanes({}, { SANDBOX_PANES: "some" }), OperatorError);
});

test("the herdr.panes key takes none or all, and nothing else", async () => {
  const load = (extra: string) => {
    const root = mkdtempSync(join(tmpdir(), "sandcastle-panes-config-"));
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }], ${extra} };\n`);
    return loadProject(root);
  };
  assert.equal((await load('herdr: { panes: "all" }')).herdr?.panes, "all");
  assert.equal((await load("")).herdr, undefined);
  await assert.rejects(load('herdr: { panes: "some" }'), /`herdr\.panes` must be "none" or "all", not "some"/);
  await assert.rejects(load('herdr: { pane: "all" }'), /unknown key `herdr\.pane` - did you mean `herdr\.panes`\?/);
});
