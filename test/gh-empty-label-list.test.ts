// `gh label list --search X` prints nothing at all - not `[]` - when no label matches. Both callers
// must read that as "no such label": the run creates needs-triage, and doctor reports the queue
// label missing with its FIX line, instead of a JSON error and "not checked".
//
//   node --test test/gh-empty-label-list.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { ensureTriageLabel } = await import("../src/tracker.ts");
const { queueLabel } = await import("../src/doctor.ts");

test("ensureTriageLabel creates the label when the search prints nothing", () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    ensureTriageLabel("needs-triage", (args) => (calls.push(args.join(" ")), ""));
  } finally {
    console.log = real;
  }
  assert.deepEqual(lines, []);
  assert.ok(calls.some((c) => c.startsWith("label create needs-triage")), calls.join("\n"));
});

test("doctor's queue-label check says missing when the search prints nothing", () => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    assert.equal(queueLabel(tmpdir(), "ready-for-agent").state, "missing");
  } finally {
    process.env.PATH = path;
  }
});
