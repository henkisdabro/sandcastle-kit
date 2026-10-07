// A landing's green record keeps the hook checks as covered when the base check had covered them and the landed diff
// touched nothing they read; a hook file, a lockfile or a protected path still gets the full hook check next turn.
// Run for real against a fake docker; no Docker or network.
//
//   node --test test/hook-checks-kept-across-landings.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-hooks-kept-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const bin = join(dir, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh
case "$*" in
  *"sh -c git rev-parse HEAD") git -C "$SANDCASTLE_TEST_REPO" rev-parse main ;;
  *"git hook run"*) echo probed >> "$SANDCASTLE_TEST_REPO/.probed" ;;
esac
exit 0
`,
);
chmodSync(join(bin, "docker"), 0o755);
process.env.PATH = [bin, dirname(process.execPath), process.env.PATH].join(delimiter);
mkdirSync(join(dir, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(dir, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { noteGreenCommit, requireGreenBase } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const IMAGE = "sandcastle-fixture:t";

// A project whose base check has run in full (gates and hook checks), then a commit of `file` lands on main and its
// green record is written; what the next turn's base check prints and whether the probe ran again is returned.
// `tracked` is committed with the first commit, before the base check.
const turnAfterLanding = async (name: string, file: string, hooksPath?: string, tracked: Record<string, string> = {}) => {
  const root = join(dir, name);
  process.env.SANDCASTLE_TEST_REPO = root;
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "advice.ignoredHook", "false");
  if (hooksPath) git(root, "config", "core.hooksPath", hooksPath);
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n.probed\n");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "check-red" }] };\n`);
  for (const [f, body] of Object.entries(tracked)) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    const plan = writePlan(project).file;
    const first = await quietly(() => requireGreenBase(project, IMAGE, plan, true, "turn-1"));
    assert.ok(first.lines.some((l) => l.includes("running every gate on the base commit")), first.lines.join("\n"));
    assert.ok(existsSync(join(root, ".probed")), "the base check probed the git hooks");
    rmSync(join(root, ".probed"));

    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), "changed\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `land ${file}`);
    noteGreenCommit(project, IMAGE, plan, git(root, "rev-parse", "main"), "#1", "landing-sandbox");

    const second = await quietly(() => requireGreenBase(project, IMAGE, plan, true, "turn-2"));
    return { lines: second.lines.join("\n"), probed: existsSync(join(root, ".probed")) };
  } finally {
    process.chdir(cwd);
  }
};

test("a landing that touched no hook file leaves the next turn no base sandbox for the hook checks", async () => {
  const t = await turnAfterLanding("plain", "src/feature.txt");
  assert.match(t.lines, /not re-run\./);
  assert.ok(!t.lines.includes("running the hook tests and the git-hook probe"), t.lines);
  assert.equal(t.probed, false);
});

for (const [name, file, hooksPath] of [
  ["a changed file under core.hooksPath", "tools/hooks/pre-commit", "tools/hooks"],
  ["a changed .husky file", ".husky/pre-commit", undefined],
  ["a changed lockfile", "pnpm-lock.yaml", undefined],
  ["a changed package manifest in a subdirectory", "packages/app/package.json", undefined],
  ["a changed protected path", ".github/workflows/ci.yml", undefined],
] as const) {
  test(`${name} still gets the full hook check on the next turn`, async () => {
    const t = await turnAfterLanding(`recheck-${file.replace(/\W+/g, "-")}`, file, hooksPath);
    assert.ok(t.lines.includes("gates not re-run; running the hook tests and the git-hook probe"), t.lines);
    assert.equal(t.probed, true);
  });
}

test("a changed script a kept Claude Code hook runs still gets the full hook check on the next turn", async () => {
  // Outside every protected path and hook directory: only the lean plan's kept hook names it.
  const settings = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node tools/guard.mjs" }] }] } };
  const t = await turnAfterLanding("recheck-kept-hook", "tools/guard.mjs", undefined, { ".claude/settings.json": JSON.stringify(settings) });
  assert.ok(t.lines.includes("gates not re-run; running the hook tests and the git-hook probe"), t.lines);
  assert.equal(t.probed, true);
});
