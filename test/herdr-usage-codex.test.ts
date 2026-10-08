// Codex's plan usage in Herdr's sidebar beside Claude's: with both in the run record's `usage`, the status pane's
// `sc_usage` token joins them (`claude wk 93% · codex wk 16%`), and with only Claude's it is the token it always
// was. Against a fake `herdr` on PATH that records its calls: no Herdr, no Docker.
//
//   pnpm test:file test/herdr-usage-codex.test.ts

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
const bin = mkdtempSync(join(tmpdir(), "sandcastle-herdr-usage-codex-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = "p1";
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-herdr-usage-codex-cache-"));
// Not a terminal, as a detached run: the view is a tab of its own, its first pane the status view (p9).
(process.stdout as { isTTY?: boolean }).isTTY = false;
const { openSandboxView, usageText } = await import("../src/herdr.ts");

const reading = (provider: "claude" | "codex", five: number, week: number): PlanUsage => ({
  provider,
  windows: { fiveHour: { percent: five, resetsAt: 1791195000 }, week: { percent: week, resetsAt: 1791324000 } },
  at: 1791190000,
});

test("with both providers' readings the token joins their weekly windows, marked by the worst window of either", () => {
  assert.equal(usageText([reading("claude", 14, 93), reading("codex", 30, 16)]), "claude wk 93% · codex wk 16% ■");
  assert.equal(usageText([reading("claude", 14, 50), reading("codex", 30, 16)]), "claude wk 50% · codex wk 16%");
  assert.equal(usageText([reading("claude", 14, 75), reading("codex", 30, 16)]), "claude wk 75% · codex wk 16% ▲");
  // The 5-hour window is not in the text, but it still sets the mark: Codex's spent one shows.
  assert.equal(usageText([reading("claude", 14, 50), reading("codex", 100, 16)]), "claude wk 50% · codex wk 16% ■");
});

test("Claude's reading alone is the token it always was, as a list or as the object an older kit wrote", () => {
  assert.equal(usageText([reading("claude", 14, 93)]), "5h 14% · wk 93% ■");
  assert.equal(usageText(reading("claude", 14, 50)), "5h 14% · wk 50%");
  // Codex still waiting for its first reading changes nothing.
  assert.equal(usageText([reading("claude", 14, 50), { provider: "codex" }]), "5h 14% · wk 50%");
});

test("a reading of Codex's alone is named, and a list with no reading is no token", () => {
  assert.equal(usageText([reading("codex", 100, 16)]), "codex wk 16% ■");
  assert.equal(usageText([{ provider: "claude" }, reading("codex", 30, 16)]), "codex wk 16%");
  assert.equal(usageText([{ provider: "claude" }, { provider: "codex" }]), undefined);
  assert.equal(usageText([]), undefined);
  assert.equal(usageText([reading("claude", Number.NaN, 5), reading("codex", 30, Number.NaN)]), undefined);
});

test("the status pane's sc_usage token carries both providers once the record's list has a reading", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-herdr-usage-codex-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  let held: PlanUsage[] = [{ provider: "claude" }, { provider: "codex" }];
  const tickets: Record<string, TicketRecord> = { "12": { state: "queued" } };
  const view = openSandboxView({ root, name: "shop" } as Project, 2, (id) => `#${id}`, () => tickets, "none", () => held);
  const calls = () => readFileSync(log, "utf8").split("\n").filter((c) => c.startsWith("pane report-metadata p9"));
  tickets["12"] = { state: "implement" };
  view.claim("12", "Add CSV export");
  assert.equal(calls().some((c) => c.includes("sc_usage")), false, "both waiting: no token");
  held = [reading("claude", 14, 93), { provider: "codex" }];
  view.phase("12", "implement");
  assert.ok(calls().at(-1)?.includes("--token sc_usage=5h 14% · wk 93% ■"), calls().at(-1));
  held = [reading("claude", 14, 93), reading("codex", 100, 16)];
  view.phase("12", "review");
  assert.ok(calls().at(-1)?.includes("--token sc_usage=claude wk 93% · codex wk 16% ■ --"), calls().at(-1));
  view.close("merged 0 of 1");
});
