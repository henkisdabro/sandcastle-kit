// `changelog: true`: a green branch that did not land in its own run (held, a conflict at landing, a
// stopped run) lands in a later one as land-only, with no implementer or review to give its
// `<changelog>` lines again: its head record carries them, or they reach no closing summary. Plain
// temp directories; no git, Docker, model or network.
//
//   pnpm exec tsx --test test/changelog-carried.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { readHeads, recordHead } = await import("../src/run.ts");

const root = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-changelog-carried-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a green head keeps the changelog lines its agents gave", (t) => {
  const dir = root(t);
  recordHead(dir, "4", { branch: "agent/issue-4", reviewed: "aaa" }, "run-1");
  recordHead(dir, "4", { branch: "agent/issue-4", green: "aaa", changelog: ["Added: a key", "Fixed: a crash"] }, "run-1");
  assert.deepEqual(readHeads(dir)["4"].changelog, ["Added: a key", "Fixed: a crash"]);
});

test("a later green head with no lines drops the earlier ones", (t) => {
  const dir = root(t);
  recordHead(dir, "4", { branch: "agent/issue-4", green: "aaa", changelog: ["Added: a key"] }, "run-1");
  recordHead(dir, "4", { branch: "agent/issue-4", green: "bbb", changelog: undefined }, "run-2");
  assert.equal(readHeads(dir)["4"].changelog, undefined);
});

test("the pipeline writes the lines with the green head and reads them back for a land-only branch", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  // Without the record, a land-only branch's lines start empty and its landing lists none.
  assert.match(src, /const changelog: string\[\] = landOnly \? \[\.\.\.\(readHeads\(project\.root\)\[issue\.id\]\?\.changelog \?\? \[\]\)\] : \[\];/);
  // Written even when undefined, so a later green head with no lines replaces an earlier one.
  assert.match(src, /noteHead\(issue\.id, branch, \{ green: head, unmet: unmetNote, gates: gated\.gates, changelog: changelogNote, changelogDropped: changelogDropped \|\| undefined \}\)/);
  // The same lines the outcome carries to the run record.
  assert.match(src, /changelog: changelogNote,/);
});
