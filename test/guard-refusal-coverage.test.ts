// Every refusal code a guard can give is produced by at least one bypass-corpus row (test/fixtures/guard-bypasses.json),
// whose harness in test/guard-bypasses.test.ts asserts the code: the `ReasonCode`s of src/verdict.ts and the
// `[git-guard:<code>]`s of container/git-guard.sh. A new refusal branch cannot ship without a row that reaches it, and
// a code no row reaches any more is a branch that was deleted or can no longer be hit.
//
//   pnpm test:file test/guard-refusal-coverage.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REASON_CODES } from "../src/verdict.ts";

type Row = { guard: string; expect: "refuse" | "allow"; code?: string };
const rows: Row[] = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/guard-bypasses.json"), "utf8"));

// The guards whose harness checks a refusing row's code; `protected-path` and `lean-apply` answer with paths only.
const VERDICT_GUARDS = new Set(["protected-changes", "large-files", "token"]);
const produced = (guards: (g: string) => boolean) => new Set(rows.filter((r) => r.expect === "refuse" && r.code && guards(r.guard)).map((r) => r.code!));

// The codes the script can print: `deny "<what>" <code>`, and `unreadable "<what>" [<code>]`, whose default is
// `unreadable`. Read from the script, so a code added there needs a row here.
const guardScript = readFileSync(join(import.meta.dirname, "../container/git-guard.sh"), "utf8");
const gitGuardCodes = new Set<string>();
for (const m of guardScript.matchAll(/\bdeny "(?:[^"\\]|\\.)*" ([a-z-]+)/g)) gitGuardCodes.add(m[1]);
for (const m of guardScript.matchAll(/\bunreadable "(?:[^"\\]|\\.)*"(?: ([a-z-]+))?/g)) gitGuardCodes.add(m[1] ?? "unreadable");

test("every ReasonCode is produced by a corpus row", () => {
  const hit = produced((g) => VERDICT_GUARDS.has(g));
  assert.deepEqual(REASON_CODES.filter((c) => !hit.has(c)), []);
});

test("every git-guard code is produced by a corpus row", () => {
  // The script's own codes, as read: a reading that found none would pass every row.
  for (const code of ["push", "shared-repo", "unreadable", "alias"]) assert.ok(gitGuardCodes.has(code), `${code} not read from git-guard.sh`);
  const hit = produced((g) => g === "git-guard");
  assert.deepEqual([...gitGuardCodes].filter((c) => !hit.has(c)).sort(), []);
});

test("every code a corpus row names is one a guard can give", () => {
  const known = (row: Row) => (row.guard === "git-guard" ? gitGuardCodes.has(row.code!) : (REASON_CODES as readonly string[]).includes(row.code!));
  assert.deepEqual(rows.filter((r) => r.code && !known(r)), []);
  // A code on a row whose harness ignores it would count here while proving nothing there.
  assert.deepEqual(rows.filter((r) => r.code && r.guard !== "git-guard" && !VERDICT_GUARDS.has(r.guard)), []);
});
