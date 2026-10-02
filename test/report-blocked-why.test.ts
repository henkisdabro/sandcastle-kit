// The closing summary says why a ticket is still blocked, not just "waits for #N".
//
//   pnpm exec tsx --test test/report-blocked-why.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

test("a blocked ticket carries the reason its blocker holds it", () => {
  const out = render({
    base: "main",
    tracker: "github",
    started: "2026-09-30T06:41:00.000Z",
    finished: "2026-09-30T08:29:00.000Z",
    live: false,
    dryRun: false,
    verify: { green: true, line: "ok" },
    gateCount: 1,
    tickets: { "5": { state: "blocked", title: "e" }, "6": { state: "blocked", title: "f" }, "7": { state: "blocked", title: "g" } },
    runnable: [],
    blocked: [
      { id: "5", on: ["#10"], why: { "#10": "closed as not planned" } },
      { id: "6", on: ["#11"], why: { "#11": "held for a human (needs-human)" } },
      { id: "7", on: ["#12", "#14"], why: { "#12": "open but not queued" } },
    ],
    standing: [],
    keptWorktrees: [],
    changed: {},
  } as Facts);
  assert.match(out, /#5 waits for #10 - closed as not planned/);
  assert.match(out, /#6 waits for #11 - held for a human \(needs-human\)/);
  assert.match(out, /#7 waits for #12 - open but not queued, #14$/m);
});
