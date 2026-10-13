// `burndown()` needs Docker, so no test drives it: this holds that it hands the estimate each ticket's body length and writes
// it on every timings line, the two things `sizeOf` (src/run.ts) sizes a ticket by.
//
//   pnpm test:file test/estimate-body-call-site.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");

test("the start estimate is handed each ticket's body length", () => {
  assert.match(source, /bodyChars: candidates\.map\(\(i\) => bodyChars\.get\(i\.id\) \?\? 0\)/);
});

test("every timings line records the ticket's body length beside its Touches count", () => {
  assert.match(source, /\.\.\.\(bodyChars\.has\(issue\) \? \{ bodyChars: bodyChars\.get\(issue\) \} : \{\}\)/);
});
