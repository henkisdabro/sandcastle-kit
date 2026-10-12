// The status view is TypeScript (src/status-*.ts) and keeps its own grouping (it needs one for derived states,
// and a group stored in the run record would go stale once a run dies). These tests hold it to the shared run
// record schema instead: it takes the ticket states' words and groups from the shared table, never a copy; its
// derived states and its outcome kinds are tables the type checker holds exhaustive over the shared sets; and every
// ticket state a fixture records is one the kit writes (test/status-facts.test.ts draws a ticket in each state, in the
// group the shared table gives it). No session, no model calls.
//
//   pnpm test:file test/status-contract.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isTicketState } from "../mod/hooks/run-record.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const rows = read("src", "status-rows.ts");

test("the view takes its words and groups from the shared table, and holds its other tables exhaustive over the shared sets", () => {
  assert.match(rows, /import \{[^}]*\bGROUPS\b[^}]*\bWORDS\b[^}]*\} from "\.\.\/mod\/hooks\/run-record\.ts"/, "the words and groups are the shared table's");
  // `tsc` fails a derived state or an outcome kind the table lacks, or one it adds: a looser type would let that drift.
  assert.match(rows, /const DERIVED: Record<\(typeof DERIVED_STATES\)\[number\], ViewGroup>/);
  assert.match(rows, /const OUTCOME_STATE: Record<OutcomeKind, string>/);
});

test("every ticket state in the status view's shell fixtures is a ticket state", () => {
  const fixtures = read("test", "status.test.sh");
  const states = [...fixtures.matchAll(/"state":\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(states.length >= 20, `found the fixtures' ticket states (${states.length})`);
  for (const s of states) assert.ok(isTicketState(s), `a status.test.sh fixture records "${s}", a ticket state the kit never writes`);
  // A requeued ticket is a queued one that carries the line, never a state of its own.
  assert.match(fixtures, /"state": "queued"[^}\n]*"requeued": "[^"]+"/, "a fixture holds a queued ticket with a requeued line");
});
