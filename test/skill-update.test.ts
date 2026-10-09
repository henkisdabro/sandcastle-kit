// update.md's "What's new" step is skill-only text: after the kit's pull it runs `sandcastle
// changes` and tells the user in three tiers - must act (the Upgrading notes), decisions (asked one
// by one with a recommendation, never applied unasked) and good to know (one line each). This pins
// the step, its tiers and their order, that its command exists, and that the rest of the file's
// numbering (steps 1 to 5, the step 3 sub-steps it points at) still holds.
//
//   pnpm test:file test/skill-update.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Normalise line endings so the test reads the same checked out on either platform.
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const update = read("skill", "update.md");
const cli = read("src", "cli.ts");

const flat = (text: string) => text.replace(/\s+/g, " ");
const step = (n: number) => update.match(new RegExp(`^${n}\\. \\*\\*[\\s\\S]*?(?=^${n + 1}\\. \\*\\*|(?![\\s\\S]))`, "m"))?.[0] ?? "";

test("the top-level steps run 1 to 5 and step 2 is What's new, after the kit's pull", () => {
  const titles = [...update.matchAll(/^(\d+)\. \*\*([^*]+)\*\*/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(titles.map((t) => t[0]), ["1", "2", "3", "4", "5"]);
  assert.equal(titles[1][1], "What's new.");
  assert.match(step(1), /git -C <kit> pull --ff-only/);
});

test("What's new is built from `sandcastle changes`, which the kit has", () => {
  const text = flat(step(2));
  assert.match(text, /`sandcastle changes`/);
  assert.match(text, /`sandcastle changes --since <release>`/);
  assert.match(cli, /case "changes":/);
});

test("What's new has the three tiers, in order, each by its name", () => {
  const text = flat(step(2));
  const at = ["**Must act.**", "**Decisions.**", "**Good to know.**"].map((name) => text.indexOf(name));
  assert.ok(at.every((i) => i >= 0), `a tier is missing: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "the tiers are out of order");
});

test("must act is the Upgrading notes, read in full", () => {
  const text = flat(step(2));
  assert.match(text, /\*\*Must act\.\*\* The \*\*Upgrading\*\* notes, in full/);
});

test("decisions are asked one by one with a recommendation and never applied unasked", () => {
  const text = flat(step(2));
  const decisions = text.slice(text.indexOf("**Decisions.**"), text.indexOf("**Good to know.**"));
  assert.match(decisions, /one by one/);
  assert.match(decisions, /recommendation/);
  assert.match(decisions, /Never apply one unasked/);
  assert.match(decisions, /`AskUserQuestion` in Claude Code/, "the question tool is named by what it does, with Claude Code's name as an example");
});

test("good to know is one line each and asks nothing", () => {
  const text = flat(step(2));
  const known = text.slice(text.indexOf("**Good to know.**"));
  assert.match(known, /one line each/);
  assert.match(known, /No question, no action/);
});

test("the step 3 sub-steps that What's new points at are still there", () => {
  assert.match(flat(step(2)), /step 3\.2/);
  assert.match(flat(step(2)), /step 3\.10/);
  assert.match(step(3), /^ {3}2\. \*\*Config\.\*\*/m);
  assert.match(step(3), /^ {3}10\. \*\*Chains and overlaps\.\*\*/m);
  assert.match(flat(step(3)), /autonomy: "drain"/);
});
