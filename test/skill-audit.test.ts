// The audit action is skill-only text: SKILL.md routes to skill/audit.md, which holds the subagent
// brief and the filing rules. This pins its shape - the frontmatter, the table row, the short
// section, the brief's read-only promises and the seven queue categories - and that audit.md
// quotes no real-looking blocker (the kit would read one as a dependency).
//
//   node --test test/skill-audit.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Normalise line endings so the test reads the same checked out on either platform.
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const skill = read("skill", "SKILL.md");
const audit = read("skill", "audit.md");
const agents = read("AGENTS.md");

const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
const section = skill.match(/^## audit\b[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0] ?? "";
const block = audit.match(/```[a-z]*\n([\s\S]*?)```/)?.[1] ?? "";
const outside = audit.replace(/```[a-z]*\n[\s\S]*?```/, "");

test("the frontmatter names audit and keeps its limits", () => {
  assert.match(frontmatter, /^name: sandcastle$/m);
  const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length < 1024, String(description.length));
  assert.ok(description.includes("audit"));
  assert.match(frontmatter, /^argument-hint: .*audit/m);
});

test("the action table has an audit row, and the section sits between init and queue", () => {
  assert.match(skill, /^\| `audit` \| /m);
  const at = (heading: RegExp) => skill.search(heading);
  assert.ok(at(/^## audit\b/m) >= 0, "no ## audit heading");
  assert.ok(at(/^## init\b/m) < at(/^## audit\b/m), "audit is not after init");
  assert.ok(at(/^## audit\b/m) < at(/^## queue\b/m), "audit is not before queue");
  const lines = section.split("\n").filter((l) => l.trim() !== "").length;
  assert.ok(lines <= 6, `the audit section is ${lines} non-empty lines`);
  assert.ok(section.includes("audit.md"));
});

test("audit.md exists and holds the brief in a fenced block", () => {
  assert.ok(audit.trim().length > 0);
  assert.ok(block.length > 0, "no fenced block");
  assert.match(block, /^\s*Lens: /m);
  assert.match(block, /^\s*Areas: /m);
  for (const word of ["Read-only", "gh issue create", "sandcastle run"]) {
    assert.ok(block.includes(word), `the brief lacks "${word}"`);
  }
});

test("audit.md holds the rules around the brief", () => {
  const flat = outside.replace(/\s+/g, " ");
  assert.ok(flat.includes("never send a brief with a placeholder left in it"));
  assert.ok(flat.includes("before filing anything"));
  assert.ok(audit.includes(".sandcastle/triage/audit/"));
});

test("audit.md names each of the seven queue categories", () => {
  // A category name can wrap across two lines.
  const flat = audit.replace(/\s+/g, " ");
  for (const name of [
    "ready",
    "needs a decision",
    "human-only",
    "blocked by another ticket",
    "already fixed or false",
    "epic or too big",
    "parked",
  ]) {
    assert.ok(flat.includes(name), `audit.md lacks the category "${name}"`);
  }
});

test("audit.md quotes no real-looking blocker", () => {
  assert.doesNotMatch(audit, /(blocked by|depends on):?\s+(#\d+|[A-Z]+-\d+|\S+\.md)/i);
});

test("AGENTS.md's skill row names audit.md", () => {
  const row = agents.split("\n").find((l) => l.startsWith("| `skill/` |")) ?? "";
  assert.ok(row.includes("audit.md"), row);
});
