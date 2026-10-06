// The skill is split across files so SKILL.md, which loads whole for every action, stays a short
// router: each action's steps live in a file of its own (init.md, audit.md, queue.md, run.md,
// status.md, pause.md, update.md), each named in SKILL.md's prose (Codex and OpenCode do not fill $action, so they find the file from
// the text). This pins the split: nothing left behind, nothing lost, every pointer in place.
//
//   node --test test/skill-split.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
// Normalise line endings so the test reads the same checked out on either platform.
const read = (name: string) => readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n");
const skill = read("SKILL.md");
const run = read("run.md");
const update = read("update.md");

test("SKILL.md keeps its name and a description under OpenCode's limit", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  assert.match(frontmatter, /^name: sandcastle$/m);
  const description = frontmatter.match(/^description: "(.*)"$/m)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length < 1024, String(description.length));
});

test("run.md and update.md exist and are not empty", () => {
  assert.ok(run.trim().length > 0);
  assert.ok(update.trim().length > 0);
});

test("SKILL.md names every action file in prose, and each exists", () => {
  for (const file of ["init.md", "audit.md", "queue.md", "run.md", "status.md", "pause.md", "update.md"]) {
    assert.ok(skill.includes(file), `SKILL.md does not name ${file}`);
    assert.ok(read(file).trim().length > 0, `${file} is empty`);
  }
});

test("the moved text is no longer in SKILL.md", () => {
  for (const moved of ["## 🏁 Run finished", "Reading the summary", "pull --ff-only", "Brief for each subagent", "Keep the enforcement", "sandcastle run --detach", "IMPL_MODEL"]) {
    assert.ok(!skill.includes(moved), `SKILL.md still contains "${moved}"`);
  }
});

test("run.md holds the seven summary headings, in order", () => {
  const headings = [
    "## 🏁 Run finished",
    "## ✅ Done",
    "## 🙋 Needs you",
    "## ❌ Needs fixing",
    "## ▶️ Runnable now / ⏳ Still blocked",
    "## 📤 Local state",
    "## 👉 Next step",
  ];
  let from = 0;
  for (const heading of headings) {
    const at = run.indexOf(heading, from);
    assert.ok(at >= 0, `run.md lacks "${heading}" after position ${from}`);
    from = at + heading.length;
  }
});

test("update.md names init.md wherever it points at an init step", () => {
  assert.ok(!/as in (SKILL\.md's )?init step/.test(update), "an init step without its file is left");
  assert.match(update, /as in init\.md step 4/);
  assert.match(update, /as in init\.md step 6/);
  assert.match(update, /re-read SKILL\.md and this file before going on/);
});

test("SKILL.md still has the action sections", () => {
  for (const name of ["init", "queue", "run", "status", "pause", "resume", "update"]) {
    assert.match(skill, new RegExp(`^## ${name}\\b`, "m"), `no ## ${name} heading`);
  }
});
