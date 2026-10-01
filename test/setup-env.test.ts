// The credentials writer `sandcastle setup` uses when a credential is replaced
// (setup() itself needs a TTY): a made-up .env in a temp dir.
//
//   pnpm exec tsx --test test/setup-env.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing setup.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { writeEnv } = await import("../src/setup.ts");

const fixture = () => {
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-env-")), ".env");
  writeFileSync(file, "# my credentials\nGH_TOKEN=github_pat_old\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-old\nFOO=\n", { mode: 0o644 });
  return file;
};
const linesOf = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

test("replacing a key keeps comments and other keys, drops empty lines, and is private", () => {
  const file = fixture();
  writeEnv(file, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-new" });
  const lines = linesOf(file);
  assert.ok(lines.includes("# my credentials"));
  assert.ok(lines.includes("GH_TOKEN=github_pat_old"));
  assert.deepEqual(lines.filter((l) => l.startsWith("CLAUDE_CODE_OAUTH_TOKEN=")), ["CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-new"]);
  assert.ok(!lines.some((l) => l.startsWith("FOO=")));
  // POSIX permission bits; Linux and macOS agree.
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a key in `drop` is removed so the other kind of credential is the only one", () => {
  const file = fixture();
  writeEnv(file, { ANTHROPIC_API_KEY: "sk-ant-api03-x" }, ["CLAUDE_CODE_OAUTH_TOKEN"]);
  const lines = linesOf(file);
  assert.ok(!lines.some((l) => l.startsWith("CLAUDE_CODE_OAUTH_TOKEN")));
  assert.deepEqual(lines.filter((l) => l.startsWith("ANTHROPIC_API_KEY=")), ["ANTHROPIC_API_KEY=sk-ant-api03-x"]);
  assert.ok(lines.includes("GH_TOKEN=github_pat_old"));
});

test("writing nothing changes no key", () => {
  const file = fixture();
  writeEnv(file, {});
  assert.deepEqual(linesOf(file), ["# my credentials", "GH_TOKEN=github_pat_old", "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-old"]);
});
