// Text from an agent's log, the run record, outcomes.json and the tracker reaches the terminal inside the status
// view's frame, so it is read as plain text: an escape sequence in it (OSC 52 writing the clipboard, OSC 0 setting
// the title, CSI 2J clearing the screen) or a control character never gets through, while the view's own colours
// and links still do. A made-up `.sandcastle`; no process but the view's own readers.
//
//   pnpm test:file test/status-plain-text.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { palette, renderFrame } from "../src/status-render.ts";
import { ticketRows } from "../src/status-rows.ts";
import { plainText, readRecord, readTail, snapshotOf } from "../src/status-snapshot.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-plain-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Every way a line can talk to the terminal: the clipboard, the title, a cleared screen, a bell, a backspace, DEL, C1 CSI.
const HOSTILE = "a\x1b]52;c;aGVsbG8=\x07b\x1b]0;owned\x1b\\c\x1b[2Jd\x07e\bf\x7fg\x9b2Jh";
// oxlint-disable-next-line no-control-regex -- control characters are what the test looks for
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

test("plain text keeps the words and drops every escape sequence and control character", () => {
  assert.equal(plainText(HOSTILE), "abcdefg2Jh");
  assert.equal(plainText("one\ttwo\nthree"), "one two three");
});

test("a log, the run record and outcomes.json reach the snapshot as plain text, and the frame keeps its own styling", async () => {
  const dir = join(TMP, "project", ".sandcastle");
  const logs = join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  // A finished run: its tickets are drawn from the logs and outcomes.json.
  writeFileSync(
    join(logs, "run.json"),
    JSON.stringify({ startedAt: "2026-10-12T11:00:00Z", finishedAt: "2026-10-12T12:00:00Z", exitCode: 0, stage: `done${HOSTILE}`, tokens: `1M${HOSTILE}`, tickets: { "7": { state: "held", note: HOSTILE, unmet: HOSTILE } } }),
  );
  writeFileSync(join(logs, "outcomes.json"), JSON.stringify({ "7": { run: "r", kind: "held", text: `held: ${HOSTILE}` } }));
  writeFileSync(join(logs, "agent-issue-7-impl-7.log"), `Bash(ls ${HOSTILE})\n`);
  const part = await readRecord(dir, process.env, new AbortController().signal);
  const read = [part.record.stage, part.record.tokens, part.tickets["7"]?.note, part.tickets["7"]?.unmet, part.outcomes["7"]?.text, part.tails["agent-issue-7-impl-7.log"]?.activity];
  assert.deepEqual(read, ["doneabcdefg2Jh", "1Mabcdefg2Jh", "abcdefg2Jh", "abcdefg2Jh", "held: abcdefg2Jh", "$ ls abcdefg2Jh"]);

  const snapshot = snapshotOf(dir, { record: { status: "current", value: part }, git: { status: "loading" }, docker: { status: "loading" }, queue: { status: "current", value: [] }, pool: { status: "loading" } }, { now: Date.UTC(2026, 9, 12, 13) / 1000 });
  const frame = renderFrame(snapshot, ticketRows(snapshot), { cols: 120, rows: 60, showAll: true, colours: palette(true, false) });
  // The frame's own escapes are colours (SGR) alone here; nothing else may be in it.
  // oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern removes
  const rest = frame.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!CONTROL.test(rest), `an escape or control character in the frame: ${JSON.stringify(rest.match(new RegExp(`.{0,20}${CONTROL.source}.{0,20}`))?.[0])}`);
  assert.ok(frame.includes("\x1b["), "the frame lost its colours");
});

test("a log's tail is its last 64 KB, read without the rest", async () => {
  const file = join(TMP, "big.log");
  writeFileSync(file, `${"x".repeat(1024 * 1024)}\nthe last line\n`);
  const tail = await readTail(file);
  assert.equal(tail?.length, 64 * 1024);
  assert.ok(tail?.endsWith("the last line\n"));
  assert.equal(await readTail(join(TMP, "none.log")), undefined);
});
