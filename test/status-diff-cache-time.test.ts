// The status view's DIFF, cache-share and time-left cells (#703): the run record's ticket entry gaining the cache-read
// count beside its `tokens` text, the rows and the frame drawing the three, and `status 0` under the TypeScript view
// showing them on a fixture with a live ticket. No Docker, no network, no model calls.
//
//   pnpm test:file test/status-diff-cache-time.test.ts

// The frame's times are drawn in local time: one zone, so a frame is the same on every machine.
process.env.TZ = "UTC";
process.env.SANDCASTLE_TEST_STATUS_IMPL = "ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TicketRecord } from "../mod/hooks/run-record.ts";
import type { Project } from "../src/config.ts";
import type { Row } from "../src/status-rows.ts";
import type { Snapshot } from "../src/status-snapshot.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-diff-cache-time-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
after(() => rmSync(TMP, { recursive: true, force: true }));
const { addTokens, liveTokenWriter, recordRun, ticketTokens } = await import("../src/run.ts");
const { ticketRows } = await import("../src/status-rows.ts");
const { palette, renderFrame } = await import("../src/status-render.ts");
const { buildFixture, NOW: FIXTURE_NOW } = await import("./status-fixture.ts");
const { drawFrame } = await import("./status-run.ts");

// ---------------------------------------------------------------------------
// The run record.
// ---------------------------------------------------------------------------

// Not under TMP: the record is finished by an exit handler, which writes it once more after the cleanup above.
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-diff-cache-time-record-"));
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  return { root, name: "fixture" } as Project;
};

// By hand: in = 100 + 4000 + 1,000,000 = 1,004,100; out = 800.
const A = { input: 100, cacheWrite: 4000, cacheRead: 1_000_000, output: 800 };
const B = { input: 50, cacheWrite: 0, cacheRead: 1_200_000, output: 1500 };

test("a ticket's record entry gains the cache-read count when its tokens are recorded, its tokens text as it was", () => {
  const p = project();
  const record = recordRun(p, {});
  const spent = new Map([["7", A]]);
  record.ticket("7", { state: "implement" });
  const entry = () => (JSON.parse(readFileSync(join(p.root, ".sandcastle/logs/run.json"), "utf8")).tickets["7"] as TicketRecord);
  // The running pass's figure, as the usage watch writes it on its tick: the finished pass plus B so far.
  liveTokenWriter(record, spent)("7", B);
  assert.deepEqual([entry().tokens, entry().cacheRead], ["2.2M in / 2k out", 2_200_000]);
  // The pass's result, as `timed` writes it when the pass returns.
  record.ticket("7", ticketTokens(addTokens(A, B)));
  assert.deepEqual([entry().state, entry().tokens, entry().cacheRead], ["implement", "2.2M in / 2k out", 2_200_000]);
});

test("burndown writes a ticket's tokens through ticketTokens, in the pass and when its pipeline ends", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /if \(issue\) run\.ticket\(issue, \{ \.\.\.ticketTokens\(spent\.get\(issue\)!\) \}\);/);
  assert.match(src, /\.\.\.\(tokens \? ticketTokens\(tokens\) : \{\}\),/);
  assert.doesNotMatch(src, /tokens: tokenBrief\(spent\.get\(issue\)!\)|\{ tokens: tokenBrief\(tokens\) \}/);
});

// ---------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000;
const STARTED = "2027-01-15T06:00:00Z";

const snapshot = (tickets: Record<string, TicketRecord>, over: Partial<Snapshot> = {}, record: Snapshot["record"] = {}): Snapshot => ({
  now: NOW,
  root: "/home/user/project",
  dir: "/home/user/project/.sandcastle",
  name: "project",
  base: "main",
  hasRecord: true,
  record: { startedAt: STARTED, stage: "running", ...record, tickets },
  tickets,
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

const rowOf = (s: Snapshot, id = "12"): Row => {
  const found = ticketRows(s).rows.find((r) => r.id === id);
  assert.ok(found, `no row for ${id}`);
  return found;
};

test("DIFF is the lines added and removed on the ticket's branch, and - without a branch", () => {
  const working: TicketRecord = { state: "implement", since: NOW - 60 };
  const diff = (branches: Snapshot["branches"]) => rowOf(snapshot({ "12": working }, { branches })).diff;
  assert.equal(diff({ "12": { exists: true, onBase: false, commits: 3, diff: { added: 96, removed: 1159 } } }), "+96 −1159");
  assert.equal(diff({ "12": { exists: true, onBase: false, commits: 0, diff: { added: 0, removed: 0 } } }), "+0 −0");
  // Five digits would not fit the column's 11 cells.
  assert.equal(diff({ "12": { exists: true, onBase: false, commits: 9, diff: { added: 12_345, removed: 9999 } } }), "+12k −9999");
  assert.equal(diff({}), "-");
  assert.equal(diff({ "12": { exists: false, onBase: false } }), "-", "a branch that is gone");
  assert.equal(diff({ "12": { exists: true, onBase: false } }), "-", "a branch git could not read");
  // A merged ticket's branch is deleted at landing: no branch, so -.
  const merged = rowOf(snapshot({ "12": { state: "merged", since: NOW - 60, started: NOW - 600 } }, { branches: { "12": { exists: false, onBase: false, landing: { at: NOW - 60, subject: "Merge agent/issue-12 (closes #12)" } } } }));
  assert.equal(merged.diff, "-");
});

test("the cache share is the record's cache-read count over the input of its tokens text, and absent in an older record", () => {
  const share = (t: Partial<TicketRecord>) => rowOf(snapshot({ "12": { state: "implement", since: NOW - 60, ...t } })).cache;
  assert.equal(share({ tokens: "2.5M in / 27k out", cacheRead: 2_350_000 }), 94);
  assert.equal(share({ tokens: "840 in / 20 out", cacheRead: 420 }), 50);
  assert.equal(share({ tokens: "12k in / 1k out", cacheRead: 0 }), 0);
  assert.equal(share({ tokens: "2.5M in / 27k out" }), undefined, "a record from before the count");
  assert.equal(share({ tokens: "0 in / 0 out", cacheRead: 0 }), undefined, "no input, no share");
  assert.equal(share({ cacheRead: 100 }), undefined, "no tokens text");
  assert.equal(rowOf(snapshot({ "12": { state: "implement", since: NOW - 60, tokens: "2.5M in / 27k out", cacheRead: 2_350_000 } })).tokens, "2.5M/27k", "the in/out the older readers show");
});

test("TIME carries what the step usually has left while it is under its usual length, and only the time at or past it", () => {
  const time = (age: number, typical: unknown = 600, state: TicketRecord["state"] = "implement") =>
    rowOf(snapshot({ "12": { state, since: NOW - age } }, {}, { typical: { implement: typical, gates: 300 } }));
  assert.equal(time(360).time, "6m ~4m");
  assert.equal(time(30, 90).time, "30s ~1m");
  assert.equal(time(599).time, "9m ~1s");
  assert.equal(time(600).time, "10m", "at the usual length");
  assert.equal(time(700).time, "11m", "past it");
  assert.equal(time(360, null).time, "6m", "without a typical length");
  assert.equal(time(360, 0).time, "6m", "a typical length of nothing");
  // Past twice the usual the time is red, as before; past it there is no ~ to go with it.
  assert.deepEqual([time(1300).time, time(1300).timeTone], ["21m", "hot"]);
  // TIME holds 7 cells: the space goes before the left does.
  assert.equal(time(600, 1500).time, "10m~15m");
  assert.equal(time(60, 3600 * 5).time, "1m ~4h");
  assert.equal(time(600, 3600 * 5).time, "10m ~4h");
  // A step with no typical length of its own state (the record has gates', not review's).
  assert.equal(time(360, 600, "review").time, "6m");
  // A finished ticket shows its whole length, with no left.
  const done = rowOf(snapshot({ "12": { state: "merged", since: NOW - 60, started: NOW - 360 } }, {}, { typical: { merged: 600 } }));
  assert.equal(done.time, "5m");
});

// ---------------------------------------------------------------------------
// The frame.
// ---------------------------------------------------------------------------

const SNAPSHOT = snapshot({});
const frameOf = (rows: Row[], { colour = false, cols = 140 } = {}) =>
  renderFrame(SNAPSHOT, { rows, counts: { working: rows.length, "needs you": 0, ready: 0, queued: 0, blocked: 0, merged: 0, later: 0, "left over": 0, idle: 0 }, partly: 0, later: { ids: [], blocked: 0 } }, {
    cols,
    rows: 400,
    showAll: true,
    colours: palette(colour, false),
  });

const base: Row = {
  id: "12",
  shown: "#12",
  state: "impl",
  glyph: "●",
  tone: "ylw",
  group: "working",
  time: "6m ~4m",
  timeTone: "head",
  diff: "+96 −1159",
  tokens: "2.5M/27k",
  cache: 94,
  note: "working",
  noteTone: "head",
  prio: 0,
  key: 0,
  apart: false,
};
const cellsOf = (frame: string, id = "#12") => (frame.split("\n").find((l) => l.includes(`${id} `)) ?? "").split("│").map((c) => c.trim());
const unpainted = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

test("the table is headed DIFF, not COMMITS, and shows the diff, the cache share and the time left in their cells", () => {
  const frame = frameOf([base]);
  assert.match(frame, /^│ +TICKET +│ +STATE +│ +TIME +│ +DIFF +│ +CPU\/MEM +│ +TOKENS +│ +ACTIVITY +│$/m);
  assert.doesNotMatch(frame, /COMMITS/);
  assert.deepEqual(cellsOf(frame).slice(1, 7), ["#12", "● impl", "6m ~4m", "+96 −1159", "-", "2.5M 94% 27k"]);
});

test("DIFF without a branch is -, and TOKENS without the cache count is in/out as before", () => {
  const frame = frameOf([{ ...base, diff: "-", cache: undefined, time: "6m" }]);
  assert.deepEqual(cellsOf(frame).slice(1, 7), ["#12", "● impl", "6m", "-", "-", "2.5M/27k"]);
});

test("the cache share is amber under 70% and the tokens' own colour from 70%", () => {
  const painted = palette(true, false);
  const share = (cache: number) => {
    const line = frameOf([{ ...base, cache }], { colour: true }).split("\n").find((l) => unpainted(l).includes("#12 "))!;
    return line;
  };
  assert.ok(share(69).includes(`${painted.ylw}69%${painted.off}`), "69% is amber");
  assert.ok(share(0).includes(`${painted.ylw}0%${painted.off}`), "0% is amber");
  assert.ok(share(70).includes(`${painted.head}70%${painted.off}`), "70% is not");
  assert.ok(!share(94).includes(painted.ylw + "94%"), "94% is not");
  // DIFF: added green, removed red; the dash grey.
  assert.ok(share(94).includes(`${painted.grn}+96${painted.off} ${painted.hot}−1159${painted.off}`));
});

test("a TOKENS cell wider than its 12 cells loses the space before out, then the share, and never cuts a figure", () => {
  const tokens = (t: string, cache = 94) => cellsOf(frameOf([{ ...base, tokens: t, cache }]))[6];
  assert.equal(tokens("940k/27k"), "940k 94% 27k");
  assert.equal(tokens("12.3M/85k"), "12.3M 94%85k");
  assert.equal(tokens("28.4M/343k"), "28.4M/343k");
  assert.equal(tokens("2.5M/27k", 100), "2.5M 100%27k");
  // The share keeps its amber with the space gone.
  const painted = palette(true, false);
  const line = frameOf([{ ...base, tokens: "12.3M/85k", cache: 40 }], { colour: true }).split("\n").find((l) => unpainted(l).includes("#12 "))!;
  assert.ok(line.includes(`${painted.ylw}40%${painted.off}${painted.head}85k`), line);
});

test("the legend explains ~ and the cache share, and no longer COMMITS", () => {
  const frame = frameOf([base], { cols: 200 });
  assert.match(frame, /time = in state, ~ roughly what it usually has left; once finished, start to end/);
  assert.match(frame, /tokens = in, % of it from cache \(amber under 70%\), out/);
  assert.doesNotMatch(frame, /commits/i);
});

// ---------------------------------------------------------------------------
// status 0, the TypeScript view, on a fixture with a live ticket.
// ---------------------------------------------------------------------------

test("status 0 under ts shows DIFF, the cache share and the time left on a live fixture", () => {
  const fixture = buildFixture("live", join(TMP, "live"));
  after(() => fixture.stop());
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", fixture.root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  const lines = (prefix: string, from: number, to: number) => Array.from({ length: to - from }, (_, i) => `${prefix} ${from + i}\n`).join("");
  const implement = fixture.tickets.implement!;
  const gates = fixture.tickets.gates!;

  // The implementing ticket's branch gains a file of 96 lines.
  git("checkout", "-q", `agent/issue-${implement}`);
  writeFileSync(join(fixture.root, "feature.txt"), lines("line", 0, 96));
  git("add", "feature.txt");
  git("commit", "-q", "-m", "feature");
  git("checkout", "-q", "main");
  // A ticket of an earlier run, branched from a base that has a file: it adds 7 lines and removes 3.
  writeFileSync(join(fixture.root, "shared.txt"), lines("row", 0, 100));
  git("add", "shared.txt");
  git("commit", "-q", "-m", "shared file");
  git("checkout", "-q", "-b", "agent/issue-205");
  writeFileSync(join(fixture.root, "shared.txt"), lines("new", 0, 7) + lines("row", 3, 100));
  git("commit", "-q", "-a", "-m", "rework");
  git("checkout", "-q", "main");
  writeFileSync(join(fixture.root, ".sandcastle", "logs", "agent-issue-205-impl-205.log"), "Agent started\nEdit(src/205.ts)\n");

  // The record: the implementing ticket 6 minutes into a step that usually takes 10, 94% of its input from cache;
  // the gates ticket 40%; every other ticket is as an older record has it, with no count.
  const path = join(fixture.root, ".sandcastle", "logs", "run.json");
  const run = JSON.parse(readFileSync(path, "utf8"));
  run.typical = { ...run.typical, implement: 600 };
  Object.assign(run.tickets[implement], { since: FIXTURE_NOW - 360, tokens: "2.5M in / 27k out", cacheRead: 2_350_000 });
  Object.assign(run.tickets[gates], { tokens: "1.0M in / 10k out", cacheRead: 400_000 });
  writeFileSync(path, JSON.stringify(run));

  const drawn = drawFrame(fixture, { cols: 160 });
  assert.equal(drawn.status, 0, drawn.stderr);
  const cells = (id: string) => cellsOf(drawn.frame, `#${id}`).slice(1, 7);
  assert.match(drawn.frame, /│ +TIME +│ +DIFF +│ +CPU\/MEM +│ +TOKENS +│/);
  const live = cells(implement);
  assert.deepEqual([live[2], live[3], live[5]], ["6m ~4m", "+96 \u22120", "2.5M 94% 27k"]);
  assert.equal(cells(gates)[5], "1.0M 40% 10k");
  // A ticket with no count keeps in/out; one with no branch has no diff; the old branch's diff is git's.
  assert.match(cells(fixture.tickets.merged!)[5]!, /^\d+\.\d+M\/\d+k$/);
  assert.equal(cells(fixture.tickets.merged!)[3], "-");
  assert.equal(cells("205")[3], "+7 \u22123");
});
