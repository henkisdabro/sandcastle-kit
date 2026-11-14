// When test/herdr-app-layout.test.ts runs `herdr-app check` a second time: only when the check failed
// with the error `interrupted`. The samples are herdr-app 0.1.15's own output (`<dir>` is the mod's
// temp folder), so this runs without the Herdr app installed.
//
//   pnpm test:file test/herdr-app-retry.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { retryOnInterrupted } from "./herdr-app-retry.ts";

const INTERRUPTED = "interrupted\n    at render (<dir>/main.js?v=1:1:105)\n\n\ncheck failed: <dir>\n";
const INTERRUPTED_REAL =
  "interrupted\n    at segs (<dir>/main.js:697)\n    at lane (<dir>/main.js:726)\n    at header (<dir>/main.js:746)\n    at render (<dir>/main.js:896)\ncheck failed: <dir>\n";
const THROWN = "boom\n    at render (<dir>/main.js?v=1:1:100)\n\n\ncheck failed: <dir>\n";
const SYNTAX = "unexpected token in expression: '}'\n    at <dir>/main.js?v=1:1:76\n\n\ncheck failed: <dir>\n";
const UNKNOWN =
  "unknown element method `no_such_method`; it is neither a style method nor one of child, children, when, ...\n    at <anonymous> (eval_script:22:30)\n    at render (<dir>/main.js?v=1:1:103)\n\n\ncheck failed: <dir>\n";
const PASSED = "check passed: <dir>\n";
// The layout test's failure text: `${r.stdout}\n${r.stderr}`, stdout empty when a render is interrupted.
const asLayoutTest = (stdout: string, stderr: string) => `${stdout}\n${stderr}`;

test("an interrupted render is run once more", () => {
  assert.equal(retryOnInterrupted(INTERRUPTED), true);
  assert.equal(retryOnInterrupted(asLayoutTest("", INTERRUPTED)), true);
});

test("an interrupted render with the mod's own frames is run once more", () => {
  assert.equal(retryOnInterrupted(INTERRUPTED_REAL), true);
  assert.equal(retryOnInterrupted(asLayoutTest("", INTERRUPTED_REAL)), true);
});

test("a render that throws is never run again", () => {
  assert.equal(retryOnInterrupted(asLayoutTest("", THROWN)), false);
});

test("a syntax error is never run again", () => {
  assert.equal(retryOnInterrupted(asLayoutTest("", SYNTAX)), false);
});

test("an unknown element method is never run again", () => {
  assert.equal(retryOnInterrupted(asLayoutTest("", UNKNOWN)), false);
});

test("an error that only contains the word is never run again", () => {
  const loading = "interrupted while loading\n    at <dir>/main.js?v=1:1:76\n\n\ncheck failed: <dir>\n";
  assert.equal(retryOnInterrupted(asLayoutTest("", loading)), false);
  assert.equal(retryOnInterrupted(asLayoutTest("", "was interrupted\n\ncheck failed: <dir>\n")), false);
});

test("a pass, or output that is no failed check, is never run again", () => {
  assert.equal(retryOnInterrupted(asLayoutTest(PASSED, "")), false);
  assert.equal(retryOnInterrupted(""), false);
  assert.equal(retryOnInterrupted("interrupted\n"), false);
});
