// A green branch that did not land in its own run (a conflict at landing, a stopped run) lands in a
// later one as land-only, with no implementer or review to say `<unmet>` again: its head record
// carries the criterion, or the later landing would close the ticket. Plain temp directories; no
// git, Docker, model or network. The pipeline that writes and reads it is driven in test/pipeline.test.ts.
//
//   node --test test/unmet-carried.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { readHeads, recordHead } = await import("../src/run.ts");

const root = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-unmet-carried-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a green head keeps the criterion its agents left undone", (t) => {
  const dir = root(t);
  recordHead(dir, "4", { branch: "agent/issue-4", reviewed: "aaa" }, "run-1");
  recordHead(dir, "4", { branch: "agent/issue-4", green: "aaa", unmet: "The second module still uses the old rule." }, "run-1");
  assert.equal(readHeads(dir)["4"].unmet, "The second module still uses the old rule.");
});

test("a later green head with every criterion met drops the earlier criterion", (t) => {
  const dir = root(t);
  recordHead(dir, "4", { branch: "agent/issue-4", green: "aaa", unmet: "The second module still uses the old rule." }, "run-1");
  recordHead(dir, "4", { branch: "agent/issue-4", green: "bbb", unmet: undefined }, "run-2");
  assert.equal(readHeads(dir)["4"].unmet, undefined);
  assert.equal(readHeads(dir)["4"].green, "bbb");
});
