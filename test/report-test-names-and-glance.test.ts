// The closing summary groups one failing test named two ways, and keeps a reviewer's approving prose out of
// `Worth a glance`. Made-up facts through render(); no git, Docker, model or network.
//
//   pnpm test:file test/report-test-names-and-glance.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunRecord } from "../mod/hooks/run-record.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Facts = import("../src/report.ts").Facts;
type Project = import("../src/config.ts").Project;

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "1M in / 1k out",
  verify: { green: true, line: "ok" },
  gateCount: 1,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const SHORT = "pkg/app Sidebar.test.tsx > Sidebar > selects a tab";
const LONG = "pkg/app src/components/layout/Sidebar.test.tsx > Sidebar > selects a tab";
const lines = (out: string, start: string) => out.split("\n").filter((l) => l.startsWith(start) || l.includes(start));
const same = (tickets: RunRecord["tickets"]) => lines(render(facts({ tickets })), "Same failing test");

test("one test named with two path prefixes is one Same failing test line, naming the first name", () => {
  const out = render(facts({ tickets: { "11": { state: "red", failing: [SHORT] }, "12": { state: "red", failing: [LONG] } } }));
  assert.deepEqual(lines(out, "Same failing test"), [`Same failing test: ${SHORT} - on #11 #12. Likely one cause: fix it once.`]);
  assert.match(out, new RegExp(`^1\\. Fix ${SHORT.replace(/[>]/g, "\\>")} once - it fails on 2 of the unmerged branches`, "m"));
});

test("different basenames, or different titles in one file, are no Same failing test", () => {
  assert.deepEqual(same({ "1": { state: "red", failing: ["a/one.test.ts > works"] }, "2": { state: "red", failing: ["b/two.test.ts > works"] } }), []);
  assert.deepEqual(same({ "1": { state: "red", failing: ["x.test.ts > works"] }, "2": { state: "red", failing: ["x.test.ts > fails"] } }), []);
});

test("a ticket failing both forms and another failing one form: one line, each ticket once, no Same file or Start with", () => {
  for (const order of [["21", "22"], ["22", "21"]]) {
    const all: Record<string, { state: "red"; failing: string[] }> = { "21": { state: "red", failing: [SHORT, LONG] }, "22": { state: "red", failing: [LONG] } };
    const tickets = Object.fromEntries(order.map((id) => [id, all[id]])) as RunRecord["tickets"];
    const out = render(facts({ tickets }));
    assert.equal(lines(out, "Same failing test").length, 1);
    assert.match(lines(out, "Same failing test")[0], / - on #21 #22\. /);
    assert.doesNotMatch(out, /Same file:|Start with/);
  }
});

test("the Same file lines of conflicting tickets are unchanged", () => {
  const out = render(facts({
    tickets: {
      "31": { state: "conflict", title: "a", note: "with #32: src/a.ts", files: ["src/a.ts", "src/b.ts"] },
      "32": { state: "conflict", title: "b", note: "with #31: src/a.ts", files: ["src/a.ts", "src/b.ts"] },
    },
  }));
  assert.deepEqual(lines(out, "Same file:"), [
    "Same file: src/a.ts - #31 #32 fail or conflict there. Check whether it is one cause.",
    "Same file: src/b.ts - #31 #32 fail or conflict there. Check whether it is one cause.",
  ]);
});

const glance = (...gaps: string[]) =>
  lines(render(facts({ tickets: Object.fromEntries(gaps.map((gap, i) => [String(40 + i), { state: "merged", title: "t", gap }])) as RunRecord["tickets"] })), "Worth a glance");
const PREFIX = "Worth a glance - the reviewer's prose may name a gap: ";

test("own work and a refusal in place are left out of Worth a glance", () => {
  assert.deepEqual(
    glance("I added one commit for two gaps. … The remaining `--colour` strings are inputs the tool refuses. … Untested link: the `--json` flag's output has no test."),
    [`${PREFIX}#40 "Untested link: the \`--json\` flag's output has no test."`],
  );
});

test("a sentence that reports own work but says a gap remains is quoted whole", () => {
  const note = "I fixed the gap in src, but the same gap remains in docs/usage.md.";
  assert.deepEqual(glance(note), [`${PREFIX}#40 "${note}"`]);
});

test("a note of only dropped sentences has no entry; alone it has no line", () => {
  assert.deepEqual(glance("I added one commit.", "Untested: the parser has no test."), [`${PREFIX}#41 "Untested: the parser has no test."`]);
  assert.deepEqual(glance("I added one commit."), []);
});

test("kept sentences of a group stay joined by a space, groups by an ellipsis", () => {
  assert.deepEqual(glance("Gap one is open. I added a test. Gap two is open. … Gap three is open."), [`${PREFIX}#40 "Gap one is open. Gap two is open. … Gap three is open."`]);
});

test("code and quoted words are not the reviewer's own prose, and curly apostrophes count", () => {
  assert.deepEqual(glance("I fixed the `missing` flag parsing."), []);
  assert.deepEqual(glance("I’ve added a test."), []);
  const held = 'Untested: the "I fixed it. I added docs." message path.';
  assert.deepEqual(glance(held), [`${PREFIX}#40 "${held}"`]);
});

test("a cut-short pointer is shown only when the rebuilt note still ends with an ellipsis", () => {
  assert.match(glance("I added a test. Gap is open and the text was cut…")[0], /\(cut short - full text in /);
  assert.doesNotMatch(glance("Gap is open. I added a test…")[0], /cut short/);
});

test("a carried turn's note is filtered the same way and keeps its turn mark", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-glance-turns-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  const dir = join(root, ".scratch/shop/issues");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-one.md"), "# One\n\nStatus: done\n\nDo it.\n\n## Comments\n");
  writeFileSync(join(dir, "02-two.md"), "# Two\n\nStatus: done\n\nDo it.\n\n## Comments\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const turn = (n: number, started: string, finished: string, tickets: object) => ({
    orchestrator: "demo", pid: 4242, startedAt: started, finishedAt: finished, exitCode: 0, settings: { autonomy: "drain", turn: n, cap: 20 }, tickets, verify: null,
  });
  const one = turn(1, "2026-10-01T08:00:00.000Z", "2026-10-01T08:30:00.000Z", { "shop-01": { state: "merged", title: "One", gap: "I added one commit for two gaps. … Untested link: the flag has no test." } });
  const two = turn(2, "2026-10-01T08:31:00.000Z", "2026-10-01T09:00:00.000Z", { "shop-02": { state: "merged", title: "Two", gap: "The Linux path is left alone." } });
  const logs = join(root, ".sandcastle/logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "run.json"), JSON.stringify(two));
  writeFileSync(join(logs, "history.jsonl"), `${JSON.stringify(one)}\n${JSON.stringify(two)}\n`);
  const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const out = render(await gather(project, () => "sandcastle run"), true);
  assert.deepEqual(lines(out, "Worth a glance"), [`${PREFIX}shop-02 "The Linux path is left alone."; shop-01 "Untested link: the flag has no test." (turn 1)`]);
});
