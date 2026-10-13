// The cold read in queue.md (step 5): a fresh subagent that is given only the final ticket body
// and comments tests the "closed spec" bar before the queue label goes on. audit.md calls the step
// for its ready findings instead of repeating it.
//
//   pnpm test:file test/skill-cold-read.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(join(root, "skill", f), "utf8").replace(/\r\n/g, "\n");
const queueRaw = read("queue.md");
const auditRaw = read("audit.md");
const flat = (s: string) => s.replace(/\s+/g, " ");
const audit = flat(auditRaw);

const at = (re: RegExp) => queueRaw.search(re);
const step = (n: number) => queueRaw.match(new RegExp(`^${n}\\. \\*\\*[\\s\\S]*?(?=^\\d+\\. \\*\\*|^## |(?![\\s\\S]))`, "m"))?.[0] ?? "";
const coldRead = flat(step(5));
const brief = flat(queueRaw.match(/Brief for the cold reader\n([\s\S]*?)```/)?.[1] ?? "");

test("the cold read sits after the decisions are written and before the label goes on", () => {
  const decisions = at(/^4\. \*\*Close the spec\.\*\*/m);
  const cold = at(/^5\. \*\*Cold read\.\*\*/m);
  const label = at(/^6\. \*\*Label\.\*\*/m);
  const report = at(/^7\. \*\*Report\*\*/m);
  assert.ok(decisions >= 0 && decisions < cold && cold < label && label < report, [decisions, cold, label, report].join(" "));
  assert.ok(coldRead.includes("after step 4 and before the queue label goes on"));
  assert.ok(!step(4).includes("add the queue label"), "step 4 still labels");
});

test("only a ticket written or changed in this session is read, and a fresh read is reused", () => {
  assert.ok(coldRead.includes("written or changed in this session"));
  assert.ok(coldRead.includes("already queued"));
  assert.ok(coldRead.includes("`coldRead.at` is later than the ticket's `updatedAt`"));
});

test("the reader is a fresh subagent given only the final body and comments", () => {
  assert.ok(coldRead.includes("fresh read-only subagent given only the final ticket body and comments"));
  assert.ok(coldRead.includes("not step 2's notes"));
  assert.ok(brief.includes("with no chat and no one to ask"));
  assert.ok(brief.includes("you have been told nothing else"));
  assert.ok(brief.includes("Read-only"));
});

test("the reader flags only a missing decision, a contradiction or an unreachable prerequisite", () => {
  assert.ok(brief.includes("outcomes that differ materially and that the ticket's acceptance checks would not tell apart"));
  assert.ok(brief.includes("the check that would tell them apart"));
  assert.ok(brief.includes("Flag only: a missing decision, a contradiction, or a prerequisite you could not reach"));
  assert.ok(brief.includes("that is not a gap"));
  assert.ok(brief.includes("Never choose the requirement yourself"));
  assert.ok(coldRead.includes("is the implementer's job, not a gap"));
});

test("each ambiguity goes back through the decision question, and the reader never picks", () => {
  assert.ok(coldRead.includes("goes back through step 3 as a decision question"));
  assert.ok(coldRead.includes("It never picks the requirement itself"));
});

test("without subagents the harness says it is not an independent read", () => {
  assert.ok(coldRead.includes("Without subagents, do the step yourself and say plainly that it is not an independent read"));
});

test("each read and what the user did with its finds is recorded in the triage file", () => {
  assert.ok(coldRead.includes("triage file as `coldRead`"));
  for (const word of ["`finds`", "`answered`", "`dismissed`", "`held`", "false alarms and the time"]) {
    assert.ok(coldRead.includes(word), `step 5 lacks ${word}`);
  }
});

test("audit.md calls the step for ready findings, before the label, and does not repeat it", () => {
  assert.ok(audit.includes("queue.md's cold read (its step 5"));
  assert.ok(audit.includes("before the queue label goes on"));
  assert.ok(audit.includes("Do not repeat the step here"));
  assert.ok(!audit.includes("fresh read-only subagent"), "audit.md carries its own copy of the brief");
  assert.ok(!audit.includes("Brief for the cold reader"));
});
