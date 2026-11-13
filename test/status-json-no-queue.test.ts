// `sandcastle status --json --no-queue`: a reading without the tracker call. Each test starts the view's entry as a
// child process over the `live` status fixture, whose fake `sandcastle` logs its pid to the shared `$FAKE_PIDS` file
// (as does every other fake there), so the queue process is told by its "sandcastle" entries.
//
//   pnpm test:file test/status-json-no-queue.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { palette, renderFrame } from "../src/status-render.ts";
import { ticketRows } from "../src/status-rows.ts";
import { readSnapshot, sandcastleDir } from "../src/status-snapshot.ts";
import { buildFixture, NOW, queueFile, type Fixture } from "./status-fixture.ts";
import { spawnStatus, viewEnv } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-no-queue-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

type Row = { id: string; state: string; group: string };
type Table = { rows: Row[]; counts: Record<string, number>; queueRead?: boolean };

const read = (fixture: Fixture, args: string[]) => {
  const r = spawnStatus(args, { encoding: "utf8", env: viewEnv(fixture), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

/** How many times the fake `sandcastle` (the queue) has run: the pid file holds one "<pid> <name>" line per call. */
const queueCalls = (fixture: Fixture) =>
  readFileSync(fixture.pids, "utf8")
    .split("\n")
    .filter((line) => line.endsWith(" sandcastle")).length;

/** A ticket that landed on the base, has a log, and is on the queue again after its merge: the queue turns it `later`. */
const mergedAndRequeued = (fixture: Fixture, id: string) => {
  const git = (...args: string[]) => execFileSync("git", ["-C", fixture.root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_AUTHOR_DATE: `${NOW - 86400} +0000`, GIT_COMMITTER_DATE: `${NOW - 86400} +0000` } });
  git("checkout", "-q", "-b", `agent/issue-${id}`, "main");
  git("commit", "-q", "--allow-empty", "-m", `work on ${id}`);
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `Merge agent/issue-${id} (closes #${id})`, `agent/issue-${id}`);
  git("branch", "-q", "-D", `agent/issue-${id}`);
  const log = join(fixture.root, ".sandcastle/logs", `agent-issue-${id}-impl-${id}.log`);
  writeFileSync(log, "Agent started\n<promise>COMPLETE</promise>\n");
  utimesSync(log, NOW - 3000, NOW - 3000);
  const queue = JSON.parse(readFileSync(queueFile(fixture), "utf8")) as unknown[];
  writeFileSync(queueFile(fixture), JSON.stringify([...queue, { id, title: `ticket ${id}`, updated: NOW + 86400, blockedOn: [] }]));
};

test("status --json --no-queue starts no queue process and keeps the run record's rows as they are", () => {
  const fixture = buildFixture("live", mkdtempSync(join(TMP, "rows-")));
  try {
    mergedAndRequeued(fixture, "205");
    const full: Table = read(fixture, ["--json"]);
    assert.ok(queueCalls(fixture) > 0, "the plain reading must have asked the queue");
    assert.equal(full.queueRead, undefined, "a full read says nothing about the queue");
    assert.equal(full.rows.find((r) => r.id === "205")?.state, "later", "the fixture's requeued ticket is not shown as the queue turns it");

    const before = queueCalls(fixture);
    const cut: Table = read(fixture, ["--json", "--no-queue"]);
    assert.equal(queueCalls(fixture), before, "--no-queue started a `sandcastle queue` process");
    assert.equal(cut.queueRead, false);

    const recorded = Object.values(fixture.tickets);
    assert.ok(recorded.length > 5, "the fixture's record holds the tickets");
    for (const id of recorded) {
      const was = full.rows.find((r) => r.id === id);
      assert.ok(was, `plain --json lacks the recorded ticket ${id}`);
      assert.deepEqual(cut.rows.find((r) => r.id === id), was, `row of ${id} differs`);
    }
    // Rows the queue alone makes or decides are left out, so nothing shows twice once a reader merges the two reads.
    for (const id of ["205", "203", "301", "302"]) assert.ok(!cut.rows.some((r) => r.id === id), `${id} should be left out`);
    assert.ok(cut.rows.length < full.rows.length);
    for (const row of cut.rows) assert.deepEqual(row, full.rows.find((r) => r.id === row.id), `row ${row.id} is not the full read's`);
  } finally {
    fixture.stop();
  }
});

test("status --json --no-queue --frame has queueRead in the table and no could-not-read note", () => {
  const fixture = buildFixture("live", mkdtempSync(join(TMP, "frame-")));
  try {
    const doc = read(fixture, ["--json", "--frame", "--no-queue"]);
    assert.equal(doc.table.queueRead, false);
    assert.ok(!JSON.stringify(doc.frame).includes("could not read"), "a skipped queue is not a failed one");
    assert.ok(!JSON.stringify(doc.frame).includes("queue: loading"));
    assert.equal(queueCalls(fixture), 0);
  } finally {
    fixture.stop();
  }
});

test("a reading without the queue is unavailable with no error, and its frame draws no queue note", async () => {
  const fixture = buildFixture("live", mkdtempSync(join(TMP, "snapshot-")));
  try {
    const env = viewEnv(fixture);
    const dir = sandcastleDir(env);
    assert.ok(dir, "the fixture has a .sandcastle");
    const snapshot = await readSnapshot(dir, { env, terminal: false, queue: false });
    assert.equal(snapshot.sources?.queue, "unavailable");
    assert.equal(snapshot.queue.error, undefined, "a skipped queue is not a failed one");
    assert.deepEqual(snapshot.queue.tickets, []);
    assert.equal(queueCalls(fixture), 0);
    const frame = renderFrame(snapshot, ticketRows(snapshot), { cols: 180, rows: 400, showAll: true, colours: palette(false, false) });
    assert.ok(!frame.includes("queue: "), "the terminal frame draws a queue note for a skipped queue");
  } finally {
    fixture.stop();
  }
});

test("status --json without --no-queue is unchanged: no queueRead key", () => {
  const fixture = buildFixture("live", mkdtempSync(join(TMP, "plain-")));
  try {
    assert.deepEqual(Object.keys(read(fixture, ["--json"])).sort(), ["counts", "later", "partly", "rows"]);
  } finally {
    fixture.stop();
  }
});

test("the frame's queue note is the one the terminal draws: a failed read says why, a skipped or good read says nothing", () => {
  const fixture = buildFixture("live", mkdtempSync(join(TMP, "queue-note-")));
  try {
    const failed = spawnStatus(["--json", "--frame"], { encoding: "utf8", env: { ...viewEnv(fixture), FAKE_QUEUE_FAIL: "gh: not logged in" }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).frame.queueNote, "queue: could not read - gh: not logged in");
    assert.equal(read(fixture, ["--json", "--frame"]).frame.queueNote, "");
    assert.equal(read(fixture, ["--json", "--frame", "--no-queue"]).frame.queueNote, "");
  } finally {
    fixture.stop();
  }
});
