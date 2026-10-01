// The skill's "Close the run" step must tell the assistant to copy the report's headings
// verbatim, emoji included: a model that retypes them drops the emoji. The headings the
// skill lists must also be the ones src/report.ts prints, so the two cannot drift apart.
//
//   pnpm exec tsx --test test/skill-report-headings.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, "skill", "SKILL.md"), "utf8");
// The close-the-run step lives in run.md, which SKILL.md's run action points to.
const closing = readFileSync(join(root, "skill", "run.md"), "utf8");
const report = readFileSync(join(root, "src", "report.ts"), "utf8");

// The "Close the run" step in run.md, up to the next numbered step or heading.
const step = closing.match(/\*\*Close the run[\s\S]*?(?=\n\d+\. \*\*|\n## |(?![\s\S]))/)?.[0] ?? "";

test("the close-the-run step is found", () => {
  assert.ok(step.length > 0);
});

test("step 4 says to copy headings verbatim, emoji included, from sandcastle report's stdout", () => {
  const flat = step.replace(/\s+/g, " ");
  assert.match(flat, /verbatim/);
  assert.match(flat, /emoji included/);
  assert.match(flat, /stdout/);
  assert.match(flat, /not from a pane scrape/);
});

test("every heading the skill lists carries its emoji and starts one report.ts prints", () => {
  const listed = [...step.matchAll(/^\s+\d\. `(## [^`]+)`/gm)].map((m) => m[1]);
  assert.equal(listed.length, 7);
  for (const heading of listed) {
    assert.match(heading, /\p{Extended_Pictographic}/u, `${heading} lost its emoji`);
    // The first heading is built from the run's outcome ("Run finished", "Run STOPPED"), so
    // only its emoji is checked; the rest are printed as written, some with a suffix.
    const needle = heading.startsWith("## 🏁") ? "## 🏁" : heading;
    assert.ok(report.includes(needle), `report.ts does not print "${needle}"`);
  }
});

test("the description stays under 1,024 characters", () => {
  const description = skill.match(/^description: "(.*)"$/m)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length < 1024, String(description.length));
});
