// A drain turn after a single fast-forward landing: the merge commit the landing leaves is a green base
// (the ticket's own gates ran on that tree), so the next turn's base check skips the gates but still runs
// the hook checks, which a landing never runs. Run for real against a fake docker; no Docker or network.
//
//   node --test test/fast-forward-landing-recorded.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

// Before the kit's modules load: they read these once. The machine-wide slots live under the cache dir.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-ff-recorded-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const bin = join(dir, "bin");
mkdirSync(bin);
// A sandbox is cut from the project's main. The git-hook probe leaves a `.probed` file in the project.
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
const { landOne, createHostGit } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const IMAGE = "sandcastle-fixture:t";

test("a drain turn after a single fast-forward landing skips the base gates but still runs the hook checks", async () => {
  const root = join(dir, "project");
  process.env.SANDCASTLE_TEST_REPO = root;
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "check-red" }] };\n`);
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "init");
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  writeFileSync(join(root, "f1.txt"), "1\n");
  git(root, "add", "f1.txt");
  git(root, "commit", "-q", "-m", "work on 1");
  git(root, "checkout", "-q", "main");
  const head = git(root, "rev-parse", "agent/issue-1");

  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    const plan = writePlan(project).file;
    const ctx: Ctx = {
      project,
      tracker: { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
      base: "main",
      gateNames: "test",
      reports: new Map(),
      run: { ticket: () => {} },
      dryRun: false,
      opener: async () => assert.fail("a fast-forward needs no sandbox"),
      withdrawal: () => undefined,
      host: createHostGit(project, gitFingerprint(project)),
      gate: async () => assert.fail("a fast-forward is not gated again at landing"),
      greenBase: (commit) => noteGreenCommit(project, IMAGE, plan, commit),
      landed: new Map(),
    };
    const landed = await quietly(() => landOne(ctx, { issue: "1", branch: "agent/issue-1", status: "green", commits: 1, repairs: 0, head }));
    assert.equal(landed.result.kind, "merged");
    // The landing is a merge commit on top of the branch: a commit no gate has named.
    assert.notEqual(git(root, "rev-parse", "main"), head);

    const { lines } = await quietly(() => requireGreenBase(project, IMAGE, plan, true, "turn-2"));
    assert.ok(!lines.some((l) => l.includes("running every gate on the base commit")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("gates not re-run; running the hook tests and the git-hook probe")), lines.join("\n"));
    assert.ok(existsSync(join(root, ".probed")), "the git-hook probe ran");
  } finally {
    process.chdir(cwd);
  }
});
