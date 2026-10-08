// A project's permissions.ask rules reach every sandbox through the kept .claude/settings.json,
// where nobody can answer them: lean names them, and the prompts commit with -F so a commit message
// cannot match a command rule.
//
//   pnpm test:file test/lean-ask-rules.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// The kit's config dir is read at import; a test must not touch the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { askRuleLines, plan, report } = await import("../src/lean.ts");

const repo = (settings: object, { commit = true, file = "settings.json" } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lean-ask-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", file), JSON.stringify(settings));
  if (commit) git("add", "-f", `.claude/${file}`);
  git("commit", "-q", "--allow-empty", "-m", "start");
  return { name: "fixture", root, lean: { keep: [], dropHooks: [] }, hookTests: [] } as unknown as Project;
};

const output = (t: { mock: { method: (o: object, m: string, impl: () => void) => { mock: { calls: { arguments: unknown[] }[] } } } }, project: Project) => {
  const log = t.mock.method(console, "log", () => {});
  report(project, plan(project));
  return log.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
};

test("lean prints the project's ask rules as refused in sandboxes", (t) => {
  const out = output(t, repo({ permissions: { ask: ["Bash(* --execute *)", "Bash(git push:*)"], allow: ["Bash(ls)"] } }));
  assert.match(out, /WARNING: 2 permissions\.ask rule\(s\) in \.claude\/settings\.json are refused in sandboxes, where nobody can answer/);
  assert.match(out, /Bash\(\* --execute \*\)/);
  assert.match(out, /Bash\(git push:\*\)/);
  assert.doesNotMatch(out, /Bash\(ls\)/);
});

test("lean prints nothing about ask rules when there are none", (t) => {
  assert.doesNotMatch(output(t, repo({ permissions: { allow: ["Bash(ls)"] } })), /permissions\.ask/);
  assert.doesNotMatch(output(t, repo({ permissions: { ask: [] } })), /permissions\.ask/);
});

test("ask rules in a settings file a sandbox never gets are not reported", () => {
  assert.deepEqual(askRuleLines(repo({ permissions: { ask: ["Bash(x)"] } }, { commit: false }).root), []);
  assert.deepEqual(askRuleLines(repo({ permissions: { ask: ["Bash(x)"] } }, { file: "settings.local.json" }).root), []);
});

test("the implement, review and repair prompts commit with -F, not -m", () => {
  for (const name of ["implement", "review", "repair"]) {
    const text = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8");
    assert.match(text, /git commit -F <file>/, name);
    assert.match(text, /never `git commit -m/, name);
  }
});
