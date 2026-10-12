// The keys the status view reads from its terminal (src/status-keys.ts): an escape sequence is one key and what
// follows it in the same read is keys of its own, so "\x1b[Aq" (an arrow, then q, typed fast or pasted) still
// closes the Herdr popup; a read that ends inside a sequence holds it for the next.
//
//   pnpm test:file test/status-keys.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { keysOf } from "../src/status-keys.ts";

test("an arrow key and the q after it in one read are two keys", () => {
  assert.deepEqual(keysOf("\x1b[Aq"), { keys: ["\x1b[A", "q"], rest: "" });
  assert.deepEqual(keysOf("\x1bOBq"), { keys: ["\x1bOB", "q"], rest: "" });
  assert.deepEqual(keysOf("\x1b[1;5Cx\x1b[B"), { keys: ["\x1b[1;5C", "x", "\x1b[B"], rest: "" });
});

test("plain keys are one each, and Esc then Esc is the Esc key first", () => {
  assert.deepEqual(keysOf("ab"), { keys: ["a", "b"], rest: "" });
  assert.deepEqual(keysOf("\x1b\x1b[A"), { keys: ["\x1b", "\x1b[A"], rest: "" });
});

test("a read that ends inside a sequence, or on Esc alone, holds it for the next read", () => {
  assert.deepEqual(keysOf("\x1b"), { keys: [], rest: "\x1b" });
  assert.deepEqual(keysOf("x\x1b["), { keys: ["x"], rest: "\x1b[" });
  assert.deepEqual(keysOf("\x1b[1;5"), { keys: [], rest: "\x1b[1;5" });
  assert.deepEqual(keysOf("\x1bO"), { keys: [], rest: "\x1bO" });
  // The next read completes it.
  assert.deepEqual(keysOf("\x1b[" + "Aq"), { keys: ["\x1b[A", "q"], rest: "" });
});
