// A partly-done ticket whose remainder only a person can do is not re-run by a drain: the agent's
// explicit `<unmet who="person">` marker says so, and a note written without it is read by its words
// ("needs a deploy", "access I don't have", a file "agents may not edit"). A plain unfinished
// criterion stays re-runnable. The words are grepped by status.sh too, so both readers are held to
// the same phrases. No repo, Docker, model or network.
//
//   node --test test/needs-person.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing burndown.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { unmetOf } = await import("../src/burndown.ts");
const { needsDecision, partialRerunnable, remainderNote } = await import("../src/autonomy.ts");
type Facts = import("../src/report.ts").Facts;

const PERSON_PHRASES = [
  "the change needs a deploy before the last criterion can be checked",
  "the fix is on a branch that needs a pushed PR to be reviewed",
  "the dashboard setting needs access I don't have",
  "the dashboard setting needs access I do not have",
  "the config file is one agents may not edit",
  "editing the lockfile is not allowed in this repository",
  "the migration cannot be run from this sandbox",
  "the migration can't be run from here",
  "it needs production data to reproduce",
  "the check needs a login to the vendor site",
  "the webhook secret needs the dashboard of the payment provider",
  "which of the two formats to keep is the maintainer's decision",
];
const ROUTINE = ["the export module does not use the new rule yet", "the README does not mention the new flag", "the retry path is not covered by a test"];

test("each phrase that names a person's work makes the remainder a person's", () => {
  for (const phrase of PERSON_PHRASES) assert.equal(needsDecision(phrase), true, phrase);
});

test("a plain unfinished criterion stays re-runnable", () => {
  for (const phrase of ROUTINE) assert.equal(needsDecision(phrase), false, phrase);
});

test('<unmet who="person"> marks the remainder a person\'s whatever its words say', () => {
  const said = unmetOf('Done but one thing.\n\n<unmet who="person">the export module does not use the new rule yet</unmet>\n');
  assert.equal(said, "needs a person: the export module does not use the new rule yet");
  assert.equal(needsDecision(said!), true);
  assert.equal(unmetOf("<unmet who='person'>the retry path is not covered</unmet>"), "needs a person: the retry path is not covered");
  assert.equal(unmetOf('<unmet who="PERSON" >the retry path is not covered</unmet>'), "needs a person: the retry path is not covered");
});

test("an <unmet> line without the marker, or with another one, is read as before", () => {
  assert.equal(unmetOf("<unmet>the retry path is not covered</unmet>"), "the retry path is not covered");
  assert.equal(unmetOf('<unmet who="agent">the retry path is not covered</unmet>'), "the retry path is not covered");
  assert.equal(needsDecision(unmetOf('<unmet who="agent">the retry path is not covered</unmet>')!), false);
});

test("the echoed placeholder and a marked tag in prose are not an <unmet> line", () => {
  assert.equal(unmetOf('<unmet who="person">...</unmet>'), undefined);
  assert.equal(unmetOf('I could write `<unmet who="person">x</unmet>` here, but every criterion is met.'), undefined);
  assert.equal(unmetOf('```\n<unmet who="person">x</unmet>\n```\nAll met.'), undefined);
});

test("a marked line is not re-run by the autonomy loop, a plain one is", () => {
  const facts = (unmet: string) =>
    ({ partial: ["1"], tickets: { "1": { state: "merged", unmet } } }) as unknown as Facts;
  assert.deepEqual(partialRerunnable(facts(unmetOf('<unmet who="person">the retry path is not covered</unmet>')!)), []);
  assert.deepEqual(partialRerunnable(facts(unmetOf("<unmet>the retry path is not covered</unmet>")!)), ["1"]);
  assert.match(remainderNote("needs a person: x"), /needs a person.*hold label/);
});

test("status.sh greps the same phrases as needsDecision", () => {
  const sh = readFileSync(join(import.meta.dirname, "..", "status.sh"), "utf8");
  const pattern = sh.match(/grep -Eiq '(\(\^\|\[\^\[:alnum:\]_\]\)\(decisions[^']*)'/)?.[1];
  assert.ok(pattern, "status.sh's person pattern was not found");
  for (const phrase of [...PERSON_PHRASES, ...ROUTINE, "needs a person: x"]) {
    const found: { status: number | null } = spawnSync("grep", ["-Eiq", pattern], { input: phrase, stdio: ["pipe", "ignore", "ignore"] });
    assert.equal(found.status === 0, needsDecision(phrase), phrase);
  }
});
