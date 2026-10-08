// The skill points a host agent at the run record instead of the output log and the status table,
// and says where the mod's note appears. Skill-only text, so this pins what an agent must find.
//
//   pnpm test:file test/skill-run-record.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DERIVED_STATES, WORDS } from "../mod/hooks/run-record.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");
const run = flat(read("skill", "run.md"));
const status = flat(read("skill", "status.md"));
const stepOf = (n: number, next: number) =>
  flat(read("skill", "run.md").match(new RegExp(`^${n}\\. \\*\\*[\\s\\S]*?(?=^${next}\\. )`, "m"))?.[0] ?? "");

test("status.md sends an agent to run.json's tickets, stage and exitCode, not the table or a sleep loop", () => {
  assert.match(status, /read `\.sandcastle\/logs\/run\.json` instead of parsing `sandcastle status 0`'s table/);
  for (const field of ["`tickets`", "`state`", "`stage`", "`exitCode`"]) assert.ok(status.includes(field), field);
  assert.match(status, /run `sandcastle wait`.*never a loop of `sleep` and `grep`/);
});

test("run.md reads the estimate once from the output log and says what to do when it is not there", () => {
  assert.match(run, /read the log once for the line starting `Estimate`/);
  assert.match(run, /Do not poll for it or sleep and grep: if it is not there yet/);
});

test("run.md's step 3 says the mod's note ends SKILL.md's text and survives compaction", () => {
  const step = stepOf(3, 4);
  assert.match(step, /appends a note saying so to the end of the sandcastle skill's own text \(SKILL\.md\), not to this file/);
  assert.match(step, /still holds after the conversation is compacted/);
});

test("the mod's note is appended to the skill's text, which is the file run.md names", () => {
  const register = read("mod", "hooks", "register.tsx");
  assert.match(register, /text: out\.text \+ NOTE/);
  assert.match(register, /skip `sandcastle wait` in step 3 of the run action/);
});

test("status.md names the record's state wherever it differs from the view's word, and the states the record never holds", () => {
  // A host agent reads run.json's `state`; the list below the paragraph is in the view's words, so
  // an agent that waits for `gate red` in the record waits for ever unless the difference is named.
  const paragraph = status.match(/To check one ticket.*?Read it once per question\./)?.[0] ?? "";
  for (const [state, word] of Object.entries(WORDS)) assert.ok(paragraph.includes(`\`${state}\` (\`${word}\`)`), `${state} -> ${word}`);
  for (const derived of ["stalled", "orphaned", "left over"]) {
    assert.ok((DERIVED_STATES as readonly string[]).includes(derived), derived);
    assert.ok(paragraph.includes(`\`${derived}\``), derived);
  }
  assert.match(paragraph, /the record never holds them/);
});
