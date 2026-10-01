// The lean check (src/lean.ts) in a throwaway git repo: a settings.json that
// defines hooks but is not tracked is flagged, since sandboxes never get it.
//
//   pnpm exec tsx --test test/lean.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// The kit's config dir is read at import; a test must not touch the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { plan, report, unmatched } = await import("../src/lean.ts");

const WARNING = /WARNING: \.claude\/settings\.json defines hooks but git does not track it/;
const withHooks = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node guard.js" }] }] } };

// Identity by -c flag and -b main: CI has neither a global identity nor a main default.
const repo = (settings: object, { gitignore, commit }: { gitignore?: string; commit: boolean }) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lean-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify(settings));
  if (gitignore) writeFileSync(join(root, ".gitignore"), gitignore);
  if (commit) git("add", "-f", ".claude/settings.json");
  git("commit", "-q", "--allow-empty", "-m", "start");
  return { name: "fixture", root, lean: { keep: [], dropHooks: [] }, hookTests: [] } as unknown as Project;
};

const output = (t: { mock: { method: (o: object, m: string) => { mock: { calls: { arguments: unknown[] }[] } } } }, project: Project) => {
  const log = t.mock.method(console, "log");
  report(project, plan(project));
  return log.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
};

test("hooks in a settings.json that git ignores are flagged", (t) => {
  const project = repo(withHooks, { gitignore: ".claude/\n", commit: false });
  assert.match(output(t, project), WARNING);
});

test("a committed settings.json with hooks is not flagged", (t) => {
  const project = repo(withHooks, { gitignore: ".claude/\n", commit: true });
  assert.doesNotMatch(output(t, project), WARNING);
});

test("an untracked settings.json without hooks is not flagged", (t) => {
  const project = repo({ permissions: { allow: [] } }, { gitignore: ".claude/\n", commit: false });
  assert.doesNotMatch(output(t, project), WARNING);
});

// A typo in lean.keep or lean.dropHooks kept or dropped nothing, and nothing said so.
test("lean.keep and dropHooks entries that match nothing are warned about; matching ones are not", (t) => {
  const project = repo(withHooks, { commit: true });
  mkdirSync(join(project.root, ".claude/skills/real"), { recursive: true });
  writeFileSync(join(project.root, ".claude/skills/real/SKILL.md"), "---\nname: real\ndescription: d\n---\n");
  execFileSync("git", ["-C", project.root, "add", "-f", ".claude"]);
  project.lean = { keep: ["skill:real", "skill:reel"], dropHooks: ["guard.js", "rtk"] };
  assert.deepEqual(unmatched(project, plan(project)), { keep: ["skill:reel"], dropHooks: ["rtk"] });
  const out = output(t, project);
  assert.match(out, /WARN lean\.keep names skill:reel, which this repo does not have/);
  assert.match(out, /WARN lean\.dropHooks "rtk" matches no hook/);
  assert.doesNotMatch(out, /skill:real, which|"guard\.js" matches no hook/);
});
