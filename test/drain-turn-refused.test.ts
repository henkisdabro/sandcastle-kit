// A later autonomy turn that the checkout refuses (another session edited a file mid-run, a branch checked out by
// hand, git's leftovers) ends the run as the turn before it did: its cause is recorded in the run record for the
// closing summary, and the exit is the merged base's - 0 when green, 1 when red. Turn 1's refusal and every safety
// stop (the `.git` guard, a plain OperatorError) keep today's exit 1. burndown() needs Docker, so the cause is
// `turnRefusedCause` on refusals `assertCleanBase` builds in temp repos, the record is a child process ending as the
// loop does, and the loop's catch is held by a source match. No Docker, model or network.
//
//   pnpm test:file test/drain-turn-refused.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { KIT, runNode } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { turnRefusedCause } = await import("../src/autonomy.ts");
const { assertCleanBase } = await import("../src/run.ts");
const { assertGitConfigBaseline, recordGitConfigEnd, recordGitConfigStart } = await import("../src/guard.ts");
const { OperatorError } = await import("../src/errors.ts");
type Project = import("../src/config.ts").Project;

/** A repo on main with one commit; `.sandcastle/` ignored, as `sandcastle init` leaves it. */
const repo = () => {
  const root = join(mkdtempSync(join(tmpdir(), "sandcastle-turn-refused-")), "project");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, "GLOSSARY.md"), "# Glossary\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  return { project: { root, baseBranch: "main", name: "demo" } as Project, git };
};

/** What `assertCleanBase` throws on this checkout. */
const refusalOf = (project: Project): unknown => {
  try {
    assertCleanBase(project);
  } catch (error) {
    return error;
  }
  assert.fail("assertCleanBase let the checkout through");
};

test("a file edited mid-run makes turn 2's cause name the dirty file", () => {
  const { project } = repo();
  writeFileSync(join(project.root, "GLOSSARY.md"), "# Glossary\n\nedited by another session\n");
  const refusal = refusalOf(project);
  assert.ok(refusal instanceof OperatorError, "still an OperatorError, so every other caller is unchanged");
  assert.match((refusal as Error).message, /^NOT STARTED: the working tree is dirty\./);
  assert.equal(turnRefusedCause(refusal, 2), "turn 2 could not start: the working tree is dirty (GLOSSARY.md)");
});

test("seven dirty files: the cause names five and counts the other two", () => {
  const { project } = repo();
  for (const n of [1, 2, 3, 4, 5, 6, 7]) writeFileSync(join(project.root, `f${n}.txt`), "x\n");
  assert.equal(turnRefusedCause(refusalOf(project), 3), "turn 3 could not start: the working tree is dirty (f1.txt, f2.txt, f3.txt, f4.txt, f5.txt and 2 more)");
});

test("a branch that is not the base gives its cause", () => {
  const { project, git } = repo();
  git("checkout", "-q", "-b", "topic");
  assert.equal(turnRefusedCause(refusalOf(project), 2), "turn 2 could not start: not on main (found topic)");
});

test("git's half-done leftovers give their cause, naming the file", () => {
  const { project } = repo();
  writeFileSync(join(project.root, ".git/index.lock"), "");
  assert.equal(turnRefusedCause(refusalOf(project), 2), "turn 2 could not start: git left something half-done (.git/index.lock)");
});

test("the .git guard's refusal and a plain OperatorError give no cause", () => {
  const { project, git } = repo();
  recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run"));
  recordGitConfigEnd(project);
  git("config", "filter.evil.clean", "touch owned");
  let guard: unknown;
  try {
    assertGitConfigBaseline(project, "sandcastle run");
  } catch (error) {
    guard = error;
  }
  assert.match((guard as Error).message, /^NOT STARTED: the shared \.git differs/);
  assert.equal(turnRefusedCause(guard, 2), undefined);
  assert.equal(turnRefusedCause(new OperatorError("NOT STARTED: something else"), 2), undefined);
  assert.equal(turnRefusedCause(new Error("a crash"), 2), undefined);
});

test("a refused turn 2 ends the run with the merged base's exit, and the record keeps the cause", () => {
  const { project } = repo();
  writeFileSync(join(project.root, "GLOSSARY.md"), "edited\n");
  const script = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "turn-two.ts");
  const at = (path: string) => JSON.stringify(pathToFileURL(join(KIT, path)).href);
  // Turn 1's record, its verify as the turn re-gated it; then turn 2 refused, caught and ended as the loop does.
  writeFileSync(
    script,
    [
      `import { readFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { assertCleanBase, recordDrain, recordRun } from ${at("src/run.ts")};`,
      `import { redBaseExit, turnRefusedCause } from ${at("src/autonomy.ts")};`,
      `const project = { name: "demo", root: process.argv[2], baseBranch: "main" } as never;`,
      `const run = recordRun(project);`,
      `run.update({ stage: "report", verify: JSON.parse(process.argv[3]) });`,
      `let cause: string | undefined;`,
      `try { assertCleanBase(project); } catch (error) { cause = turnRefusedCause(error, 2); if (!cause) throw error; }`,
      `recordDrain({ turns: 1, landed: 15, cause: cause! });`,
      `const code = redBaseExit({ verify: JSON.parse(readFileSync(join(process.argv[2], ".sandcastle/logs/run.json"), "utf8")).verify });`,
      `if (code) process.exitCode = code;`,
    ].join("\n"),
  );
  const ends = (verify: object) => {
    const r = runNode([script, project.root, JSON.stringify(verify)], { encoding: "utf8", env: process.env });
    const record = JSON.parse(readFileSync(join(project.root, ".sandcastle/logs/run.json"), "utf8"));
    return { status: r.status, recorded: record.exitCode, drain: record.drain };
  };
  const drain = { turns: 1, landed: 15, cause: "turn 2 could not start: the working tree is dirty (GLOSSARY.md)" };
  assert.deepEqual(ends({ green: true, line: "all green" }), { status: 0, recorded: 0, drain });
  assert.deepEqual(ends({ green: false, line: "test red" }), { status: 1, recorded: 1, drain });
});

test("the run loop catches a refused turn only after the first, records its cause and still reaches the exit code", () => {
  const cli = readFileSync(join(KIT, "src/cli.ts"), "utf8");
  const loop = cli.slice(cli.indexOf("for (let turn = 1; ; turn++)"), cli.indexOf('case "status":'));
  const caught = loop.slice(loop.indexOf("} catch (error) {"), loop.indexOf("if (!started)"));
  assert.match(caught, /const cause = turn > 1 \? turnRefusedCause\(error, turn\) : undefined;\n\s+if \(!cause\) throw error;/);
  // The refusal's own words, as the CLI's handler printed them, then the steps the turn's summary handed to the loop.
  assert.match(caught, /console\.error\(`\\n\$\{\(error as Error\)\.message\}`\);/);
  assert.match(caught, /drain\.cause = cause;/);
  assert.match(caught, /console\.log\(await operatorSteps\(project\)\);\n\s+break;/);
  // After the loop: the line and the record at every level, then the git config's end and the red-base exit.
  const after = loop.slice(loop.indexOf("refusedTurn))"));
  assert.match(after, /console\.log\(turnsEndLine\(level, end\)\);\n\s+recordDrain\(end\);/);
  for (const [a, b] of [["recordDrain(end)", "recordGitConfigEnd(project)"], ["recordGitConfigEnd(project)", "const redExit = redBaseExit("]]) {
    assert.ok(after.indexOf(a) >= 0 && after.indexOf(a) < after.indexOf(b), `${a} before ${b}`);
  }
});
