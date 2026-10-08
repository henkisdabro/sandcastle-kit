// The lean hook check warns of an import it cannot see statically; a hook that ran cleanly in a passing hook test is
// not warned of, and one that did not (or whose record a later commit made stale) still is. Run for real against a
// fake docker that answers the hook check with a MODULES finding for every kept hook; no Docker or network.
//
//   pnpm test:file test/hook-check-vouched.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-hook-vouched-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const bin = join(dir, "bin");
mkdirSync(bin);
// The hook check's container (`--entrypoint sh`) reports an unseen import for each of SANDCASTLE_TEST_HOOKS hooks. A hook
// test's exec of `bad.py` exits 1 (a crash) and of `good.py` exits 2 (a block); any other command exits 0.
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh
case "$*" in
  *"--entrypoint sh"*)
    i=0
    while [ "$i" -lt "$SANDCASTLE_TEST_HOOKS" ]; do echo "WARN $i MODULES shared"; i=$((i + 1)); done ;;
  *"sh -c git rev-parse HEAD") git -C "$SANDCASTLE_TEST_REPO" rev-parse main ;;
  *"timeout 60 sh"*"bad.py"*) cat > /dev/null; exit 1 ;;
  *"timeout 60 sh"*"good.py"*) cat > /dev/null; exit 2 ;;
  *"timeout 60 sh"*) cat > /dev/null ;;
esac
exit 0
`,
);
chmodSync(join(bin, "docker"), 0o755);
process.env.PATH = [bin, dirname(process.execPath), process.env.PATH].join(delimiter);
mkdirSync(join(dir, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(dir, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { hooksThatRanClean, noteGreenCommit, requireGreenBase } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { checkHooks, writePlan } = await import("../src/lean.ts");

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const IMAGE = "sandcastle-fixture:t";

const hook = (command: string, matcher: string) => ({ matcher, hooks: [{ type: "command", command }] });

// A repo on main with kept PreToolUse hooks (`hooks`, as [matcher, script]) and the hook tests given, ready to check.
const fixture = async (name: string, hooks: [string, string][], hookTests: string) => {
  const root = join(dir, name);
  process.env.SANDCASTLE_TEST_REPO = root;
  process.env.SANDCASTLE_TEST_HOOKS = String(hooks.length);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(
    join(root, ".sandcastle/config.ts"),
    `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "check-ok" }], hookTests: ${hookTests} };\n`,
  );
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: hooks.map(([m, s]) => hook(`python3 ${s}`, m)) } }));
  for (const [, s] of hooks) writeFileSync(join(root, s), "import shared\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
};

// The module names the hook check still warns of, for each kept hook, after `before` ran in the project.
const warnings = async (root: string, before: (p: Awaited<ReturnType<typeof loadProject>>, plan: string) => Promise<unknown> | void) => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    const { plan, file } = writePlan(project);
    await before(project, file);
    return checkHooks(project, IMAGE, plan, hooksThatRanClean(project, IMAGE, file)).warnings;
  } finally {
    process.chdir(cwd);
  }
};
const baseCheck = (project: Parameters<typeof requireGreenBase>[0], plan: string) => quietly(() => requireGreenBase(project, IMAGE, plan, true, "turn"));

const allow = `[{ name: "plain command", tool: "Bash", input: { command: "ls" }, expect: "allow" }]`;

test("a hook with an unseen import that a passing hook test ran cleanly gets no warning", async () => {
  const root = await fixture("passing", [["Bash", "solo.py"]], allow);
  assert.equal((await warnings(root, () => {})).length, 1, "before any hook test passed, the warning stands");
  assert.deepEqual(await warnings(root, baseCheck), []);
});

test("a hook with no hook test keeps its warning", async () => {
  const root = await fixture("untested", [["Bash", "solo.py"]], "[]");
  const w = await warnings(root, baseCheck);
  assert.equal(w.length, 1);
  assert.match(w[0], /solo\.py - MODULES shared/);
});

test("a passing block test does not vouch for a matching guard that errored", async () => {
  const root = await fixture(
    "ignored-error",
    [["Edit", "good.py"], ["Edit", "bad.py"]],
    `[{ name: "edit is refused", tool: "Edit", input: { file_path: "x" }, expect: "block" }]`,
  );
  const w = await warnings(root, baseCheck);
  assert.equal(w.length, 1, w.join("\n"));
  assert.match(w[0], /bad\.py - MODULES shared/);
});

test("the record survives a landing that left the hook tests covered, and goes stale when the landing changed the hook", async () => {
  const land = (file: string) => async (project: Parameters<typeof requireGreenBase>[0], plan: string) => {
    await baseCheck(project, plan);
    writeFileSync(join(project.root, file), "changed\n");
    git(project.root, "add", "-A");
    git(project.root, "commit", "-q", "-m", `land ${file}`);
    noteGreenCommit(project, IMAGE, plan, git(project.root, "rev-parse", "main"), "#1", "landing-sandbox");
    // A landing that changed the hook leaves no record to vouch with until the next turn's base check reruns the tests.
    assert.equal(hooksThatRanClean(project, IMAGE, plan).length === 0, file === "solo.py");
    const next = await baseCheck(project, plan);
    if (file === "unrelated.txt") assert.ok(next.lines.join("\n").includes("not re-run."), next.lines.join("\n"));
  };
  const kept = await fixture("landing-unrelated", [["Bash", "solo.py"]], allow);
  assert.deepEqual(await warnings(kept, land("unrelated.txt")), []);
  const stale = await fixture("landing-hook", [["Bash", "solo.py"]], allow);
  assert.equal((await warnings(stale, land("solo.py"))).length, 0, "the next turn's base check reran the hook tests and vouched again");
});
