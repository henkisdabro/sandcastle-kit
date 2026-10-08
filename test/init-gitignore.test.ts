// `sandcastle init` appending to an existing .sandcastle/.gitignore: an entry must never be glued
// onto a last line that has no newline (".env" + "logs/" becoming ".envlogs/" un-ignores both).
// A throwaway repo, so no Docker and no network.
//
//   pnpm test:file test/init-gitignore.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing init.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { init, SANDCASTLE_IGNORES } = await import("../src/init.ts");

/** A temp git project whose .sandcastle/.gitignore holds `existing`, then init's result. */
const initWith = (t: { after: (fn: () => void) => void }, existing: string): string => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/.gitignore"), existing);
  const log = console.log;
  console.log = () => {};
  try {
    init(root);
  } finally {
    console.log = log;
  }
  return readFileSync(join(root, ".sandcastle/.gitignore"), "utf8");
};

test("a .gitignore with no final newline keeps its last entry and gains every other on its own line", (t) => {
  const out = initWith(t, ".env");
  const lines = out.split("\n");
  for (const entry of SANDCASTLE_IGNORES) assert.equal(lines.filter((l) => l === entry).length, 1, `${entry} on its own line, once`);
  assert.equal(lines[0], ".env");
  assert.equal(out, SANDCASTLE_IGNORES.join("\n") + "\n");
});

test("a .gitignore with a final newline gains no blank line", (t) => {
  const out = initWith(t, ".env\n");
  assert.equal(out, SANDCASTLE_IGNORES.join("\n") + "\n");
  assert.ok(!out.includes("\n\n"));
});

test("an unrelated last line with no newline is kept whole", (t) => {
  const out = initWith(t, "node_modules");
  const lines = out.split("\n");
  assert.equal(lines[0], "node_modules");
  for (const entry of SANDCASTLE_IGNORES) assert.ok(lines.includes(entry), `${entry} on its own line`);
});
