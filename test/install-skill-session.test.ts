// docs/INSTALL.md (Updating) and skill/update.md must agree on what a pulled skill does to an open
// session: it keeps the skill it loaded at its start, so the user starts a new one. INSTALL once said
// Claude Code picks the change up in an open session, and offered an unverified `/reload-skills`.
//
//   pnpm exec tsx --test test/install-skill-session.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8").replace(/\r\n/g, "\n").replace(/\s+/g, " ");

test("INSTALL does not say an open session picks up a pulled skill", () => {
  const install = read("docs", "INSTALL.md");
  assert.doesNotMatch(install, /picks up the change in an open session/);
  assert.match(install, /already open keeps the skill it loaded at its start/);
  assert.match(install, /start a new session/);
});

test("no doc or skill file offers the unverified /reload-skills", () => {
  for (const f of [["README.md"], ["docs", "INSTALL.md"], ["skill", "SKILL.md"], ["skill", "update.md"]]) {
    assert.doesNotMatch(read(...f), /reload-skills/, f.join("/"));
  }
});

test("update.md says the same: an open session keeps its skill", () => {
  assert.match(read("skill", "update.md"), /already open keeps the skill it loaded at its start/);
});
