// `sandcastle lean` lists the built-in tools each pass gets, and `lean --measure` probes with the
// pass's tool allow-list and environment.
//
//   pnpm test:file test/lean-tool-rows.test.ts

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
const { plan, probeArgs, report } = await import("../src/lean.ts");

const repo = (keep: string[] = []) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-lean-tools-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".claude/skills/deploy"), { recursive: true });
  writeFileSync(join(root, ".claude/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Deploy it\n---\nbody\n");
  git("add", "-f", ".claude");
  git("commit", "-q", "-m", "start");
  return { name: "fixture", root, lean: { keep, dropHooks: [] }, hookTests: [] } as unknown as Project;
};

const printed = async (project: Project) => (await quietly(() => report(project, plan(project)))).lines.join("\n");

test("lean lists the five default built-in tools as kept, without a token count", async () => {
  const out = await printed(repo());
  for (const name of ["Bash", "Read", "Edit", "Write", "TaskStop"]) {
    assert.match(out, new RegExp(`keep  tool +${name} +-$`, "m"));
  }
  assert.doesNotMatch(out, /tool +Skill/);
});

test("lean lists the Skill tool when lean.keep keeps a skill", async () => {
  const out = await printed(repo(["skill:deploy"]));
  assert.match(out, /keep  tool +Skill +-$/m);
});

test("lean says every other built-in tool is hidden and how to keep one", async () => {
  const out = await printed(repo());
  assert.ok(out.includes("  Claude Code's other built-in tools are hidden from every pass (--tools); keep one with tool:<Name> in lean.keep."));
});

test("the tool rows are not items of the plan", () => {
  const project = repo();
  assert.ok(plan(project).items.every((i) => i.kind !== ("tool" as string)));
});

test("lean --measure probes with the pass's --tools list and auto memory off", () => {
  const args = probeArgs(repo(["skill:deploy"]), "image:tag", "/tmp/tree", { GH_TOKEN: "x" });
  const at = args.indexOf("--tools");
  assert.ok(at > 0);
  assert.equal(args[at + 1], "Bash,Read,Edit,Write,TaskStop,Skill");
  const e = args.indexOf("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
  assert.equal(args[e - 1], "-e");
  assert.ok(e < args.indexOf("image:tag"), "the variable is a docker run option, before the image");
  assert.ok(at > args.indexOf("image:tag"), "--tools is a claude argument, after the image");
});
