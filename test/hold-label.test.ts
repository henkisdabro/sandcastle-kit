// hold() creates the hold label (ready-for-human) without --force, so a repo's own colour
// and description survive, and ignores only "already exists". A fake `gh`
// first on PATH logs its arguments, so no network is needed.
//
//   pnpm exec tsx --test test/hold-label.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { makeTracker } = await import("../src/tracker.ts");

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
const log = join(dir, "calls.log");
// A plain sh script with printf: the same on macOS and Linux.
const gh = join(dir, "gh");
writeFileSync(
  gh,
  `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1 $2" = "label create" ]; then
  case "$FAKE_GH_LABEL" in
    exists) printf 'label with name "ready-for-human" already exists; use --force to update its color and description\\n' >&2; exit 1 ;;
    forbidden) printf 'HTTP 403: Resource not accessible by integration\\n' >&2; exit 1 ;;
  esac
fi
exit 0
`,
);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const project = { root: dir, label: "ready-for-agent", tracker: { kind: "github", held: "ready-for-human", triage: "needs-triage" } } as any;

const calls = () => {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const reset = () => writeFileSync(log, "");

test("label already exists: hold does not throw, never passes --force, still edits and comments", () => {
  reset();
  process.env.FAKE_GH_LABEL = "exists";
  makeTracker(project).hold("5", "why");
  const seen = calls();
  const create = seen.find((c) => c.startsWith("label create"));
  assert.ok(create, "label create was called");
  assert.doesNotMatch(create, /--force/);
  assert.ok(seen.includes("issue edit 5 --remove-label ready-for-agent --add-label ready-for-human"));
  assert.ok(seen.includes("issue comment 5 --body why"));
});

test("label created fresh: hold goes on to edit and comment", () => {
  reset();
  process.env.FAKE_GH_LABEL = "";
  makeTracker(project).hold("5", "why");
  assert.equal(calls().length, 3);
});

test("any other label failure still stops the hold", () => {
  reset();
  process.env.FAKE_GH_LABEL = "forbidden";
  assert.throws(() => makeTracker(project).hold("5", "why"), /403/);
  assert.deepEqual(calls().filter((c) => c.startsWith("issue")), []);
});
