// The log marks (src/run.ts): the path a run's log is written to, the local
// timestamp and the separator line appended at each phase start.
//
//   pnpm exec tsx --test test/logs.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { agentLog, localStamp, logOwner, markLog } from "../src/run.ts";

test("agentLog names the file Sandcastle writes, and logOwner reads the ticket back", () => {
  for (const [id, name] of [["12", "impl-12"], ["12", "review-codex-12"], ["checkout-03", "impl-checkout-03"]]) {
    const file = agentLog({ root: "/r" } as Project, id, name);
    assert.ok(file.endsWith(join(".sandcastle", "logs", `agent-issue-${id}-${name}.log`)), file);
    assert.equal(logOwner(basename(file)), id);
  }
});

test("localStamp is local time with its UTC offset", () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  const stamp = localStamp(d);
  assert.ok(stamp.startsWith("2026-01-02 03:04:05 "), stamp);
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  assert.ok(stamp.endsWith(` ${sign}${hh}:${mm}`), stamp);
});

test("markLog creates the log, then appends and keeps what was there", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-logs-")), "logs", "agent-issue-1-impl-1.log");
  markLog(file, "run-1");
  writeFileSync(file, "earlier output\n", { flag: "a" });
  markLog(file, "run-1");
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("earlier output\n"));
  const marks = text.split("\n").filter((line) => line.startsWith("# run"));
  assert.equal(marks.length, 2);
  for (const line of marks) assert.match(line, /^# run run-1, \d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
});
