// A drain turn's base check skips the gates of a commit the run's own gates just passed: verify's, and a landing's
// merge that the base now names. Those runs do not run the hook tests or the git-hook probe, so the check still
// runs those; only its own record skips both. Run for real against a fake docker whose every call succeeds (a gate's
// command is what decides green or red); no Docker or network.
//
//   pnpm test:file test/base-gates-recorded.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

// Before the kit's modules load: they read these once. The machine-wide slots live under the cache dir.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-base-recorded-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const bin = join(dir, "bin");
mkdirSync(bin);
// A sandbox is cut from the project's main: `git rev-parse HEAD` in it names that commit. A gate whose command is `check-red` is red while the project has a `.red` file.
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh
case "$*" in
  *"sh -c git rev-parse HEAD") git -C "$SANDCASTLE_TEST_REPO" rev-parse main ;;
  *"sh -c 'check-red'") [ -e "$SANDCASTLE_TEST_REPO/.red" ] && exit 7 ;;
  *"git hook run"*) [ -e "$SANDCASTLE_TEST_REPO/.hookred" ] && { echo "@@hook pre-commit fail"; echo "needs a tool the image lacks"; }; echo probed >> "$SANDCASTLE_TEST_REPO/.probed" ;;
esac
exit 0
`,
);
chmodSync(join(bin, "docker"), 0o755);
process.env.PATH = [bin, dirname(process.execPath), process.env.PATH].join(delimiter);
mkdirSync(join(dir, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(dir, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { gateBase, noteGreenCommit, requireGreenBase, verifyBase } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");
const { landOne, createHostGit } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;

let n = 0;
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const makeProject = (gate: string) => {
  const root = join(dir, `project${n++}`);
  process.env.SANDCASTLE_TEST_REPO = root;
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: ${JSON.stringify(gate)} }] };\n`);
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "init");
  return root;
};
const inProject = async <T>(root: string, fn: (p: Awaited<ReturnType<typeof loadProject>>, plan: string) => Promise<T>) => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    return await fn(project, writePlan(project).file);
  } finally {
    process.chdir(cwd);
  }
};
const ran = (lines: string[]) => lines.some((l) => l.includes("running every gate on the base commit"));
const probed = (root: string) => existsSync(join(root, ".probed"));
const skipped = (lines: string[]) => lines.find((l) => l.includes("not re-run"));

test("a green verify is the base the next turn's check does not gate again, though it still runs the hook checks", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    const { lines } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"));
    assert.ok(!ran(lines), lines.join("\n"));
    const at = git(root, "rev-parse", "--short", "main");
    assert.equal(skipped(lines), `Gates on main: green at ${at} already (verified this run) - gates not re-run; running the hook tests and the git-hook probe in a sandbox, before any agent starts ...`);
    assert.ok(probed(root), "the git-hook probe ran");
  });
});

test("the base check's own record skips the gates and the hook checks both", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"));
    assert.ok(probed(root));
    rmSync(join(root, ".probed"));
    // A verify at the same commit adds nothing the record lacked, and takes nothing from it.
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    const { lines } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"));
    assert.match(skipped(lines) ?? "", /already \(verified this run\) - not re-run\.$/);
    assert.equal(probed(root), false);
  });
});

test("a check that ran only the hook checks records them, so the one after it skips both", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"));
    rmSync(join(root, ".probed"));
    const { lines } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"));
    assert.match(skipped(lines) ?? "", /- not re-run\.$/);
    assert.equal(probed(root), false);
  });
});

test("a record without the hooks field, an older kit's, counts as gates alone", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"));
    rmSync(join(root, ".probed"));
    const file = join(root, ".sandcastle/.run/base-gates.json");
    const { hooks: _, ...old } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(old) + "\n");
    const { lines } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"));
    assert.ok(!ran(lines), lines.join("\n"));
    assert.match(skipped(lines) ?? "", /gates not re-run; running the hook tests/);
    assert.ok(probed(root));
  });
});

// A ticket that changes a commit hook and lands green: its landing's record is at the key the next base check computes.
test("a landing that changes a git hook leaves a record the next base check still probes, and refuses", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"));
    // The ticket's change: a hook the image cannot run, committed to the base.
    writeFileSync(join(root, ".hookred"), "");
    // A hook file in the diff: a landing that touched none would keep the hook checks covered.
    mkdirSync(join(root, ".githooks"), { recursive: true });
    writeFileSync(join(root, ".githooks/pre-commit"), "the hook\n");
    git(root, "add", ".githooks/pre-commit");
    git(root, "commit", "-q", "-m", "ticket: change the pre-commit hook");
    noteGreenCommit(project, "sandcastle-fixture:t", plan, git(root, "rev-parse", "main"), "#1", "landing-sandbox");
    const { lines, result } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-2").then(() => undefined, (e: unknown) => e));
    assert.ok(!ran(lines), lines.join("\n"));
    assert.match(skipped(lines) ?? "", /gates not re-run; running the hook tests/);
    assert.match(String((result as Error)?.message), /git hook pre-commit/);
    // Red on the hook: no record is left that would skip it next time.
    assert.equal(existsSync(join(root, ".sandcastle/.run/base-gates.json")), false);
  });
});

test("a red verify leaves no record, so the next base check runs the gates", async () => {
  const root = makeProject("check-red");
  writeFileSync(join(root, ".red"), "");
  await inProject(root, async (project, plan) => {
    const verified = await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    assert.equal(verified.result.failures.length, 1);
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    assert.equal(existsSync(join(root, ".sandcastle/.run/base-gates.json")), false);
    const { lines } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1").catch(() => undefined));
    assert.ok(ran(lines), lines.join("\n"));
  });
});

test("a red verify removes the green record an earlier check left", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    assert.ok(existsSync(join(root, ".sandcastle/.run/base-gates.json")));
    writeFileSync(join(root, ".red"), "");
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    assert.equal(existsSync(join(root, ".sandcastle/.run/base-gates.json")), false);
  });
});

test("a changed image, plan file or commit still gates the base after a green verify", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    const other = await quietly(() => requireGreenBase(project, "sandcastle-fixture:other", plan, true, "run-1"));
    assert.ok(ran(other.lines), "image");
    // That check was green too and recorded itself; verify again to be back at the recorded state.
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    writeFileSync(plan, JSON.stringify({ ...JSON.parse(readFileSync(plan, "utf8")), changed: true }));
    assert.ok(ran((await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"))).lines), "plan file");
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-q", "-m", "next");
    assert.ok(ran((await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1"))).lines), "commit");
  });
});

test("the mid-run base check red on a recorded commit removes the record, so the next turn gates it", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "run-1"));
    assert.ok(existsSync(join(root, ".sandcastle/.run/base-gates.json")));
    // A flaky test: green when the landing or the verify gated the commit, red when a ticket's red asked about the base.
    writeFileSync(join(root, ".red"), "");
    await quietly(() => gateBase(project, "sandcastle-fixture:t", plan, "base-red", false, "run-1", false));
    const { lines } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1").catch(() => undefined));
    assert.ok(ran(lines), lines.join("\n"));
  });
});

// The sandbox a merge that is not a fast-forward is made and gated in: a host worktree, no Docker.
const opener = (root: string): Ctx["opener"] => async (branch) => {
  const path = join(dir, `wt${n++}`);
  git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  return {
    worktreePath: path,
    exec: async (cmd) => {
      const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    close: async () => git(root, "worktree", "remove", "--force", path),
  };
};

// Two branches from main touching different files: the second one's merge is gated in a sandbox.
const landTwo = async (gateGreen: boolean) => {
  const root = makeProject("check-red");
  for (const id of ["1", "2"]) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    writeFileSync(join(root, `f${id}.txt`), `${id}\n`);
    git(root, "add", `f${id}.txt`);
    git(root, "commit", "-q", "-m", `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Ctx["project"];
  const told: string[] = [];
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => (gateGreen ? { gates: [], failures: [] } : { gates: [{ name: "test", pass: false }], failures: [{ name: "test", command: "false", exitCode: 1, output: "x" }], failure: { name: "test", command: "false", exitCode: 1, output: "x" } }),
    greenBase: (commit) => void told.push(commit),
    landed: new Map(),
  };
  const outcome = (id: string) => ({ issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${id}`) });
  const first = await landOne(ctx, outcome("1"));
  const afterFirst = git(root, "rev-parse", "main");
  const second = await landOne(ctx, outcome("2"));
  return { root, told, first, second, afterFirst };
};

test("a landing gated in a sandbox tells the commit the base now names", async () => {
  const { root, told, first, second, afterFirst } = await quietly(() => landTwo(true)).then((r) => r.result);
  assert.equal(first.kind, "merged");
  assert.equal(second.kind, "merged");
  // The first landing is a fast-forward of a tree its own gates ran; the second is a merge made and gated here. Both are told.
  assert.deepEqual(told, [afterFirst, git(root, "rev-parse", "main")]);
});

test("a landing whose gates went red tells no commit", async () => {
  const { root, told, second, afterFirst } = await quietly(() => landTwo(false)).then((r) => r.result);
  assert.equal(second.kind, "red");
  // Only the first landing's fast-forward: the red merge is never the base.
  assert.deepEqual(told, [afterFirst]);
  assert.equal(git(root, "log", "-1", "--format=%s", "main").startsWith("Merge"), true);
});

// Each autonomy turn writes a fresh run record with its own `startedAt`, which the kit passes as the
// run id: a skip keyed on it never said "verified this run" in a later turn.
test("a later turn's check knows the verify an earlier turn of the same run passed", async () => {
  const root = makeProject("check-red");
  await inProject(root, async (project, plan) => {
    await quietly(() => verifyBase(project, "sandcastle-fixture:t", plan, "turn-1"));
    const { lines } = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "turn-2"));
    assert.match(skipped(lines) ?? "", /already \(verified this run\)/);
    // A record another process wrote (`sandcastle gates` by hand, an earlier run) is only "before".
    const file = join(root, ".sandcastle/.run/base-gates.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), run: "another" }) + "\n");
    const again = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "turn-3"));
    assert.match(skipped(again.lines) ?? "", /green at this commit and image before/);
  });
});
