// The closing summary of a run that stopped because the gates were red on the
// base before any agent started: it must say so, not report six tickets as
// attempted. A normal finished run's headline must stay as it was.
//
//   pnpm exec tsx --test test/report-base-red.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

const SECTIONS = ["## 🏁 Run", "## ✅ Done", "## 🙋 Needs you", "## ❌ Needs fixing", "## ▶️ Runnable now", "## 📤 Local state", "## 👉 Next step"];

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:49:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

// The body of one section: the lines between its heading and the next.
const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

const queued = Object.fromEntries(["1", "2", "3", "4", "5", "6"].map((id, order) => [id, { state: "queued", order, title: `t${id}` }]));

const redBase = () =>
  facts({
    stage: "base gates",
    exitCode: 1,
    baseGates: [{ gate: "typecheck", ok: true }, { gate: "test", ok: false }],
    tickets: queued,
    standing: ["agent/issue-9"],
  });

test("a run stopped on red base gates says so, with the red gate and the way out", () => {
  const out = render(redBase());
  assert.match(out, /^## 🏁 Run stopped: red on main before any agent ran - nothing was started$/m);
  assert.match(out, / - 0 attempted - 0 merged - 0 need you - 0 need fixing - 6 not started/);
  assert.match(out, /^Base gates: red - test$/m);
  assert.doesNotMatch(out, /re-gated|finished/);
  const next = body(out, "## 👉 Next step");
  assert.match(next, /^1\. Fix the base: read \.sandcastle\/logs\/base-gates\.log, then `sandcastle gates` to check; the queue is untouched, so `sandcastle run` afterwards starts the same tickets\.$/m);
  assert.doesNotMatch(out, /sandcastle clean/);
  // The other six sections keep their headings and say none when empty.
  for (const s of SECTIONS) assert.ok(out.includes(s), `${s} missing`);
  for (const s of ["## ✅ Done", "## 🙋 Needs you", "## ❌ Needs fixing", "## ▶️ Runnable now"]) assert.match(body(out, s), /^none$/m, `${s} should say none`);
});

test("the headline has no emoji under NO_COLOR", () => {
  assert.match(render(redBase(), true), /^## Run stopped: red on main before any agent ran - nothing was started$/m);
});

test("red base gates with no gate names recorded point at the log", () => {
  assert.match(render({ ...redBase(), baseGates: undefined }), /^Base gates: red - failing gates not recorded; see \.sandcastle\/logs\/base-gates\.log$/m);
});

test("a normal finished run's headline is unchanged", () => {
  const ok = render(facts({ stage: "report", exitCode: 0, verify: null, tickets: { "1": { state: "merged", started: 1 } } }));
  assert.match(ok, /^## 🏁 Run finished$/m);
  assert.match(ok, /- 1 attempted - 1 merged/);
  assert.doesNotMatch(ok, /Base gates|before any agent ran/);
  // A later stage with a failing exit, or tickets that started, is not this case.
  assert.match(render(facts({ stage: "landing", exitCode: 1, tickets: queued })), /^## 🏁 Run finished$/m);
  assert.match(render(facts({ stage: "base gates", exitCode: 1, tickets: { "1": { state: "red", started: 1 } } })), /^## 🏁 Run finished$/m);
  assert.match(render(facts({ stage: "base gates", exitCode: 0, tickets: queued })), /^## 🏁 Run finished$/m);
});
