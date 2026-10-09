// With a tracker agents do not write to (Markdown ticket files), the implementer's prose for the ticket is in a
// `<report>` block at the end of its final message, so the closing paragraph a full review is shown comes from it:
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
const { closingParagraphOf, implSaidView } = await import("../src/burndown.ts");

const CAVEAT = "I did not check that the wait tests fail without their changes.";

test("the closing paragraph of a multi-paragraph report is its last, without the closing tag", () => {
  const said = closingParagraphOf(`Done.\n\n<report>\nAdded the wait report.\n\n${CAVEAT}\n</report>\n<promise>COMPLETE</promise>`);
  assert.equal(said, CAVEAT);
  assert.doesNotMatch(implSaidView(said), /report>/);
});

test("a one-line report is quoted without its tags", () => {
  assert.equal(closingParagraphOf(`Done.\n\n<report>Added the wait report. ${CAVEAT}</report>\n\n<promise>COMPLETE</promise>`), `Added the wait report. ${CAVEAT}`);
});
