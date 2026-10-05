// A run's start output reads in order: the `N ticket(s) ...` header first, then the lines indented
// under it - the tickets, the `#N waits for ...` lines, the shared-file lines. burndown() needs
// Docker, so no test drives it: its order is held by its source, as outcome-at-landing.test.ts does
// for the ledger.
//
//   pnpm exec tsx --test test/start-output-order.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
const at = (needle: string | RegExp, from = 0) => {
  const i = typeof needle === "string" ? src.indexOf(needle, from) : from + src.slice(from).search(needle);
  assert.ok(i >= from, `${needle} not found after ${from}`);
  return i;
};

test("the run header prints before the blocker lines it heads", () => {
  const body = at("export const burndown = ");
  const header = at("ticket(s)${dependants.length", body);
  const waits = at("waits for ${w.on.join", body);
  // The wait lines are said by one helper, called after the header and before the shared-file lines.
  assert.equal(src.slice(body).split("waits for ${w.on.join").length - 1, 1, "one place prints the wait lines");
  const first = at("sayWaits();", header);
  const holds = at("holds.start(schedule.start);", header);
  assert.ok(waits < header, "the helper is defined ahead of its use");
  assert.ok(first < holds, "wait lines come before the shared-file lines");
  // Every call of the helper is after the header, except the one on the path that starts nothing (no header there).
  const calls = [...src.slice(body).matchAll(/sayWaits\(\);/g)].map((m) => body + m.index!);
  const early = calls.filter((c) => c < header);
  assert.equal(early.length, 1);
  assert.match(src.slice(early[0], early[0] + 200), /Every queued ticket is waiting on another/);
});
