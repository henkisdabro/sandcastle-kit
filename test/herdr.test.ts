// An adopted Herdr tab keeps an operator's label, and each sandbox reports its ticket,
// step and time to the sidebar (src/herdr.ts), against a fake `herdr` on PATH: no
// Herdr, no Docker.
//
//   node --test test/herdr.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import type { TicketRecord } from "../mod/hooks/run-record.ts";

// Answers only what openSandboxView asks of an adopted, lone tab; logs every call.
// Plain bash 3.2: no associative arrays, no mapfile.
const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
# A pane the operator closed by hand: Herdr's error, on stderr, for any call about it.
if [ -n "\${FAKE_GONE:-}" ] && [ "$3" = "$FAKE_GONE" ]; then
  echo '{"error":{"code":"pane_not_found","message":"pane not found"}}' >&2; exit 1
fi
case "$1 $2" in
  "pane get") printf '%s\\n' '{"result":{"pane":{"tab_id":"t1","workspace_id":"w1"}}}' ;;
  "tab get") printf '{"result":{"tab":{"pane_count":1,"label":"%s"}}}\\n' "$FAKE_LABEL" ;;
  "pane layout") printf '%s\\n' '{"result":{"layout":{"panes":[{"pane_id":"p1","rect":{"width":200}}]}}}' ;;
  "pane split") printf '%s\\n' '{"result":{"pane":{"pane_id":"p2"}}}' ;;
  *) printf '%s\\n' '{}' ;;
esac
`;

const bin = mkdtempSync(join(tmpdir(), "sandcastle-herdr-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
// A run adopts a lone tab only from a terminal (src/herdr.ts), and the test runner's stdout is a pipe.
(process.stdout as { isTTY?: boolean }).isTTY = true;
// Nothing in the view writes under the cache directory now (the run does, live-runs.ts); the run-file test sets its own.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-herdr-cache-"));
// IN_HERDR is read when the module loads, so the environment comes first.
const { askingInPane, defaultTabLabel, elapsed, lineText, openSandboxView, runCounts, sandboxTokens, spaceText, tokenArgs } = await import(
  "../src/herdr.ts"
);

const adopt = (label: string, tickets: () => Record<string, TicketRecord> = () => ({})) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-herdr-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const log = join(root, "herdr-calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  process.env.FAKE_LABEL = label;
  const view = openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, tickets);
  const calls = () => readFileSync(log, "utf8").split("\n");
  return Object.assign(calls(), { view, calls, root });
};

test("defaultTabLabel: only Herdr's bare-number label counts as default", () => {
  for (const label of [undefined, "", "1", "12"]) assert.equal(defaultTabLabel(label), true, String(label));
  for (const label of ["sandcastle shop", "sandcastle shop run 4", "build"]) assert.equal(defaultTabLabel(label), false, label);
});

test("an adopted tab with an operator's label is not renamed", () => {
  const calls = adopt("sandcastle shop run 4");
  assert.equal(calls.some((c) => c.startsWith("tab rename")), false);
  assert.ok(calls.includes("pane rename p1 sandcastle run shop"));
});

test("an adopted tab with Herdr's default label is renamed", () => {
  const calls = adopt("3");
  assert.ok(calls.includes("tab rename t1 sandcastle shop"));
  assert.ok(calls.includes("pane rename p1 sandcastle run shop"));
});

test("the status view splits off at its ratio, and focus stays where the operator left it", () => {
  const calls = adopt("3");
  // The fake pane is 200 columns wide: the status view goes right, the run pane keeps 25%.
  assert.ok(calls.some((c) => c.startsWith("pane split p1 --direction right --ratio 0.25")), calls.join("\n"));
  // A run works in the background: switching tabs pulled the operator out of whatever they were doing.
  assert.equal(calls.some((c) => c.includes("focus") && !c.includes("--no-focus")), false, calls.join("\n"));
});

test("runCounts: the status view's groups, so the sidebar and the grid never disagree", () => {
  const t = (state: TicketRecord["state"]): TicketRecord => ({ state });
  const counts = runCounts({ a: t("implement"), b: t("gates"), c: t("conflict"), d: t("crashed"), e: t("merged"), f: t("queued"), g: t("red"), h: t("nochange") });
  assert.deepEqual(counts, { working: 2, needsYou: 3, merged: 1, total: 8 });
});

test("the workspace row says what needs you first; the tab bar names the run", () => {
  assert.equal(spaceText({ working: 2, needsYou: 1, merged: 4, total: 9 }), "♜ 4/9 · 1 needs you");
  assert.equal(spaceText({ working: 2, needsYou: 0, merged: 4, total: 9 }), "♜ 4/9 · 2 working");
  assert.equal(spaceText({ working: 0, needsYou: 0, merged: 9, total: 9 }), "♜ 9/9");
  assert.equal(lineText("shop", { working: 2, needsYou: 1, merged: 4, total: 9 }), "shop 4/9 · 2 working · 1 needs you");
  // About 22 columns of sidebar: the usual case has to fit.
  assert.ok([...spaceText({ working: 0, needsYou: 3, merged: 12, total: 20 })].length <= 22);
});

test("tokens: a step has a clock, an outcome clears it", () => {
  assert.equal(elapsed(59_000), "0m");
  assert.equal(elapsed(12 * 60_000), "12m");
  assert.equal(elapsed(65 * 60_000), "1h05m");
  assert.deepEqual(sandboxTokens("shop", "review", 0, 3 * 60_000), { sc_run: "shop", sc_phase: "review", sc_elapsed: "3m" });
  assert.deepEqual(tokenArgs(sandboxTokens("shop", "merged", undefined, 0)), ["--token", "sc_run=shop", "--token", "sc_phase=merged", "--clear-token", "sc_elapsed"]);
});

test("a sandbox's row is named after its ticket and carries its step; the workspace carries the run", () => {
  const tickets: Record<string, TicketRecord> = { "12": { state: "queued" }, "13": { state: "queued" } };
  const run = adopt("3", () => tickets);
  tickets["12"] = { state: "review" };
  run.view.claim("12", "Add CSV export");
  run.view.phase("12", "review");
  let calls = run.calls();
  const meta = calls.filter((c) => c.startsWith("pane report-metadata p2"));
  assert.ok(meta.at(-1)?.includes("--display-agent #12 Add CSV export"), meta.join("\n"));
  assert.ok(meta.at(-1)?.includes("--token sc_run=shop --token sc_phase=review --token sc_elapsed=0m"), meta.join("\n"));
  // The step stands in for "working" wherever Herdr shows a state's text, and it all expires
  // unless re-sent, so a killed run leaves nothing behind for long.
  assert.ok(meta.at(-1)?.includes("--state-label working=review · 0m"), meta.join("\n"));
  assert.ok(meta.at(-1)?.endsWith("--ttl-ms 150000"), meta.join("\n"));
  assert.ok(calls.includes("workspace report-metadata w1 --source sandcastle-kit --token sandcastle=♜ 0/2 · 1 working --ttl-ms 150000"), calls.join("\n"));
  // A red branch is a finished result: idle, its outcome in place of the step, no clock.
  tickets["12"] = { state: "red" };
  run.view.finish("12", "red");
  calls = run.calls();
  assert.ok(calls.some((c) => c.startsWith("pane report-agent p2") && c.includes("--state idle --message red")), calls.join("\n"));
  assert.ok(calls.filter((c) => c.startsWith("pane report-metadata p2")).at(-1)?.includes("--token sc_phase=red --clear-token sc_elapsed"));
  assert.ok(calls.includes("workspace report-metadata w1 --source sandcastle-kit --token sandcastle=♜ 0/2 · 1 needs you --ttl-ms 150000"), calls.join("\n"));
  // Landing that needs a human turns the same pane blocked.
  run.view.landed("12", false, "merge conflict");
  assert.ok(run.calls().some((c) => c.startsWith("pane report-agent p2") && c.includes("--state blocked --message merge conflict")));
  run.view.close("merged 0 of 2");
});

test("a sandbox pane closed by hand is forgotten, and the view keeps reporting", () => {
  const tickets: Record<string, TicketRecord> = { "12": { state: "implement" } };
  const run = adopt("3", () => tickets);
  run.view.claim("12", "Add CSV export");
  process.env.FAKE_GONE = "p2";
  const said: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    run.view.phase("12", "review");
  } finally {
    console.log = log;
    delete process.env.FAKE_GONE;
  }
  assert.deepEqual(said, [], "no 'view off' warning for one closed pane");
  // The view is still on: the workspace goes on hearing about the run.
  run.view.landed("12", true, "merged");
  assert.ok(run.calls().filter((c) => c.startsWith("workspace report-metadata")).length >= 2, run.calls().join("\n"));
});

test("askingInPane: the run's pane reads as blocked while it waits for an answer, then is released", async () => {
  const log = mkdtempSync(join(tmpdir(), "sandcastle-herdr-ask-"));
  process.env.FAKE_LOG = join(log, "calls.log");
  writeFileSync(process.env.FAKE_LOG, "");
  const answer = await askingInPane("asks whether to run 2 ticket(s) again", async () => {
    const during = readFileSync(process.env.FAKE_LOG!, "utf8");
    assert.match(during, /^pane report-agent p1 --source sandcastle-kit --agent sandcastle --state blocked --message asks whether/m);
    return true;
  });
  assert.equal(answer, true);
  assert.match(readFileSync(process.env.FAKE_LOG, "utf8"), /^pane release-agent p1 --source sandcastle-kit --agent sandcastle$/m);
});
