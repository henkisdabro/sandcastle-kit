// `gh issue list` stops at its --limit without saying so; the GitHub tracker
// warns, on stderr, when a list comes back exactly full. A fake `gh` first on
// PATH stands in for the real one, so no network is needed.
//
//   node --test test/tracker-limit.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
// A plain sh script prints the JSON file beside it: the same on macOS and Linux.
const gh = join(dir, "gh");
writeFileSync(gh, `#!/bin/sh\ncat "${join(dir, "issues.json")}"\n`);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const project = { root: dir, label: "ready-for-agent", tracker: fakeTracker() } as any;

const issues = (n: number) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, body: "", labels: [], updatedAt: "2026-01-01T00:00:00Z" })));

// Everything the tracker writes to stderr while `fn` runs.
const stderrOf = (fn: () => unknown) => {
  const written: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = real;
  }
  return written;
};

test("500 open tickets back: one warning naming 500, on stderr", () => {
  writeFileSync(join(dir, "issues.json"), issues(500));
  const written = stderrOf(() => assert.equal(makeTracker(project).open(false).length, 500));
  assert.equal(written.length, 1);
  assert.match(written[0], /gh returned the limit of 500 open tickets; any beyond it are not seen\./);
});

test("499 back: no warning", () => {
  writeFileSync(join(dir, "issues.json"), issues(499));
  assert.deepEqual(stderrOf(() => makeTracker(project).open(false)), []);
});

test("a full queue list names the label, and counts before the needs-human filter", () => {
  const all = JSON.parse(issues(500));
  all[0].labels = [{ name: "needs-human" }];
  writeFileSync(join(dir, "issues.json"), JSON.stringify(all));
  const written: string[] = stderrOf(() => assert.equal(makeTracker(project).queued(false).length, 499));
  assert.equal(written.length, 1);
  assert.match(written[0], /500 open tickets labelled ready-for-agent;/);
});
