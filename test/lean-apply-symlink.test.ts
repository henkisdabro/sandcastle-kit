// `apply` runs on the host in every fresh worktree, and the worktree holds a sandbox branch's tree: a branch that
// committed `.claude`, `.claude/skills` or `.mcp.json` as a symlink must not make it delete or overwrite a host file
// outside the worktree. Run against a real `git worktree add` checkout and a plan the main checkout made.
//
//   pnpm test:file test/lean-apply-symlink.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { apply } = await import("../src/lean.ts");

// Every file under dir with its bytes, so "unchanged" is checked byte for byte.
const snapshot = (dir: string, base = dir): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      return e.isDirectory() ? Object.entries(snapshot(full, base)) : [[full.slice(base.length), readFileSync(full, "utf8")]];
    }),
  );

const fixture = (links: Record<string, string>) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-lean-symlink-")));
  const main = join(dir, "main");
  const tree = join(dir, "tree");
  const victim = join(dir, "victim");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", main, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  mkdirSync(join(victim, "skills/deploy"), { recursive: true });
  writeFileSync(join(victim, "skills/deploy/SKILL.md"), "the operator's skill\n");
  writeFileSync(join(victim, "settings.json"), '{"theirs":true}\n');
  writeFileSync(join(victim, "target.txt"), "any file the user can write\n");
  mkdirSync(main);
  git("init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  git("checkout", "-q", "-b", "agent/x");
  for (const [name, target] of Object.entries(links)) {
    mkdirSync(join(main, name, ".."), { recursive: true });
    symlinkSync(join(victim, target), join(main, name));
    git("add", "-f", name);
  }
  git("commit", "-q", "-m", "links");
  git("checkout", "-q", "main");
  git("worktree", "add", "-q", tree, "agent/x");
  return { tree, victim };
};

// The plan the main checkout makes: it names paths under real directories.
const plan = {
  hide: [".claude/skills/deploy"],
  write: { ".claude/settings.json": '{"lean":true}\n', ".mcp.json": '{"lean":true}\n' } as Record<string, string>,
  items: [],
  hooks: [],
};

test("a symlinked .claude and .mcp.json leave the host files they point at unchanged", async () => {
  const { tree, victim } = fixture({ ".claude": "", ".mcp.json": "target.txt" });
  const before = snapshot(victim);
  const { lines } = await quietly(() => apply(plan, tree));
  assert.deepEqual(snapshot(victim), before);
  assert.match(lines.join("\n"), /\.claude\/skills\/deploy alone - \.claude is a symlink/);
});

test("a symlink below the top component (.claude/skills) is not followed either", async () => {
  const { tree, victim } = fixture({ ".claude/skills": "skills" });
  const before = snapshot(victim);
  await quietly(() => apply({ ...plan, write: {} }, tree));
  assert.deepEqual(snapshot(victim), before);
});

test("a symlinked final file is replaced by the lean content, not written through", async () => {
  const { tree, victim } = fixture({ ".mcp.json": "target.txt" });
  const before = snapshot(victim);
  await quietly(() => apply({ ...plan, hide: [], write: { ".mcp.json": '{"lean":true}\n' } }, tree));
  assert.deepEqual(snapshot(victim), before);
  assert.equal(lstatSync(join(tree, ".mcp.json")).isSymbolicLink(), false);
  assert.equal(readFileSync(join(tree, ".mcp.json"), "utf8"), '{"lean":true}\n');
});

test("a hidden path that is itself a symlink loses the link and leaves its target", async () => {
  const { tree, victim } = fixture({ ".claude": "" });
  const before = snapshot(victim);
  await quietly(() => apply({ ...plan, hide: [".claude"], write: {} }, tree));
  assert.deepEqual(snapshot(victim), before);
  assert.throws(() => readlinkSync(join(tree, ".claude")));
});
