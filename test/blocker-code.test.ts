// stripCode and parseRefs (src/blockers.ts): a blocker phrase inside fenced or inline code is an
// example, not a dependency. Pure: no network, no gh.
//
//   pnpm exec tsx --test test/blocker-code.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing blockers.ts pulls in sandbox.ts, which derives USER_CONFIG from this:
// nothing here may read the user's real config.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { parseRefs, stripCode } = await import("../src/blockers.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const base = { tracker: fakeTracker() } as unknown as Project;
const withProject = (extra: object) => ({ ...base, ...extra }) as unknown as Project;

const gh = (id: string) => ({ kind: "github", id });

test("a phrase inside a backtick fence is not a blocker", () => {
  assert.deepEqual(parseRefs(base, "Intro\n```\nBlocked by #12\n```\nDone"), []);
});

test("a phrase inside a tilde fence is not a blocker", () => {
  assert.deepEqual(parseRefs(base, "Intro\n~~~\nBlocked by #12\n~~~\nDone"), []);
});

test("a fence with an info string, indented under a list item, hides its phrase", () => {
  assert.deepEqual(parseRefs(base, "- item\n   ```text\n   Blocked by #12\n   ```\n"), []);
  assert.deepEqual(parseRefs(base, "- item\n     ```text\n     Blocked by #12\n     ```\n"), []);
});

test("a phrase inside inline code is not a blocker", () => {
  assert.deepEqual(parseRefs(base, "Write `Blocked by #12` to block."), []);
  assert.deepEqual(parseRefs(base, "Write ``Blocked by #12 and a ` tick`` to block."), []);
});

test("a real blocker line next to code examples still counts", () => {
  const body = ["Spec", "```", "Blocked by #12", "```", "Inline: `Depends on #13`", "", "Blocked by #14"].join("\n");
  assert.deepEqual(parseRefs(base, body), [gh("14")]);
});

test("a fence closes only on its own character, and on a run at least as long", () => {
  assert.deepEqual(parseRefs(base, "```\n~~~\nBlocked by #12\n```\n"), []);
  assert.deepEqual(parseRefs(base, "```\nexample\n````\nBlocked by #12\n"), [gh("12")]);
});

test("an unclosed fence hides what follows", () => {
  assert.deepEqual(parseRefs(base, "```\nexample\nBlocked by #12\n"), []);
});

test("a stray backtick does not swallow the next paragraph", () => {
  assert.deepEqual(parseRefs(base, "It's a ` stray\n\nBlocked by #12\n"), [gh("12")]);
});

test("a Linear key and a ticket file path inside inline code are not blockers", () => {
  const linear = withProject({ blockers: { linear: ["ENG"] } });
  assert.deepEqual(parseRefs(linear, "`Blocked by ENG-42`"), []);
  assert.deepEqual(parseRefs(linear, "Blocked by ENG-42"), [{ kind: "linear", id: "ENG-42" }]);
  const files = withProject({ tracker: fakeTracker({ kind: "files" }) });
  assert.deepEqual(parseRefs(files, "`Blocked by .scratch/cart/01-add-cart.md`"), []);
  assert.deepEqual(parseRefs(files, "Blocked by .scratch/cart/01-add-cart.md"), [{ kind: "file", id: ".scratch/cart/01-add-cart.md" }]);
});

test("CRLF line endings: a fenced example hides its phrase, a plain line counts", () => {
  assert.deepEqual(parseRefs(base, "```\r\nBlocked by #12\r\n```\r\n"), []);
  assert.deepEqual(parseRefs(base, "```\r\nBlocked by #12\r\n```\r\nBlocked by #14\r\n"), [gh("14")]);
});

test("text with no code comes back unchanged", () => {
  const text = "Plain text\n\nBlocked by #12, #13\n- a list\n";
  assert.equal(stripCode(text), text);
});
