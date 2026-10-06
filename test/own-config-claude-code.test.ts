// The kit's own project config asks for the latest Claude Code: the stable channel is older than the
// mod's tests need, so every sandbox gate skipped them and a ticket touching mod/ landed untested.
//
//   node --test test/own-config-claude-code.test.ts

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProject } from "../src/config.ts";

test("this repo's own config sets claudeCode to latest", async () => {
  const project = await loadProject(join(dirname(fileURLToPath(import.meta.url)), ".."));
  assert.equal(project.claudeCode, "latest");
});
