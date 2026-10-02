// The shared tracker fixture (test/fixtures.ts) follows the config loader's defaults, and no test
// builds a full `tracker: { ... }` literal of its own.
//
//   pnpm exec tsx --test test/fixtures.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { resolveTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");

test("fakeTracker() is what the loader resolves for a project with no tracker docs or config", () => {
  assert.deepEqual(fakeTracker(), resolveTracker(mkdtempSync(join(tmpdir(), "sandcastle-test-"))));
  assert.equal(fakeTracker().kind, "github");
});

test("overrides replace single fields and keep the rest of the defaults", () => {
  const files = fakeTracker({ kind: "files", dir: "tickets" });
  assert.equal(files.kind, "files");
  assert.equal(files.dir, "tickets");
  assert.deepEqual(files.done, fakeTracker().done);
  assert.equal(files.held, fakeTracker().held);
  assert.equal(files.triage, fakeTracker().triage);
});

test("no test builds a full tracker literal unless the line above says its shape is the point", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const offenders: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".test.ts"))) {
    const lines = readFileSync(join(dir, name), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/\btracker: \{[^}]*\bheld:/.test(line) && !/tracker shape/.test(lines[i - 1] ?? "")) offenders.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "use fakeTracker() from test/fixtures.ts, or keep the literal with a comment above it containing \"tracker shape\"");
});
