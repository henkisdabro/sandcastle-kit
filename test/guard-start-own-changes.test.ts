// After a clean end of the last run, the start takes the narrow class of changes that look like a person's own
// tooling - a new remote at a plain https or ssh URL, `core.hooksPath` in a tracked directory of the repo, a hook file
// a hook manager writes - prints a line for each and records the new baseline; everything else, and every change after
// an unclean end, is refused with the words that tell the two apart. No Docker, model calls or network.
//
//   pnpm test:file test/guard-start-own-changes.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, recordGitConfigEnd, recordGitConfigStart, tookLines } from "../src/guard.ts";
import { quietly } from "./quiet.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const root = join(mkdtempSync(join(tmpdir(), "sandcastle-guard-own-")), "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  return { project: { root, baseBranch: "main" } as Project, git };
};

const record = (root: string) => JSON.parse(readFileSync(join(root, ".sandcastle", ".run", "git-config-baseline.json"), "utf8"));

/** A run's start (printing what it took) and its clean end; the lines the start printed come back. */
const start = async (project: Project, accept = false) => (await quietly(() => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run", accept)))).lines;
const cleanRun = async (project: Project) => {
  const lines = await start(project);
  recordGitConfigEnd(project);
  return lines;
};
/** A run that starts and never ends: killed. */
const killedRun = (project: Project) => start(project);

const refusal = (project: Project) => {
  let said = "";
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), (e: Error) => ((said = e.message), said.startsWith("NOT STARTED: ")));
  return said;
};

const hook = (root: string, name: string, text: string) => {
  const path = join(root, ".git", "hooks", name);
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

test("a remote with a plain https URL, added after a clean end, is taken with one line and recorded", async () => {
  const { project, git } = repo();
  await cleanRun(project);
  git("remote", "add", "fork", "https://example.invalid/me/project.git");
  const lines = await start(project);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Took as your own, since the last run ended cleanly - /);
  assert.match(lines[0], /remote\.fork\.url added: "https:\/\/example\.invalid\/me\/project\.git"/);
  assert.match(lines[0], /a new remote at a plain https URL/);
  assert.ok(record(project.root).entries.includes("remote.fork.url\nhttps://example.invalid/me/project.git"));
  assert.equal(record(project.root).clean, false);
  recordGitConfigEnd(project);
  assert.deepEqual(await start(project), []);
});

test("a new remote at an ssh URL, in either form, is taken", async () => {
  for (const url of ["ssh://git@example.invalid:2222/me/project.git", "git@example.invalid:me/project.git", "ssh://example.invalid/me/project.git"]) {
    const { project, git } = repo();
    await cleanRun(project);
    git("remote", "add", "fork", url);
    const lines = await start(project);
    assert.match(lines.join("\n"), /a new remote at a plain ssh URL/, url);
  }
});

test("a new remote whose URL is not plain https or ssh is refused after a clean end", async () => {
  for (const url of [
    "http://example.invalid/me/project.git",
    "https://someone:s3cr3t@example.invalid/me/project.git",
    "https://example.invalid/me/project.git?token=abc",
    "ext::sh -c touch% owned",
    "file:///tmp/elsewhere",
    "/tmp/elsewhere",
    "../elsewhere",
    "git://example.invalid/me/project.git",
    "ssh://-oProxyCommand=touch/x",
    "git@-oProxyCommand=touch:x",
  ]) {
    const { project, git } = repo();
    await cleanRun(project);
    git("config", "remote.fork.url", url);
    const said = refusal(project);
    assert.match(said, /remote\.fork\.url added/, url);
    assert.doesNotMatch(said, /looks like your own tooling/, url);
    assert.doesNotMatch(said, /s3cr3t/, url);
  }
});

test("a changed URL on an existing remote, origin included, is refused after a clean end", async () => {
  for (const name of ["origin", "fork"]) {
    const { project, git } = repo();
    git("remote", "add", name, "https://example.invalid/me/project.git");
    await cleanRun(project);
    git("remote", "set-url", name, "https://example.invalid/me/elsewhere.git");
    const said = refusal(project);
    assert.match(said, new RegExp(`remote\\.${name}\\.url: `), name);
    assert.doesNotMatch(said, /looks like your own tooling/, name);
  }
});

test("a removed remote, and a new remote's other keys, are refused after a clean end", async () => {
  const { project, git } = repo();
  git("remote", "add", "fork", "https://example.invalid/me/project.git");
  await cleanRun(project);
  git("remote", "remove", "fork");
  assert.match(refusal(project), /remote\.fork\.url removed/);

  for (const [key, value] of [
    ["remote.other.proxy", "http://proxy.invalid:3128"],
    ["remote.other.uploadpack", "touch owned"],
    ["remote.other.pushurl", "https://example.invalid/me/pushed.git"],
  ] as const) {
    const again = repo();
    await cleanRun(again.project);
    again.git("remote", "add", "other", "https://example.invalid/me/other.git");
    again.git("config", key, value);
    const said = refusal(again.project);
    assert.match(said, new RegExp(`${key.replace(/\./g, "\\.")} added`), key);
    // The plain remote beside it is marked, the rest is not: the start names both and takes neither.
    assert.match(said, /remote\.other\.url added: "https:\/\/example\.invalid\/me\/other\.git" \(looks like your own tooling: a new remote at a plain https URL\)/);
    assert.doesNotMatch(said, new RegExp(`${key.replace(/\./g, "\\.")} added[^;.]*looks like`), key);
  }
});

test("a url rewrite, a filter and a transport command beside a plain remote refuse the whole start", async () => {
  for (const [key, value] of [
    ["url.https://example.invalid/.insteadOf", "https://elsewhere.invalid/"],
    ["filter.x.clean", "touch owned"],
    ["core.sshCommand", "touch owned"],
    ["merge.x.driver", "touch owned"],
  ] as const) {
    const { project, git } = repo();
    await cleanRun(project);
    git("remote", "add", "fork", "https://example.invalid/me/project.git");
    git("config", key, value);
    const said = refusal(project);
    assert.match(said, /The last run ended cleanly/);
    assert.match(said, /looks like your own tooling/);
    assert.doesNotMatch(said, /touch owned/);
    // Nothing was recorded by the refusal: the next start still sees the difference.
    assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), /NOT STARTED/);
  }
});

test("core.hooksPath set to a directory in a tracked directory of the repo is taken, husky's untracked .husky/_ included", async () => {
  for (const dir of [".husky", ".husky/_", "tools/hooks"]) {
    const { project, git } = repo();
    await cleanRun(project);
    mkdirSync(join(project.root, dir), { recursive: true });
    const tracked = dir.split("/")[0] === ".husky" ? ".husky" : dir;
    writeFileSync(join(project.root, tracked, "pre-commit"), "#!/bin/sh\ntrue\n");
    git("add", "--", `${tracked}/pre-commit`);
    git("config", "core.hooksPath", dir);
    const lines = await start(project);
    assert.equal(lines.length, 1, dir);
    assert.match(lines[0], new RegExp(`core\\.hookspath added: "${dir.replace(/[./]/g, "\\$&")}"`, "i"), dir);
    assert.match(lines[0], /a hooks path in a tracked directory of the repo/);
    assert.ok(record(project.root).entries.includes(`core.hookspath\n${dir}`), dir);
  }
});

test("core.hooksPath anywhere else is refused after a clean end, with its value not shown", async () => {
  const { project, git } = repo();
  mkdirSync(join(project.root, "untracked"), { recursive: true });
  mkdirSync(join(project.root, "tracked"), { recursive: true });
  writeFileSync(join(project.root, "tracked", "pre-commit"), "x");
  git("add", "--", "tracked/pre-commit");
  symlinkSync("/", join(project.root, "tracked", "link"));
  for (const value of ["/tmp/hooks", "~/hooks", "untracked", "missing", "tracked/../untracked", "../outside", ".git/hooks-evil", ".", "", "tracked/link", "-x"]) {
    await cleanRun(project);
    git("config", "core.hooksPath", value);
    const said = refusal(project);
    assert.match(said, /core\.hooksPath (added|changed)/i, value);
    assert.doesNotMatch(said, /looks like your own tooling/, value);
    if (value.length > 1) assert.ok(!said.includes(`"${value}"`), value);
    git("config", "--unset", "core.hooksPath");
    await start(project, true);
  }
});

test("a hook file a hook manager writes is taken after a clean end; another script, or another place, is refused", async () => {
  const lefthook = '#!/bin/sh\nif [ "$LEFTHOOK_VERBOSE" = "1" ]; then\n  set -x\nfi\nif [ "$LEFTHOOK" = "0" ]; then\n  exit 0\nfi\ncall_lefthook() { lefthook "$@"; }\n';
  const preCommit = "#!/usr/bin/env python3\n# File generated by pre-commit: https://pre-commit.com\n# ID: 138fd403232d2ddd5efb44317e38bf03\nimport sys\n";
  const husky = "#!/bin/sh\n# husky\n# Created by Husky v4\n. husky.sh\n";
  for (const [manager, text] of [["lefthook", lefthook], ["pre-commit", preCommit], ["husky", husky]] as const) {
    const { project } = repo();
    await cleanRun(project);
    hook(project.root, "pre-commit", text);
    const lines = await start(project);
    assert.equal(lines.length, 1, manager);
    assert.match(lines[0], new RegExp(`hooks/pre-commit added - a hook written by ${manager}`), manager);
    // Written again by an upgrade of the tool: changed, taken.
    recordGitConfigEnd(project);
    hook(project.root, "pre-commit", `${text}# newer\n`);
    assert.match((await start(project)).join("\n"), /hooks\/pre-commit changed/, manager);
  }

  const { project } = repo();
  await cleanRun(project);
  hook(project.root, "pre-commit", "#!/bin/sh\ntouch owned\n");
  const said = refusal(project);
  assert.match(said, /hooks\/pre-commit added/);
  assert.doesNotMatch(said, /looks like your own tooling/);

  // A marker in a file that is not a script, a link, a directory, a removal, a subdirectory: none is a manager's hook file.
  await start(project, true);
  recordGitConfigEnd(project);
  hook(project.root, "post-commit", "# File generated by pre-commit: https://pre-commit.com\ntouch owned\n");
  assert.doesNotMatch(refusal(project), /looks like your own tooling/);
  await start(project, true);
  recordGitConfigEnd(project);
  symlinkSync("/bin/true", join(project.root, ".git", "hooks", "pre-push"));
  assert.doesNotMatch(refusal(project), /looks like your own tooling/);
  await start(project, true);
  recordGitConfigEnd(project);
  hook(project.root, "pre-commit", "");
  hook(project.root, "pre-commit", lefthook);
  mkdirSync(join(project.root, ".git", "hooks", "sub"));
  writeFileSync(join(project.root, ".git", "hooks", "sub", "pre-commit"), lefthook);
  const nested = refusal(project);
  assert.match(nested, /hooks\/sub\/pre-commit added[,.]/);
  assert.match(nested, /hooks\/sub added[,.]/);
});

test("a hook manager's file beside a planted filter, or an info/attributes change, refuses the whole start", async () => {
  const { project, git } = repo();
  await cleanRun(project);
  hook(project.root, "pre-commit", '#!/bin/sh\nif [ "$LEFTHOOK" = "0" ]; then\n  exit 0\nfi\n');
  git("config", "filter.x.clean", "touch owned");
  assert.match(refusal(project), /hooks\/pre-commit added \(looks like your own tooling: a hook written by lefthook\)/);
  git("config", "--unset", "filter.x.clean");
  mkdirSync(join(project.root, ".git", "info"), { recursive: true });
  writeFileSync(join(project.root, ".git", "info", "attributes"), "* filter=x\n");
  assert.match(refusal(project), /info\/attributes added/);
});

test("after an unclean end every change is refused, and the refusal says which look like a person's own tooling", async () => {
  const { project, git } = repo();
  await killedRun(project);
  git("remote", "add", "fork", "https://example.invalid/me/project.git");
  git("config", "filter.evil.clean", "touch owned");
  const said = refusal(project);
  assert.match(said, /did not end cleanly/);
  assert.doesNotMatch(said, /ended cleanly\./);
  assert.match(said, /remote\.fork\.url added: "https:\/\/example\.invalid\/me\/project\.git" \(looks like your own tooling: a new remote at a plain https URL\)/);
  assert.match(said, /filter\.evil\.clean added[;.]/);

  const alone = repo();
  await killedRun(alone.project);
  alone.git("remote", "add", "fork", "https://example.invalid/me/project.git");
  assert.match(refusal(alone.project), /did not end cleanly/);
  assert.equal((await quietly(() => recordGitConfigStart(alone.project, assertGitConfigBaseline(alone.project, "sandcastle run", true)))).lines.length, 0);
});

test("a refusal after a clean end says so, and a mixed one says what the start would have taken", async () => {
  const { project, git } = repo();
  await cleanRun(project);
  git("config", "filter.evil.clean", "touch owned");
  const plain = refusal(project);
  assert.match(plain, /The last run ended cleanly\. Something wrote them between the runs\./);
  assert.doesNotMatch(plain, /marked as looking like your own tooling/);

  git("remote", "add", "fork", "https://example.invalid/me/project.git");
  assert.match(refusal(project), /Changes marked as looking like your own tooling are taken without a question when nothing else differs/);
});

test("the run's end does not record a taken change as clean unless the .git still holds the start's state", async () => {
  const { project, git } = repo();
  await cleanRun(project);
  git("remote", "add", "fork", "https://example.invalid/me/project.git");
  await start(project);
  git("config", "filter.evil.clean", "touch owned");
  recordGitConfigEnd(project);
  assert.equal(record(project.root).clean, false);
  assert.match(refusal(project), /did not end cleanly/);
});

test("a detached start shows what it took on its own terminal, as the child's log does", async () => {
  const { project, git } = repo();
  await cleanRun(project);
  git("remote", "add", "fork", "https://example.invalid/me/project.git");
  // The parent's check, which records nothing: the lines it prints are the ones the child's start prints.
  const parent = tookLines(assertGitConfigBaseline(project, "sandcastle run"));
  assert.equal(parent.length, 1);
  assert.deepEqual(await start(project), parent);
  // The parent keeps its check's result and prints those lines once the child is going.
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const detach = cli.slice(cli.indexOf("// The child checks again for itself"), cli.indexOf("for (const line of started.lines)"));
  assert.match(detach, /const baseline = assertGitConfigBaseline\(project, "sandcastle run", given\.acceptGitConfig\);/);
  assert.match(detach, /if \(started\.code === 0\) for \(const line of tookLines\(baseline\)\) console\.log\(line\);/);
});
