// `sandcastle lean` lists the .claude/rules files with no `paths:` frontmatter, which Claude Code loads into
// every session, with their token estimates and the advice to scope them.
//
//   pnpm test:file test/lean-rules.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { quietly } from "./quiet.ts";

// The kit's config dir is read at import; a test must not touch the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { alwaysLoadedRules, plan, report } = await import("../src/lean.ts");

const repo = (rules: Record<string, string>, untracked: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lean-rules-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "fixture\n");
  const put = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  put(rules);
  git("add", "-f", ".");
  git("commit", "-q", "-m", "start");
  put(untracked);
  return { name: "fixture", root, lean: { keep: [], dropHooks: [] }, hookTests: [] } as unknown as Project;
};

const printed = async (project: Project) => (await quietly(() => report(project, plan(project)))).lines.join("\n");

const fixtureRules = {
  ".claude/rules/always.md": "x".repeat(400), // 100 tokens
  ".claude/rules/sub/also.md": `---\ndescription: no paths here\n---\n${"y".repeat(369)}`, // 35 + 369 = 404 chars: 101 tokens
  ".claude/rules/scoped.md": `---\npaths:\n  - "src/**"\n---\n${"z".repeat(400)}`,
  ".claude/rules/notes.txt": "not markdown",
};

test("lean lists each always-loaded rule file with its tokens under a total line and the advice", async () => {
  const out = await printed(repo(fixtureRules, { ".claude/rules/local.md": "untracked" }));
  assert.match(out, /Always loaded: 2 rule file\(s\) in \.claude\/rules with no paths:, ~201 tokens/);
  assert.match(out, /^ {4}\.claude\/rules\/always\.md +~100$/m);
  assert.match(out, /^ {4}\.claude\/rules\/sub\/also\.md +~101$/m);
  assert.match(out, /scope a rule with `paths:` frontmatter/);
  assert.ok(out.indexOf("CLAUDE.md and its imports") < out.indexOf("rule file(s)"), "rules come beside the CLAUDE.md line");
});

test("lean does not list a rule scoped with paths:, an untracked rule or a file that is not markdown", async () => {
  const out = await printed(repo(fixtureRules, { ".claude/rules/local.md": "untracked" }));
  assert.doesNotMatch(out, /scoped\.md/);
  assert.doesNotMatch(out, /local\.md/);
  assert.doesNotMatch(out, /notes\.txt/);
});

test("lean prints no rules line for a repo with no always-loaded rules", async () => {
  const out = await printed(repo({ ".claude/rules/scoped.md": fixtureRules[".claude/rules/scoped.md"] }));
  assert.doesNotMatch(out, /rule file/);
  assert.doesNotMatch(out, /paths:/);
  assert.match(out, /Always loaded: CLAUDE\.md and its imports/);
});

test("a rule's tokens are its characters over four, rounded up", () => {
  const project = repo({ ".claude/rules/a.md": "a".repeat(401), ".claude/rules/b.md": `---\npaths: [x]\n---\nb`, ".claude/rules/c.md": "---\nnever closed\n" + "c".repeat(10) });
  assert.deepEqual(alwaysLoadedRules(project.root), [
    { path: ".claude/rules/a.md", tokens: 101 },
    { path: ".claude/rules/c.md", tokens: Math.ceil(("---\nnever closed\n".length + 10) / 4) },
  ]);
});
