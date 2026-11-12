// The sidebar counts a ticket whose work was left uncommitted as needing a person, as the
// status view (status.sh `style_of`) and the Claude Code mod do (src/herdr.ts).
//
//   pnpm test:file test/herdr-counts.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TicketRecord } from "../mod/hooks/run-record.ts";
import { runCounts } from "../src/herdr.ts";

test("runCounts: an uncommitted ticket needs you", () => {
  const t = (state: TicketRecord["state"]): TicketRecord => ({ state });
  const counts = runCounts({ a: t("uncommitted"), b: t("merged"), c: t("implement") });
  assert.deepEqual(counts, { working: 1, needsYou: 1, merged: 1, total: 3 });
});

test("runCounts: a ticket a later turn retries is neither needs-you nor working, and is counted as retried", () => {
  const t = (state: TicketRecord["state"]): TicketRecord => ({ state });
  assert.deepEqual(runCounts({ a: t("not landed"), b: t("merged") }, false, new Set(["a"])), { working: 0, needsYou: 0, merged: 1, total: 2, retried: 1 });
  // A retried id that is no ticket of the run counts nothing.
  assert.deepEqual(runCounts({ b: t("merged") }, false, new Set(["z"])), { working: 0, needsYou: 0, merged: 1, total: 1 });
});
