// The record of each branch's reviewed and green head (logs/heads.json): a
// broken file reads as no record, a write merges into one ticket's entry and
// leaves the rest. Plain temp directories; no git, Docker, model or network.
//
//   pnpm exec tsx --test test/heads.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { readHeads, recordHead } = await import("../src/run.ts");

const root = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-heads-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const logs = (dir: string) => join(dir, ".sandcastle/logs");
const file = (dir: string) => join(logs(dir), "heads.json");

test("a missing, unparseable or non-object file reads as no record", (t) => {
  const dir = root(t);
  assert.deepEqual(readHeads(dir), {});
  mkdirSync(logs(dir), { recursive: true });
  writeFileSync(file(dir), "not json");
  assert.deepEqual(readHeads(dir), {});
  writeFileSync(file(dir), "[]");
  assert.deepEqual(readHeads(dir), {});
  writeFileSync(file(dir), "null");
  assert.deepEqual(readHeads(dir), {});
});

test("a second write keeps the fields it does not give", (t) => {
  const dir = root(t);
  recordHead(dir, "7", { branch: "agent/issue-7", reviewed: "aaa" }, "run-1");
  recordHead(dir, "7", { branch: "agent/issue-7", green: "bbb" }, "run-2");
  const entry = readHeads(dir)["7"];
  assert.equal(entry.reviewed, "aaa");
  assert.equal(entry.green, "bbb");
  assert.equal(entry.run, "run-2");
  assert.equal(entry.branch, "agent/issue-7");
  assert.ok(!Number.isNaN(Date.parse(entry.at)));
});

test("another ticket's entry is left untouched", (t) => {
  const dir = root(t);
  recordHead(dir, "7", { branch: "agent/issue-7", reviewed: "aaa" }, "run-1");
  const before = readHeads(dir)["7"];
  recordHead(dir, "slug-03", { branch: "agent/issue-slug-03", green: "ccc" }, "run-1");
  const all = readHeads(dir);
  assert.deepEqual(all["7"], before);
  assert.equal(all["slug-03"].green, "ccc");
});

test("the file is whole JSON with a trailing newline and no temp file is left", (t) => {
  const dir = root(t);
  recordHead(dir, "7", { branch: "agent/issue-7", reviewed: "aaa" }, "run-1");
  const text = readFileSync(file(dir), "utf8");
  assert.ok(text.endsWith("\n"));
  assert.doesNotThrow(() => JSON.parse(text));
  assert.ok(!existsSync(`${file(dir)}.tmp`));
  assert.deepEqual(readdirSync(logs(dir)), ["heads.json"]);
});

test("a root with no .sandcastle gets the file and its directory", (t) => {
  const dir = root(t);
  assert.ok(!existsSync(join(dir, ".sandcastle")));
  recordHead(dir, "7", { branch: "agent/issue-7", green: "bbb" }, "run-1");
  assert.ok(existsSync(file(dir)));
});
