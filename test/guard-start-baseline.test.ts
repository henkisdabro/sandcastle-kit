// A run's start holds the shared `.git/config`'s program-running keys and `info/attributes` to what the
// previous run recorded: a filter a sandbox planted in a run that was killed before any check is refused
// at the next start, not pinned as that run's baseline. No Docker, model calls or network.
//
//   pnpm test:file test/guard-start-baseline.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, recordGitConfigEnd, recordGitConfigStart } from "../src/guard.ts";
import { parseRunArgs } from "../src/run.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const root = join(mkdtempSync(join(tmpdir(), "sandcastle-guard-baseline-")), "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  return { project: { root, baseBranch: "main" } as Project, git };
};

const record = (root: string) => JSON.parse(readFileSync(join(root, ".sandcastle", ".run", "git-config-baseline.json"), "utf8"));

/** A run's start and its clean end, as burndown(), `land` and `gates` make them. */
const start = (project: Project, accept = false) => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run", accept));

const refusal = (project: Project) => {
  let said = "";
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), (e: Error) => ((said = e.message), /^NOT STARTED: /.test(said)));
  return said;
};

test("the first run under the kit, with no record, starts and records its baseline", () => {
  const { project, git } = repo();
  git("config", "filter.lfs.clean", "git-lfs clean");
  assert.doesNotThrow(() => start(project));
  assert.equal(record(project.root).clean, false);
  assert.deepEqual(record(project.root).entries, ["filter.lfs.clean\ngit-lfs clean"]);
});

test("a key added between two runs refuses the second, naming the key and not its value", () => {
  const { project, git } = repo();
  start(project);
  recordGitConfigEnd(project);
  git("config", "filter.evil.clean", "touch owned");
  const said = refusal(project);
  assert.match(said, /filter\.evil\.clean added/);
  assert.doesNotMatch(said, /touch owned/);
  assert.match(said, /sandcastle run --accept-git-config/);
  assert.match(said, /--unset-all/);
});

test("--accept-git-config starts the run and records the present state as the new baseline", () => {
  const { project, git } = repo();
  start(project);
  recordGitConfigEnd(project);
  git("config", "core.fsmonitor", "mine");
  refusal(project);
  assert.doesNotThrow(() => start(project, true));
  recordGitConfigEnd(project);
  assert.doesNotThrow(() => assertGitConfigBaseline(project, "sandcastle run"));
  assert.deepEqual(record(project.root).entries, ["core.fsmonitor\nmine"]);
});

test("a clean previous end with no change starts with no question, whatever else changed in the config", () => {
  const { project, git } = repo();
  git("config", "filter.lfs.clean", "git-lfs clean");
  start(project);
  recordGitConfigEnd(project);
  assert.equal(record(project.root).clean, true);
  // Keys that run nothing are not the baseline's business; the `.git` check judges them mid-run.
  git("config", "user.name", "Someone");
  git("config", "branch.topic.remote", "origin");
  assert.doesNotThrow(() => assertGitConfigBaseline(project, "sandcastle run"));
});

test("a run killed after a sandbox planted a filter is refused at the next start, and says the run did not end cleanly", () => {
  const { project, git } = repo();
  start(project);
  // No end: the run was killed before any check.
  git("config", "filter.evil.smudge", "touch owned");
  const said = refusal(project);
  assert.match(said, /filter\.evil\.smudge added/);
  assert.match(said, /did not end cleanly/);
});

test("a run killed with the program-running keys unchanged starts again with no flag", () => {
  const { project, git } = repo();
  git("config", "merge.ours.driver", "true");
  start(project);
  assert.doesNotThrow(() => start(project));
});

test("a key planted after the last check is not made the baseline by the run's end", () => {
  const { project, git } = repo();
  start(project);
  git("config", "diff.evil.textconv", "touch owned");
  recordGitConfigEnd(project);
  assert.equal(record(project.root).clean, false);
  assert.match(refusal(project), /diff\.evil\.textconv added/);
});

test("every kind of program-running key is held, and a changed or removed one is named", () => {
  for (const [key, value] of [
    ["filter.x.required", "true"],
    ["merge.x.driver", "touch owned"],
    ["diff.x.command", "touch owned"],
    ["diff.x.textconv", "touch owned"],
    ["core.fsmonitor", "touch owned"],
    ["core.hooksPath", "/tmp/hooks"],
    ["core.sshCommand", "touch owned"],
    ["include.path", "../elsewhere"],
    ["includeIf.gitdir:/x/.path", "../elsewhere"],
  ] as const) {
    const { project, git } = repo();
    start(project);
    recordGitConfigEnd(project);
    git("config", key, value);
    assert.match(refusal(project), new RegExp(`${key.replace(/[.\\]/g, "\\$&")} added`, "i"), key);
  }
  const { project, git } = repo();
  git("config", "filter.x.clean", "one");
  git("config", "filter.y.clean", "two");
  start(project);
  recordGitConfigEnd(project);
  git("config", "filter.x.clean", "three");
  git("config", "--unset", "filter.y.clean");
  const said = refusal(project);
  assert.match(said, /filter\.x\.clean changed/);
  assert.match(said, /filter\.y\.clean removed/);
});

test("a change to info/attributes is refused", () => {
  const { project } = repo();
  start(project);
  recordGitConfigEnd(project);
  mkdirSync(join(project.root, ".git", "info"), { recursive: true });
  writeFileSync(join(project.root, ".git", "info", "attributes"), "* filter=evil\n");
  assert.match(refusal(project), /info\/attributes added/);
  assert.doesNotThrow(() => start(project, true));
  assert.doesNotThrow(() => assertGitConfigBaseline(project, "sandcastle run"));
});

test("the check writes nothing: only a start under the run lock records", () => {
  const { project } = repo();
  assertGitConfigBaseline(project, "sandcastle run");
  assert.equal(existsSync(join(project.root, ".sandcastle", ".run", "git-config-baseline.json")), false);
});

test("--accept-git-config is a run argument that is not a ticket", () => {
  assert.deepEqual(parseRunArgs(["--accept-git-config", "12"]), { dry: false, issues: ["12"], acceptGitConfig: true });
  assert.deepEqual(parseRunArgs([]), { dry: false });
});

test("run, land and gates check before the pins and record after the run lock", () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const burndown = read("burndown.ts");
  const at = (text: string, needle: string) => {
    const i = text.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at(burndown, "assertGitConfigBaseline(project,") < at(burndown, "pinHostGitConfig(project.root)"));
  assert.ok(at(burndown, "lockRun(project);\n  recordGitConfigStart") > 0);
  const cli = read("cli.ts");
  for (const verb of ['case "gates"', 'case "land"']) {
    const body = cli.slice(at(cli, verb), at(cli, verb) + 1800);
    assert.ok(at(body, "assertGitConfigBaseline(") < at(body, "pinHostGitConfig("), verb);
    assert.ok(at(body, "lockRun(project)") < at(body, "recordGitConfigStart("), verb);
    assert.ok(body.includes("recordGitConfigEnd(project)"), verb);
  }
  assert.match(cli, /recordGitConfigEnd\(project\);\n\s+const redExit/);
  assert.match(cli, /acceptGitConfig: given\.acceptGitConfig/);
});
