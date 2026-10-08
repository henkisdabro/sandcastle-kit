// The plan's usage in Herdr's sidebar: the run's status pane carries an `sc_usage` token ("5h 14% · wk 93%",
// with a mark once a window is amber or red) while the run record holds a reading, and none before one.
// Against a fake `herdr` on PATH that records its calls: no Herdr, no Docker.
//
//   pnpm test:file test/herdr-usage.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { PlanUsage, TicketRecord } from "../mod/hooks/run-record.ts";
import type { Project } from "../src/config.ts";

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
const bin = mkdtempSync(join(tmpdir(), "sandcastle-herdr-usage-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-herdr-usage-cache-"));
// Not a terminal, as a detached run: the view is a tab of its own, its first pane the status view (p9).
(process.stdout as { isTTY?: boolean }).isTTY = false;
const { openSandboxView, usageText, USAGE_MARKS } = await import("../src/herdr.ts");
const { configBlock } = await import("../src/herdr-plugin.ts");

const reading = (five: number, week: number): PlanUsage => ({
  provider: "claude",
  windows: { fiveHour: { percent: five, resetsAt: 1791195000 }, week: { percent: week, resetsAt: 1791324000 } },
  at: 1791190000,
});

const open = (mode: "none" | "all", usage: () => PlanUsage | undefined) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-herdr-usage-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  const tickets: Record<string, TicketRecord> = { "12": { state: "queued" } };
  const view = openSandboxView({ root, name: "shop" } as Project, 2, (id) => `#${id}`, () => tickets, mode, usage);
  return { view, calls: () => readFileSync(log, "utf8").split("\n"), tickets };
};
const onStatusPane = (calls: string[]) => calls.filter((c) => c.startsWith("pane report-metadata p9"));

test("the text is both windows' percentages, marked by the worse band: none below 75%, ▲ from 75%, ■ from 90%", () => {
  assert.equal(usageText(reading(14, 50)), "5h 14% · wk 50%");
  assert.equal(usageText(reading(14, 74)), "5h 14% · wk 74%");
  assert.equal(usageText(reading(14, 75)), "5h 14% · wk 75% ▲");
  assert.equal(usageText(reading(89, 20)), "5h 89% · wk 20% ▲");
  assert.equal(usageText(reading(14, 93)), "5h 14% · wk 93% ■");
  assert.equal(usageText(reading(100, 100)), "5h 100% · wk 100% ■");
  assert.equal(USAGE_MARKS.normal, "");
});

test("no reading yet, or one that is no reading, is no text", () => {
  assert.equal(usageText(undefined), undefined);
  assert.equal(usageText({ provider: "claude" }), undefined);
  assert.equal(usageText({ provider: "claude", windows: { fiveHour: { percent: Number.NaN, resetsAt: 1 }, week: { percent: 5, resetsAt: 2 } }, at: 3 }), undefined);
});

test("panes none: the run's status pane gets sc_usage once a reading exists, and no token before", () => {
  let held: PlanUsage | undefined = { provider: "claude" };
  const run = open("none", () => held);
  run.tickets["12"] = { state: "implement" };
  run.view.claim("12", "Add CSV export");
  assert.equal(onStatusPane(run.calls()).some((c) => c.includes("sc_usage")), false, "waiting for the first reading: no token");
  held = reading(14, 93);
  run.view.phase("12", "implement");
  const meta = onStatusPane(run.calls()).at(-1) ?? "";
  assert.ok(meta.includes("--token sc_usage=5h 14% · wk 93% ■"), meta);
  assert.ok(meta.includes("--token sc_run=shop"), "the run's own tokens are still sent in the same call");
  assert.ok(meta.endsWith("--ttl-ms 150000"), "and it expires unless re-sent, as the rest does");
  held = reading(14, 40);
  run.view.phase("12", "review");
  assert.ok(onStatusPane(run.calls()).at(-1)?.includes("--token sc_usage=5h 14% · wk 40% --"), "the band's mark goes when the usage falls below it");
  run.view.close("merged 0 of 1");
});

test("panes all: the status pane carries the token on its own, once a reading exists", () => {
  let held: PlanUsage | undefined;
  const run = open("all", () => held);
  run.view.claim("12", "Add CSV export");
  assert.equal(run.calls().some((c) => c.includes("sc_usage")), false, "no reading: no token");
  held = reading(80, 20);
  run.view.close("merged 0 of 1");
  const calls = run.calls();
  assert.ok(calls.includes("pane report-metadata p9 --source sandcastle-kit --token sc_usage=5h 80% · wk 20% ▲ --ttl-ms 150000"), calls.join("\n"));
});

test("the plugin's sidebar block names the token, with a colour for each mark", () => {
  const block = configBlock("/opt/kit");
  const row = block.split("\n").find((l) => l.includes("$sc_usage")) ?? "";
  assert.ok(row.includes(`contains = "${USAGE_MARKS.red.trim()}"`) && row.includes(`contains = "${USAGE_MARKS.amber.trim()}"`), row);
});
