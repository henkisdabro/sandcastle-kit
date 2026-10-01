// errorLine is what a summary line shows of a failure: "closing the ticket failed: Error: gh issue
// close failed: ..." carried String(error)'s prefix. The message alone, or the command's last stderr line.
//
//   pnpm exec tsx --test test/error-line.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { errorLine } from "../src/sandbox.ts";

test("an Error gives its message, with no Error: prefix", () => {
  assert.equal(errorLine(new Error("gh issue close failed: HTTP 502\nmore")), "gh issue close failed: HTTP 502");
});

test("a failed command gives its last stderr line", () => {
  assert.equal(errorLine(Object.assign(new Error("Command failed"), { stderr: "warning\nHTTP 502: Bad Gateway\n" })), "HTTP 502: Bad Gateway");
});
