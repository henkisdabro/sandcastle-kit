// The closing summary reads the tracker once for its blocked tickets, not once per ticket and blocker:
// `gather` answers every ticket and blocker in the open list from one `gh issue list`, and reads
// only a ticket outside it (closed since, or past a full list) one at a time. A fake `gh` on PATH
// logs every call; no network.
//
//   pnpm test:file test/report-blocked-reads.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { gather } = await import("../src/report.ts");
const { recordRun } = await import("../src/run.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

// 10: closed as not planned, 11: open and held, 12: open and not queued, 13: closed as completed.
// 21-25 are the blocked tickets. Every call is logged as its arguments on one line. Every read
// answers from the same made-up issues (`setIssues`): the open list is the open ones, and
// `issue view` and `api` read one file per issue, so the per-ticket reads a slower `gather` makes
// report the very same facts and only the call log tells them apart.
const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
const log = join(bin, "calls");
const data = join(bin, "issues");
mkdirSync(data);
writeFileSync(
  join(bin, "gh"),
  `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  api)
    n=\${2##*/}
    [ -f "${data}/$n.state" ] || exit 1
    cat "${data}/$n.state" ;;
  issue)
    case "$2" in
      list)
        case "$*" in
          *--label*) echo '[]' ;;
          *) cat "${data}/open.json" ;;
        esac ;;
      view)
        [ -f "${data}/$3.json" ] || exit 1
        cat "${data}/$3.json" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

type Issue = { number: number; labels: string[]; body?: string; state?: "open" | "closed completed" | "closed not_planned"; listed?: boolean };
const setIssues = (issues: Issue[], filler = 0) => {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data);
  const json = (i: Issue) => ({ number: i.number, title: `t${i.number}`, body: i.body ?? "", labels: i.labels.map((name) => ({ name })) });
  for (const i of issues) {
    writeFileSync(join(data, `${i.number}.json`), JSON.stringify({ ...json(i), state: (i.state ?? "open") === "open" ? "OPEN" : "CLOSED", comments: [] }));
    writeFileSync(join(data, `${i.number}.state`), `${i.state ?? "open"}${(i.state ?? "open") === "open" ? " " : ""}\n`);
  }
  const listed = issues.filter((i) => (i.state ?? "open") === "open" && i.listed !== false).map((i) => ({ ...json(i), updatedAt: "2026-01-01T00:00:00Z" }));
  const rest = Array.from({ length: filler }, (_, k) => ({ ...json({ number: 1000 + k, labels: [] }), updatedAt: "2026-01-01T00:00:00Z" }));
  writeFileSync(join(data, "open.json"), JSON.stringify([...listed, ...rest]));
};
const blockers: Issue[] = [
  { number: 10, labels: [], state: "closed not_planned" },
  { number: 11, labels: ["ready-for-human"] },
  { number: 12, labels: [] },
  { number: 13, labels: [], state: "closed completed" },
];

const root = mkdtempSync(join(tmpdir(), "sandcastle-report-reads-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker() } as unknown as Project;

const callsOf = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const record = (ids: string[]) =>
  recordRun(project, { issues: ids, tickets: Object.fromEntries(ids.map((id) => [id, { state: "blocked", title: `t${id}` }])) });

test("five blocked tickets on four blockers cost one list and one read for each closed blocker", async () => {
  const blockedBodies: Record<number, string> = { 21: "Blocked by #10", 22: "Blocked by #11", 23: "Blocked by #12", 24: "Blocked by #13", 25: "Blocked by #10, #11" };
  setIssues([...blockers, ...Object.entries(blockedBodies).map(([n, body]) => ({ number: Number(n), labels: ["ready-for-agent"], body }))]);
  writeFileSync(log, "");
  record(Object.keys(blockedBodies));

  const facts = await gather(project);

  assert.deepEqual(facts.blocked, [
    { id: "21", on: ["#10"], why: { "#10": "closed as not planned" } },
    { id: "22", on: ["#11"], why: { "#11": "held for a human" } },
    { id: "23", on: ["#12"], why: { "#12": "open but not queued" } },
    { id: "25", on: ["#10", "#11"], why: { "#10": "closed as not planned", "#11": "held for a human" } },
  ]);
  assert.deepEqual(facts.runnable, ["24"]);

  const calls = callsOf();
  // The other `issue list` is the run's triage-label read of the issues opened during it.
  assert.equal(calls.filter((c) => c.startsWith("issue list") && !c.includes("--label")).length, 1);
  assert.equal(calls.filter((c) => c.startsWith("issue view")).length, 0);
  assert.deepEqual(calls.filter((c) => c.startsWith("api")).sort(), ["api repos/{owner}/{repo}/issues/10 --jq .state + \" \" + (.state_reason // \"\")", "api repos/{owner}/{repo}/issues/13 --jq .state + \" \" + (.state_reason // \"\")"]);
});

test("a blocked ticket past a full open list is still read on its own and reported correctly", async () => {
  // 500 entries (gh's limit), none of them the blocked ticket 21, open past the list; #11 is among them, held.
  setIssues([...blockers, { number: 21, labels: ["ready-for-agent"], body: "Blocked by #11", listed: false }], 498);
  writeFileSync(log, "");
  record(["21"]);

  // The tracker warns on stderr that a full list hides tickets beyond it.
  const warned: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (warned.push(String(chunk)), true)) as typeof process.stderr.write;
  let facts;
  try {
    facts = await gather(project);
  } finally {
    process.stderr.write = real;
  }

  assert.match(warned.join(""), /gh returned the limit of 500 open tickets/);
  assert.deepEqual(facts.blocked, [{ id: "21", on: ["#11"], why: { "#11": "held for a human" } }]);
  assert.deepEqual(facts.runnable, []);
  assert.deepEqual(callsOf().filter((c) => c.startsWith("issue view")), ["issue view 21 --json number,title,state,body,comments,labels,blockedBy"]);
  assert.deepEqual(callsOf().filter((c) => c.startsWith("api")), []);
});
