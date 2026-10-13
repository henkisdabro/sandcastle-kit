// A conflict found before landing on a second attempt, which the requeue-once rule would have sent back once
// more had the run not stopped starting tickets (`wouldRetry`): the record says the branch no longer merges
// onto the base, and that it would have been retried, never that it conflicted again after a requeue.
// Pure: `describe` in src/ledger.ts. No Docker, no model, no network.
//
//   pnpm test:file test/ledger-unretried-conflict.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { describe } = await import("../src/ledger.ts");
type Finished = import("../src/ledger.ts").Finished;

const conflict = { files: ["b.txt"], with: ["3"] };
const conflicted: Finished = { issue: "2", branch: "agent/issue-2", status: "conflict", conflict, commits: 1, repairs: 0, gates: [] };

test("a second conflict before landing that would have been retried says the branch no longer merges, and names only its own conflict", () => {
  const s = describe({ kind: "conflict", outcome: conflicted, conflict, attempts: 2, again: { kind: "conflict", with: ["1"], found: "landing" }, wouldRetry: true }, { base: "main", gateNames: "test" });
  const line = "with #3: b.txt; would have been retried, but the run had stopped starting tickets";
  assert.deepEqual(s.record, { state: "conflict", note: `no longer merges onto main: ${line}`, files: ["b.txt"] });
  assert.deepEqual(s.outcome, { kind: "conflict", with: ["3"], text: `merge conflict before landing: ${line}` });
});
