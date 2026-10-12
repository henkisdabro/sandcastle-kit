// When test/mod.test.ts runs `claude plugin test mod` a second time: only when every failure in the
// first run is the harness's own timeout. The samples are the harness's output format, so this runs
// without Claude Code on PATH.
//
//   pnpm test:file test/mod-retry.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { retryOnTimeout } from "./mod-retry.ts";

const PASS = "tests/mark.test.ts:\n(pass) hide turns the mark off [60.72ms]\n";
const TIMEOUT = "(fail) no argument reports the state, the count and its age [5001.48ms]\n  Error: timed out after 5000 ms\n";
const ASSERTION = "(fail) assertion fails [1.58ms]\n  AssertionError: expect(received).toBe()\n  \n  Expected: 2\n  Received: 1\n";
const summary = (pass: number, fail: number) => `\n ${pass} pass\n ${fail} fail\nRan ${pass + fail} tests across 1 file. [43.1s]\n`;

test("a run whose only failure is the harness's timeout is run once more", () => {
  assert.equal(retryOnTimeout(PASS + TIMEOUT + summary(1, 1)), true);
});

test("a run whose failures are all timeouts is run once more", () => {
  assert.equal(retryOnTimeout(PASS + TIMEOUT + TIMEOUT.replace("no argument", "other") + summary(1, 2)), true);
});

test("an assertion failure is never run again", () => {
  assert.equal(retryOnTimeout(PASS + ASSERTION + summary(1, 1)), false);
});

test("a timeout beside an assertion failure is never run again", () => {
  assert.equal(retryOnTimeout(PASS + TIMEOUT + ASSERTION + summary(1, 2)), false);
  assert.equal(retryOnTimeout(PASS + ASSERTION + TIMEOUT + summary(1, 2)), false);
});

test("an assertion failure that mentions a timeout in its message is never run again", () => {
  const mentions = "(fail) waits [12.0ms]\n  AssertionError: expect(received).toBe()\n  Expected: \"timed out after 5000 ms\"\n  Received: \"\"\n";
  assert.equal(retryOnTimeout(PASS + mentions + summary(1, 1)), false);
});

test("output that is no list of failed tests is never run again", () => {
  assert.equal(retryOnTimeout(""), false);
  assert.equal(retryOnTimeout(PASS + summary(1, 0)), false);
  assert.equal(retryOnTimeout("error: cannot load ./register.tsx\n" + TIMEOUT + summary(0, 1)), false);
  assert.equal(retryOnTimeout(TIMEOUT + "\nTypeError: x is not a function\n" + summary(0, 1)), false);
});
