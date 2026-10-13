// With a tracker agents do not write to (Markdown ticket files), the implementer's prose for the ticket is in a
// `<report>` block at the end of its final message, so the message a full review is shown comes from it:
// its words reach the reviewer, the kit's `<report>` tags do not. No Docker, model, gh or network.
//
//   pnpm test:file test/implementer-said-report.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { implementerSaidOf, implSaidView } = await import("../src/burndown.ts");

const CAVEAT = "I did not check that the wait tests fail without their changes.";

test("a multi-paragraph report is quoted whole, without its tags", () => {
  const said = implementerSaidOf(`Done.\n\n<report>\nAdded the wait report.\n\n${CAVEAT}\n</report>\n<promise>COMPLETE</promise>`);
  assert.equal(said, `Done.\n\nAdded the wait report.\n\n${CAVEAT}`);
  assert.doesNotMatch(implSaidView(said), /report>/);
});

test("a one-line report is quoted without its tags", () => {
  assert.equal(implementerSaidOf(`Done.\n\n<report>Added the wait report. ${CAVEAT}</report>\n\n<promise>COMPLETE</promise>`), `Done.\n\nAdded the wait report. ${CAVEAT}`);
});
