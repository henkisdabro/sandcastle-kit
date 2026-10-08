// The closing summary (src/report.ts) from made-up facts: a mixed run like a
// real thirty-issue one, and a run with nothing in it. Every section must be
// there, in order, with the right tickets in it.
//
//   pnpm test:file test/report.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRecord } from "../mod/hooks/run-record.ts";
import { type Facts, render } from "../src/report.ts";

const SECTIONS = ["## 🏁 Run", "## ✅ Done", "## 🙋 Needs you", "## ❌ Needs fixing", "## ▶️ Runnable now", "## 📤 Local state", "## 👉 Next step"];

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "97.5M in / 725k out",
  verify: { green: true, line: "ruff=pass pytest=pass" },
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

test("a mixed run: every section, the right tickets, a file in common and a next step", () => {
  const out = render(
    facts({
      tickets: {
        "208": { state: "merged", title: "a" },
        "207": { state: "merged", title: "b" },
        "206": { state: "held", title: "pre-push check", files: [".githooks/pre-push", ".github/workflows/ci.yml"] },
        "203": { state: "conflict", title: "c", note: "with #204: tests/test_totals.py", files: ["tests/test_totals.py"] },
        "201": { state: "red", title: "d", note: "pytest red, 1 repair(s)", failing: ["tests/test_totals.py::test_rounding"] },
        "205": { state: "nochange", title: "e" },
        "209": { state: "blocked", title: "f" },
        "210": { state: "blocked", title: "g" },
      } satisfies RunRecord["tickets"],
      runnable: ["209"],
      blocked: [{ id: "210", on: ["#206"] }],
      ahead: 51,
      upstream: "origin/main",
      standing: ["agent/issue-201", "agent/issue-203", "agent/issue-206"],
      changed: { "206": 3 },
    }),
  );
  let last = -1;
  for (const s of SECTIONS) {
    const at = out.indexOf(s);
    assert.ok(at > last, `${s} missing or out of order`);
    last = at;
  }
  assert.match(out, /1h 48m\) - 6 attempted - 2 merged - 1 need you - 2 need fixing - 2 not started - tokens 97.5M in/);
  assert.match(out, /all 2 gates green/);
  assert.match(body(out, "## ✅ Done"), /2 merged and closed on GitHub: #207 #208/);
  assert.match(body(out, "## ✅ Done"), /only on your local main until you push it/);
  assert.match(body(out, "## ✅ Done"), /Nothing to change: #205/);
  assert.match(body(out, "## 🙋 Needs you"), /#206 pre-push check - changes .githooks\/pre-push, .github\/workflows\/ci.yml - 3 file\(s\)/);
  assert.match(body(out, "## 🙋 Needs you"), /git merge --no-ff agent\/issue-206/);
  assert.match(body(out, "## ❌ Needs fixing"), /#203 c - merge conflict: with #204: tests\/test_totals.py/);
  assert.match(body(out, "## ❌ Needs fixing"), /failing: tests\/test_totals.py::test_rounding/);
  // A conflict and a failing test in one file are a place to look, not one cause.
  assert.match(body(out, "## ❌ Needs fixing"), /Same file: tests\/test_totals.py - #201 #203 fail or conflict there/);
  assert.doesNotMatch(out, /Same failing test|Likely one cause/);
  assert.match(body(out, "## ▶️ Runnable now"), /Runnable now: #203 \(conflicted - its branch resumes\), #209 \(blockers closed\)/);
  assert.match(body(out, "## ▶️ Runnable now"), /#210 waits for #206 \(held\)/);
  assert.match(body(out, "## 📤 Local state"), /main is 51 commit\(s\) ahead of origin\/main/);
  assert.match(body(out, "## 📤 Local state"), /Nothing is pushed by Sandcastle/);
  const next = body(out, "## 👉 Next step");
  assert.match(next, /^1\. Start with tests\/test_totals.py: #\d+ #\d+ fail or conflict there\. They are still queued: the next `sandcastle run` resumes each branch, merging main into it first/m);
  assert.match(next, /Review and merge the 1 held branch/);
  assert.match(next, /Run again for the 1 ticket\(s\) this run unblocked/);
  assert.match(next, /Push main \(51 commit\(s\)\)/);
  assert.doesNotMatch(out, /shipped/);
});

test("a run with nothing in it prints every section, each saying none", () => {
  const out = render(facts({ verify: null }));
  // Local state always speaks: "nothing is pushed" is the line operators most misread.
  for (const s of SECTIONS.slice(1).filter((s) => !s.includes("Local state"))) assert.match(body(out, s), /^none$/m, `${s} should say none`);
  assert.match(body(out, "## 📤 Local state"), /Nothing is pushed by Sandcastle/);
  assert.match(out, /not re-gated \(no branch merged in this run\)/);
  // A run that never reached verify says so, whatever its tickets say.
  assert.match(render(facts({ verify: undefined, finished: undefined, killed: true })), /not re-gated \(the run ended before it got there\)/);
});

test("a red merged base comes first in the next steps", () => {
  const out = render(facts({ verify: { green: false, line: "pytest=FAIL" }, tickets: { "1": { state: "merged" }, "2": { state: "merged" } } }));
  assert.match(out, /RED TOGETHER \(pytest=FAIL\)/);
  assert.match(body(out, "## 👉 Next step"), /^1\. Fix main/m);
});

test("a dry run says what would merge and that nothing did", () => {
  const out = render(facts({ dryRun: true, dryRunCheck: "dry run held: 1 ticket(s) unchanged in the tracker.", tickets: { "7": { state: "ready" } } }));
  assert.match(out, /\(dry run\)/);
  assert.match(out, /1 would merge/);
  assert.match(body(out, "## ✅ Done"), /would merge: #7\. Nothing was merged or closed/);
  assert.match(out, /dry run held/);
});

test("a killed run says so, and does not claim an end time", () => {
  const out = render(facts({ finished: undefined, killed: true }));
  assert.match(out, /## 🏁 Run ended without a clean exit \(killed\?\)/);
  assert.match(out, /From \d\d:\d\d, end not recorded - 0 attempted/);
  assert.doesNotMatch(out, /finished/);
});

test("a merge whose close failed counts as merged, not closed, and needs you", () => {
  const out = render(facts({
    tickets: {
      "11": { state: "merged", title: "a" },
      "12": { state: "merged", title: "b", closeFailed: "HTTP 502 from api.github.com" },
    },
  }));
  assert.match(out, /- 2 merged - 1 need you -/);
  assert.match(body(out, "## ✅ Done"), /1 merged and closed on GitHub: #11$/m);
  assert.match(body(out, "## 🙋 Needs you"), /#12 b - merged, but closing the ticket failed: HTTP 502 from api.github.com - the next `sandcastle run` closes it/);
  assert.doesNotMatch(body(out, "## ❌ Needs fixing"), /#12/);
  assert.match(body(out, "## 👉 Next step"), /Close #12 \(merged, still open\)/);
});

test("a merge whose close failed alone is not reported as closed", () => {
  const out = render(facts({ tickets: { "12": { state: "merged", title: "b", closeFailed: "HTTP 502" } } }));
  const done = body(out, "## ✅ Done");
  assert.doesNotMatch(done, /Closed on GitHub|merged and closed/);
  assert.match(done, /1 merged, but still open in the tracker: #12 \(see Needs you\)/);
  assert.match(done, /The code is only on your local main until you push it\./);
});

test("a ticket withdrawn during the run is reported as done by someone's decision, not as a fix", () => {
  const out = render(facts({
    tickets: {
      "13": { state: "withdrawn", title: "c", note: "taken out of the queue during the run", started: 1 },
      "14": { state: "withdrawn", title: "d", note: "ticket closed - not started" },
    },
    standing: ["agent/issue-13"],
  }));
  assert.match(body(out, "## ✅ Done"), /#14 d - ticket closed - not started$/m);
  assert.match(body(out, "## ✅ Done"), /Not landed, as the tracker said during the run: #13 c - taken out of the queue during the run \(branch agent\/issue-13 kept\)/);
  assert.match(body(out, "## ❌ Needs fixing"), /^none$/m);
  assert.match(out, /- 1 attempted - 0 merged - 0 need you -/);
  assert.doesNotMatch(body(out, "## 👉 Next step"), /#1[34]/);
});

test("a ticket handed back with no commits asks for an answer, not a merge", () => {
  const out = render(facts({ tickets: { "demo-04": { state: "held", title: "Pick the brand colour", note: "handed back - for a human" } }, changed: { "demo-04": 0 } }));
  const needs = body(out, "## 🙋 Needs you");
  assert.match(needs, /demo-04 Pick the brand colour - handed back - for a human, no commits - read the agent's comment: do it yourself and close the ticket, or answer its question and requeue it/);
  assert.doesNotMatch(needs, /git merge|0 file/);
  assert.match(body(out, "## 👉 Next step"), /Read the agent's comment on demo-04: work only a person can do, do it and close the ticket; a question, answer it and requeue/);
  assert.doesNotMatch(body(out, "## 👉 Next step"), /held branch/);
});

test("a run stopped before landing says so first, with why", () => {
  const out = render(facts({ stopped: "STOPPED before landing: main moved while sandboxes ran (abc1234 T: edit).", tickets: { "5": { state: "stopped", note: "finished before the run stopped" } } }));
  assert.match(out, /- 1 attempted - 0 merged - 0 need you - 0 need fixing -/);
  assert.match(body(out, "## ❌ Needs fixing"), /^none$/m);
  assert.match(body(out, "## 👉 Next step"), /^1\. Check what stopped the run \(above\)\. If it is your own commit, `sandcastle run` again - #5 finished and land then\./m);
  assert.match(out, /^## 🏁 Run STOPPED before landing - nothing was merged\n.*\n.*\nSTOPPED before landing: main moved/m);
  assert.doesNotMatch(out, /Run finished/);
});

test("a ticket a person marked for a human mid-run is theirs: no merge commands", () => {
  const out = render(facts({ tickets: { "21": { state: "held", title: "t", note: "marked for a human during the run" } }, outcomes: { "21": "taken back" }, changed: { "21": 2 } }));
  assert.match(body(out, "## 🙋 Needs you"), /#21 t - marked for a human during the run - branch agent\/issue-21 has the agents' work, if it helps/);
  assert.doesNotMatch(out, /git merge|held branch/);
});

test("one test failing on several branches is named as one likely cause", () => {
  const out = render(facts({
    tickets: {
      "301": { state: "red", failing: ["tests/test_totals.py::test_rounding"] },
      "302": { state: "red", failing: ["tests/test_totals.py::test_rounding", "tests/test_tax.py::test_rate"] },
      "303": { state: "red", failing: ["tests/test_tax.py::test_zero"] },
    },
  }));
  const fixing = body(out, "## ❌ Needs fixing");
  assert.match(fixing, /Same failing test: tests\/test_totals.py::test_rounding - on #301 #302\. Likely one cause/);
  // Same test file, different tests: only a place to look.
  assert.match(fixing, /Same file: tests\/test_tax.py - #302 #303/);
  // The file of the shared test is not listed again as a mere file in common.
  assert.doesNotMatch(fixing, /Same file: tests\/test_totals.py/);
  assert.match(body(out, "## 👉 Next step"), /^1\. Fix tests\/test_totals.py::test_rounding once - it fails on 2 of the unmerged branches/m);
});
