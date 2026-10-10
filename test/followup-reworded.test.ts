// A follow-up reworded by a ticket's second session is a comment on the first one's issue, not a duplicate, and a
// closed earlier issue is no match target. A temp history.jsonl, the follow-up book over a fake tracker; no Docker,
// model or network.
//
//   pnpm test:file test/followup-reworded.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createFollowUpBook, filedBefore } = await import("../src/burndown.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-reworded-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const FILE = "src/sandbox.ts";
// Five significant words in common, the first naming no file and the second naming one only in its evidence.
const FIRST = "Image prune removes layers another project still uses";
const SECOND = "Pruning images removes layers still used by another project";

const book = (earlier: { title: string; id: string }[]) => {
  const made: string[] = [];
  const commented: string[] = [];
  const b = createFollowUpBook(
    { update: () => {} },
    {
      tracker: { ref: (id: string) => `#${id}`, create: (title: string) => (made.push(title), "100"), comment: (id: string) => void commented.push(id) },
      dryRun: false,
      write: async (fn) => fn(),
      exists: (path) => path === FILE,
      earlier: earlier.map((e) => ({ ...e, from: "7", phase: "implement" })),
    },
  );
  return { b, made, commented };
};

test("a title naming no file is the same finding as an earlier filing whose title shares three words with evidence naming a file", async () => {
  const { b, made, commented } = book([{ title: FIRST, id: "41" }]);
  b.push({ title: SECOND, evidence: `${FILE}:310 prunes by label only`, from: "7", phase: "implement" });
  assert.deepEqual(await b.file(), []);
  assert.deepEqual(made, []);
  assert.deepEqual(commented, ["41"]);
});

test("an earlier filing whose title names a file meets a reworded title that names none", async () => {
  const { b, made, commented } = book([{ title: `${FIRST} (${FILE}:310)`, id: "41" }]);
  b.push({ title: SECOND, evidence: "prunes by label only", from: "7", phase: "implement" });
  assert.deepEqual(await b.file(), []);
  assert.deepEqual(made, []);
  assert.deepEqual(commented, ["41"]);
});

test("one shared word is not enough when only one title names a file", async () => {
  const { b, made, commented } = book([{ title: FIRST, id: "41" }]);
  b.push({ title: "Prune logging is silent", evidence: `${FILE}:12`, from: "7", phase: "implement" });
  assert.equal((await b.file()).length, 1);
  assert.deepEqual(made, ["Prune logging is silent"]);
  assert.deepEqual(commented, []);
});

test("the same wording from another ticket is a new filing", async () => {
  const { b, made } = book([{ title: FIRST, id: "41" }]);
  b.push({ title: SECOND, evidence: `${FILE}:310`, from: "8", phase: "implement" });
  assert.equal((await b.file()).length, 1);
  assert.deepEqual(made, [SECOND]);
});

test("filedBefore leaves out the issues the tracker says are closed, and keeps one it cannot read", () => {
  const root = join(TMP, "history");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const f = (id: string) => ({ title: `Filing ${id}`, from: "7", phase: "review", id });
  writeFileSync(join(root, ".sandcastle/logs/history.jsonl"), [JSON.stringify({ followUps: [f("41"), f("42"), f("43")] }), JSON.stringify({ followUps: [f("41")] })].join("\n") + "\n");
  const asked: string[] = [];
  const state: Record<string, boolean | undefined> = { "41": true, "42": false, "43": undefined };
  const kept = filedBefore(root, undefined, (id) => (asked.push(id), state[id]));
  assert.deepEqual(kept.map((k) => k.id), ["42", "43"]);
  assert.deepEqual(asked, ["41", "42", "43"], "each issue is asked once");
  assert.equal(filedBefore(root).length, 4, "no tracker, no filter");
});
