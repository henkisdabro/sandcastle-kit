// The TypeScript status view's tracer bullet (#704): its ticket rows worked out from a built snapshot, and its
// `status 0` held to status.sh's on every fixture - the same facts at 120 columns, and the same row words,
// notes and order exactly - one plain frame into a pipe, exit 1 without `.sandcastle`, and status.sh handing
// the frame to it when the test switch says `ts`. No Docker, no network, no model calls.
//
//   pnpm test:file test/status-rows.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { GROUPS, TICKET_STATES, WORDS, type RunRecord, type TicketRecord } from "../mod/hooks/run-record.ts";
import { HANDED_BACK as RUN_HANDED_BACK } from "../src/run.ts";
import { HANDED_BACK, ticketRows, type Row } from "../src/status-rows.ts";
import type { Snapshot } from "../src/status-snapshot.ts";
import { KIT } from "./cli-spawn.ts";
import { buildFixture, type Fixture, type FixtureKind } from "./status-fixture.ts";
import { drawFrame, readFacts, compareFacts, viewEnv } from "./status-run.ts";

const NOW = 1_800_000_000;
const STARTED = "2027-01-15T06:00:00Z";

/** A snapshot of a live run with nothing in it but what `over` gives. */
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  root: "/home/user/project",
  dir: "/home/user/project/.sandcastle",
  name: "project",
  base: "main",
  hasRecord: true,
  record: { startedAt: STARTED, stage: "running" },
  tickets: {},
  live: true,
  outcomes: {},
  logs: [],
  tails: {},
  worktrees: [],
  branches: {},
  containers: {},
  cpus: 8,
  pool: { sandboxes: { used: 0, limit: "6" }, gates: { used: 0, limit: "2" } },
  queue: { tickets: [] },
  unpushed: 0,
  models: "",
  runOutput: [],
  links: false,
  clickMod: "",
  ...over,
});

const live = (tickets: Record<string, TicketRecord>, record: RunRecord = {}, over: Partial<Snapshot> = {}) =>
  snapshot({ record: { startedAt: STARTED, stage: "running", ...record, tickets }, tickets, ...over });

const row = (rows: Row[], id: string) => {
  const found = rows.find((r) => r.id === id);
  assert.ok(found, `no row for ${id}`);
  return found;
};

// ---------------------------------------------------------------------------
// The rows, from a built snapshot.
// ---------------------------------------------------------------------------

test("every ticket state of a live run shows its word and the group the shared table gives it", () => {
  const tickets = Object.fromEntries(TICKET_STATES.map((state, i) => [String(100 + i), { state, since: NOW - 60 }]));
  const { rows } = ticketRows(live(tickets));
  TICKET_STATES.forEach((state, i) => {
    const r = row(rows, String(100 + i));
    assert.equal(r.state, WORDS[state] ?? state, state);
    // The view's own split of the shared "other": a withdrawn ticket is left over, the rest idle.
    const group = state === "withdrawn" ? "left over" : GROUPS[state] === "other" ? "idle" : GROUPS[state];
    assert.equal(r.group, group, state);
  });
});

test("a live run's queue says which tickets start next and how many are ahead of the rest", () => {
  const tickets: Record<string, TicketRecord> = {
    "7": { state: "implement", since: NOW - 120 },
    "12": { state: "queued", order: 3, since: NOW - 300 },
    "10": { state: "queued", order: 1, since: NOW - 300 },
    "11": { state: "queued", order: 2, since: NOW - 300 },
  };
  // Two sandboxes and one ticket working: one slot free, so the first two queued start at once.
  const { rows } = ticketRows(live(tickets, { concurrency: 2 }));
  assert.deepEqual(
    rows.filter((r) => r.group === "queued").map((r) => [r.shown, r.note, r.time]),
    [
      ["#10", "next to start", "-"],
      ["#11", "next to start", "-"],
      ["#12", "1 ahead of it", "-"],
    ],
  );
  // A paused run starts nothing.
  const paused = ticketRows(live(tickets, { concurrency: 2, paused: { since: NOW - 60, finishing: [] } }));
  assert.equal(row(paused.rows, "10").note, "waits for the resume");
});

test("a step past three times its usual length says so, in its time and its note's colour", () => {
  const log = "agent-issue-7-impl-7.log";
  const s = live({ "7": { state: "implement", since: NOW - 1000, note: "attempt 2" } }, { typical: { implement: 300 } }, {
    logs: [{ name: log, mtime: NOW - 30 }],
    tails: { [log]: { activity: "Edit src/a.ts", limit: false } },
    containers: { "7": { cpu: "1.5c", mem: "276M", hot: false } },
  });
  const r = row(ticketRows(s).rows, "7");
  assert.deepEqual([r.state, r.time, r.timeTone, r.note, r.noteTone], ["impl", "16m", "hot", "3x over, usually 5m - attempt 2 - Edit src/a.ts", "hot"]);
  assert.deepEqual(r.cpu, { cpu: "1.5c", mem: "276M", hot: false });
  // A log saying the plan's allowance is spent names the cause in the row.
  const spent = ticketRows({ ...s, tails: { [log]: { activity: "Error", limit: true } } });
  assert.deepEqual([row(spent.rows, "7").note, row(spent.rows, "7").glyph], ["USAGE LIMIT REACHED - impl model", "!"]);
});

test("a held ticket a person merged by hand reads as merged, and says whether the push is still to come", () => {
  const held = (pushed: boolean, text = "human merge: .github/") =>
    row(
      ticketRows(
        live({ "20": { state: "held", since: NOW - 600 } }, {}, {
          outcomes: { "20": { run: STARTED, kind: "held", text } },
          branches: { "20": { exists: true, commits: 0, onBase: true, pushed } },
        }),
      ).rows,
      "20",
    );
  assert.deepEqual([held(false).state, held(false).group, held(false).note], ["merged", "merged", "merged by hand; closes on push"]);
  assert.equal(held(true).note, "merged by hand");
  // Handed back to a person: no commits is no merge.
  assert.deepEqual([held(true, HANDED_BACK).state, held(true, HANDED_BACK).group], ["held", "needs you"]);
});

test("the counts are the live run's: a ticket outside its record is shown, but counted apart", () => {
  const s = live({ "1": { state: "implement", since: NOW - 60 } }, { issues: ["1"] }, {
    queue: { tickets: [{ id: "1", blockedOn: [] }, { id: "5", blockedOn: [] }, { id: "6", blockedOn: ["#1"] }] },
    logs: [{ name: "agent-issue-9-impl-9.log", mtime: NOW - 90000 }],
    tails: { "agent-issue-9-impl-9.log": { activity: "nothing to sync out", limit: false } },
    branches: { "9": { exists: true, commits: 2, onBase: false, equalPatches: false } },
  });
  const { rows, counts, later } = ticketRows(s);
  assert.deepEqual([row(rows, "5").state, row(rows, "5").note], ["later", "next run"]);
  assert.deepEqual([row(rows, "6").state, row(rows, "6").note], ["later", "waits for #1 to close"]);
  assert.deepEqual([row(rows, "9").state, row(rows, "9").note, row(rows, "9").time], ["left over", "earlier run - sandcastle clean", "25h"]);
  assert.deepEqual(counts, { working: 1, "needs you": 0, ready: 0, queued: 0, blocked: 0, merged: 0, later: 2, "left over": 0, idle: 0 });
  assert.deepEqual(later, { ids: ["#5", "#6"], blocked: 1 });
});

test("an ended run's partly-done landing that needs a person says so, and is counted as partly done", () => {
  const s = snapshot({
    live: false,
    record: { startedAt: STARTED, finishedAt: "2027-01-15T07:00:00Z" },
    tickets: { "402": { state: "merged", since: NOW - 3000, started: NOW - 3600, unmet: "needs a decision from the maintainer" } },
    logs: [{ name: "agent-issue-402-impl-402.log", mtime: NOW - 3800 }],
    branches: { "402": { exists: false, onBase: false, landing: { at: NOW - 3000, subject: "Merge agent/issue-402 (part of #402)" } } },
  });
  const { rows, partly } = ticketRows(s);
  assert.deepEqual([row(rows, "402").state, row(rows, "402").note, row(rows, "402").diff, row(rows, "402").time], ["merged", "partly done - needs a person", "-", "10m"]);
  assert.equal(partly, 1);
});

test("rows come working first, then needing you, ready, queued, blocked, merged, later and left over", () => {
  const s = live(
    {
      "1": { state: "merged", since: NOW - 50 },
      "2": { state: "blocked", since: NOW - 50 },
      "3": { state: "queued", since: NOW - 50, order: 1 },
      "4": { state: "ready", since: NOW - 50 },
      "5": { state: "red", since: NOW - 50 },
      "6": { state: "review", since: NOW - 50 },
      "7": { state: "gates", since: NOW - 10 },
    },
    {},
    { queue: { tickets: [{ id: "8", blockedOn: [] }] } },
  );
  assert.deepEqual(
    ticketRows(s).rows.map((r) => r.shown),
    ["#7", "#6", "#5", "#4", "#3", "#2", "#1", "#8"],
  );
});

test("the handed-back line the rows read is the one the kit writes", () => {
  assert.equal(HANDED_BACK, RUN_HANDED_BACK);
});

// ---------------------------------------------------------------------------
// status 0 against status.sh's, on the fixtures.
// ---------------------------------------------------------------------------

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-rows-"));
const fixtures = Object.fromEntries((["live", "legacy", "ended"] as FixtureKind[]).map((kind) => [kind, buildFixture(kind, join(TMP, kind))])) as Record<FixtureKind, Fixture>;
after(() => {
  for (const f of Object.values(fixtures)) f.stop();
  rmSync(TMP, { recursive: true, force: true });
});

/** Runs `body` with the test switch set to `impl`. */
const as = <T>(impl: "bash" | "ts", body: () => T): T => {
  const was = process.env.SANDCASTLE_TEST_STATUS_IMPL;
  process.env.SANDCASTLE_TEST_STATUS_IMPL = impl;
  try {
    return body();
  } finally {
    if (was === undefined) delete process.env.SANDCASTLE_TEST_STATUS_IMPL;
    else process.env.SANDCASTLE_TEST_STATUS_IMPL = was;
  }
};

for (const kind of ["live", "legacy", "ended"] as FixtureKind[]) {
  test(`the ${kind} fixture's status 0 shows the same facts drawn by TypeScript as by status.sh at 80, 120, 200 and 330 columns`, () => {
    const fixture = fixtures[kind];
    for (const cols of [80, 120, 200, 330]) {
      const draw = (impl: "bash" | "ts") => {
        const drawn = as(impl, () => drawFrame(fixture, { cols, env: { SANDCASTLE_LINKS: "1" } }));
        assert.equal(drawn.status, 0, `${impl}: ${drawn.stderr}`);
        return readFacts(drawn.raw, fixture.root);
      };
      const [bash, ts] = [draw("bash"), draw("ts")];
      assert.ok(bash.tickets.length > 5, "the fixture shows its tickets");
      assert.deepEqual(compareFacts(ts, bash), [], `${cols} columns`);
      // Row words and order exactly: not a prefix of each other, the same - and the notes too where neither is cut.
      const words = (f: typeof bash) => f.tickets.map((t) => [t.id, t.group, t.state]);
      assert.deepEqual(words(ts), words(bash), `${cols} columns`);
      if (cols === 330) assert.deepEqual(ts.tickets.map((t) => t.note), bash.tickets.map((t) => t.note));
    }
  });
}

test("status 0 into a pipe prints one plain frame, with no colour or links, and exits 0", () => {
  const fixture = fixtures.live;
  // Colour asked for, and Herdr with its plugin linked: still none into a pipe.
  mkdirSync(join(fixture.cache, "sandcastle-kit"), { recursive: true });
  writeFileSync(join(fixture.cache, "sandcastle-kit", "herdr-plugin-linked"), "");
  const drawn = as("ts", () => drawFrame(fixture, { cols: 120, env: { NO_COLOR: "", COLORTERM: "truecolor", HERDR_ENV: "1" } }));
  assert.equal(drawn.status, 0, drawn.stderr);
  assert.doesNotMatch(drawn.raw, /\x1b/, "an escape code in the piped frame");
  const lines = drawn.raw.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("┌")).length, 1, "one frame");
  assert.equal(lines.filter((l) => l.startsWith("└")).length, 1, "one frame");
  assert.match(drawn.raw, /│ TICKET │/);
});

test("without .sandcastle the TypeScript view exits 1, as status.sh does", () => {
  const empty = join(TMP, "no project");
  mkdirSync(empty, { recursive: true });
  for (const impl of ["bash", "ts"] as const) {
    const drawn = as(impl, () => drawFrame(fixtures.ended, { env: { SANDCASTLE_PROJECT: empty } }));
    assert.equal(drawn.status, 1, impl);
    assert.equal(drawn.frame, "", impl);
  }
});

// ---------------------------------------------------------------------------
// The hand-off in status.sh.
// ---------------------------------------------------------------------------

// A jq on PATH that does not run: status.sh stops at once without one, and the TypeScript view needs none - so a
// frame drawn through status.sh with it is the TypeScript view's.
const NO_JQ = join(TMP, "no-jq");
mkdirSync(NO_JQ);
writeFileSync(join(NO_JQ, "jq"), "#!/bin/sh\nexit 127\n");
chmodSync(join(NO_JQ, "jq"), 0o755);

const throughStatusSh = (fixture: Fixture, args: string[], env: Record<string, string> = {}) => {
  const base = viewEnv(fixture, { TERM_COLS: "120", TERM_ROWS: "400", ...env });
  // No switch means none at all, even when the suite itself runs with one: that case is status.sh's own view.
  if (env.SANDCASTLE_TEST_STATUS_IMPL === undefined) delete base.SANDCASTLE_TEST_STATUS_IMPL;
  return spawnSync("bash", [join(KIT, "status.sh"), ...args], {
    encoding: "utf8",
    // The fixture's clock, which test/status-run.ts gives the TypeScript view it starts itself.
    env: { ...base, PATH: [NO_JQ, base.PATH].join(delimiter), NODE_OPTIONS: `--import=${join(KIT, "test/status-clock.ts")}` },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
};

test("status.sh hands status 0, and any interval into a pipe, to the TypeScript view when the switch says ts", () => {
  const fixture = fixtures.live;
  const direct = as("ts", () => drawFrame(fixture, { cols: 120 }));
  for (const args of [["0"], ["0", "all"], ["10"]]) {
    const r = throughStatusSh(fixture, args, { SANDCASTLE_TEST_STATUS_IMPL: "ts" });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, direct.raw, args.join(" "));
  }
  // Without the switch it is status.sh's own view, which stops for want of a jq that runs.
  const bash = throughStatusSh(fixture, ["0"]);
  assert.equal(bash.status, 1);
  assert.match(bash.stderr, /status needs jq/);
  // The exit code is the view's: 1 without a project.
  const none = throughStatusSh(fixture, ["0"], { SANDCASTLE_TEST_STATUS_IMPL: "ts", SANDCASTLE_PROJECT: join(TMP, "nowhere") });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /nowhere\/\.sandcastle: No such file or directory/);
});
