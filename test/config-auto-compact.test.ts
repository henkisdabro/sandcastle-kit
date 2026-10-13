// `autoCompactWindow` in .sandcastle/config.ts: validated against Claude Code's own range, and passed to
// Claude agents in the sandbox as CLAUDE_CODE_AUTO_COMPACT_WINDOW only when set.
//
//   pnpm test:file test/config-auto-compact.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { implAgent } from "../src/agents.ts";
import { loadProject } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";

const load = (extra: string) => {
  const root = mkdtempSync(join(tmpdir(), "sc-compact-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }]${extra} };\n`);
  return loadProject(root);
};
const refused = (extra: string) =>
  assert.rejects(load(extra), (e: Error) => e instanceof OperatorError && /`autoCompactWindow` must be a whole number of tokens from 100,000 to 1,000,000/.test(e.message));

test("a window inside Claude Code's range is accepted, the ends included", async () => {
  assert.equal((await load(", autoCompactWindow: 100000")).autoCompactWindow, 100_000);
  assert.equal((await load(", autoCompactWindow: 400000")).autoCompactWindow, 400_000);
  assert.equal((await load(", autoCompactWindow: 1000000")).autoCompactWindow, 1_000_000);
});

test("a window outside the range is refused with the range named", async () => {
  await refused(", autoCompactWindow: 99999");
  await refused(", autoCompactWindow: 1000001");
  await refused(", autoCompactWindow: 0");
  await refused(", autoCompactWindow: -200000");
});

test("a window that is not a whole number is refused", async () => {
  await refused(', autoCompactWindow: "200000"');
  await refused(", autoCompactWindow: 250000.5");
  await refused(", autoCompactWindow: true");
  await refused(", autoCompactWindow: null");
});

test("the Claude agent's env carries the window when set and lacks it when not", async () => {
  await load(", autoCompactWindow: 300000");
  assert.equal(implAgent().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
  assert.equal(implAgent().env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  await load("");
  assert.ok(!("CLAUDE_CODE_AUTO_COMPACT_WINDOW" in implAgent().env));
  assert.equal(implAgent().env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
});
