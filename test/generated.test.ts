// Generated files: the path matching, the resolve-by-regenerating helper against a real merge
// conflict in a temp repo (no Docker, no model, no network), and the config key's validation.
//
//   pnpm exec tsx --test test/generated.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { covers, regensFor, resolveGenerated } = await import("../src/generated.ts");
const { loadProject } = await import("../src/config.ts");

const g = (paths: string[], regen = "x") => ({ paths, regen });

test("covers: a directory with or without a slash, an exact file", () => {
  for (const dir of ["dist/", "dist"]) {
    assert.ok(covers(dir, "dist/a.css"));
    assert.ok(!covers(dir, "dist2/a.css"));
  }
  assert.ok(covers("out.txt", "out.txt"));
  assert.ok(!covers("out.txt", "out.txt.bak"));
  assert.ok(!covers("out.txt", "sub/out.txt"));
});

test("regensFor: undefined unless every file is covered; entries once, in config order", () => {
  const a = g(["dist/"], "a");
  const b = g(["data.json"], "b");
  assert.equal(regensFor(["dist/a.css", "src/x.ts"], [a, b]), undefined);
  assert.deepEqual(regensFor(["dist/a.css", "dist/b.css"], [a, b]), [a]);
  assert.deepEqual(regensFor(["data.json", "dist/a.css"], [a, b]), [a, b]);
  assert.deepEqual(regensFor(["data.json", "dist/a.css"], [b, a]), [b, a]);
  assert.equal(regensFor([], [a]), undefined);
  assert.equal(regensFor(["dist/a.css"], []), undefined);
});

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-generated-"));

// Runs `sh -c` in the repo. execGate wraps every command in `timeout -k n n`, which macOS lacks.
const sandboxAt = (cwd: string) => ({
  exec: async (cmd: string) => {
    const bare = cmd.replace(/^timeout -k \d+ \d+ /, "");
    const r = spawnSync("sh", ["-c", bare], { cwd, encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  },
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};

const REGEN = "tr '\\n' ' ' < src.txt > out.txt";
let n = 0;

// main changes line 1 of src.txt, agent/issue-7 line 3 (and `extra`, when given, a plain file
// both change); each regenerates out.txt, one line, so merging main in conflicts in out.txt.
const fixture = (extra = false) => {
  const cwd = join(tmp, `repo${n++}`);
  mkdirSync(cwd);
  git(cwd, "init", "-q", "-b", "main");
  writeFileSync(join(cwd, "src.txt"), "a\nb\nc\n");
  writeFileSync(join(cwd, "plain.txt"), "one\n");
  spawnSync("sh", ["-c", REGEN], { cwd });
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "base");
  git(cwd, "checkout", "-q", "-b", "agent/issue-7");
  writeFileSync(join(cwd, "src.txt"), "a\nb\nC\n");
  if (extra) writeFileSync(join(cwd, "plain.txt"), "branch\n");
  spawnSync("sh", ["-c", REGEN], { cwd });
  git(cwd, "commit", "-q", "-am", "branch");
  git(cwd, "checkout", "-q", "main");
  writeFileSync(join(cwd, "src.txt"), "A\nb\nc\n");
  if (extra) writeFileSync(join(cwd, "plain.txt"), "main\n");
  spawnSync("sh", ["-c", REGEN], { cwd });
  git(cwd, "commit", "-q", "-am", "main");
  git(cwd, "checkout", "-q", "agent/issue-7");
  assert.notEqual(git(cwd, "merge", "--no-edit", "main").status, 0);
  const files = git(cwd, "diff", "--name-only", "--diff-filter=U").out.split("\n");
  return { cwd, files };
};

const identity = "-c user.name='T' -c user.email='t@localhost'";

test("resolveGenerated: a conflict in generated files only is regenerated and committed", async () => {
  const { cwd, files } = fixture();
  assert.deepEqual(files, ["out.txt"]);
  const marker = join(tmp, "setup-ran");
  const message = "Merge main into agent/issue-7 (generated files regenerated)";
  const r = await resolveGenerated(sandboxAt(cwd), {
    files,
    generated: [g(["out.txt"], REGEN)],
    setup: [`printf x >> '${marker}'`],
    message,
    identity,
  });
  assert.deepEqual(r, { ok: true, regen: [REGEN] });
  assert.equal(readFileSync(join(cwd, "out.txt"), "utf8"), "A b C ");
  assert.equal(git(cwd, "log", "-1", "--format=%P").out.split(" ").length, 2);
  assert.equal(git(cwd, "log", "-1", "--format=%s").out, message);
  assert.equal(git(cwd, "status", "--porcelain").out, "");
  assert.equal(readFileSync(marker, "utf8"), "x");
});

test("resolveGenerated: a failing regen leaves the merge in progress", async () => {
  const { cwd, files } = fixture();
  const head = git(cwd, "rev-parse", "HEAD").out;
  const r = await resolveGenerated(sandboxAt(cwd), {
    files,
    generated: [g(["out.txt"], "exit 3")],
    setup: [],
    message: "m",
    identity,
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /regen "exit 3" exited 3/);
  assert.ok(existsSync(join(cwd, ".git", "MERGE_HEAD")));
  assert.equal(git(cwd, "rev-parse", "HEAD").out, head);
});

test("resolveGenerated: a conflict outside the generated paths runs nothing", async () => {
  const { cwd, files } = fixture(true);
  assert.deepEqual([...files].sort(), ["out.txt", "plain.txt"]);
  const marker = join(tmp, "regen-ran");
  const r = await resolveGenerated(sandboxAt(cwd), {
    files,
    generated: [g(["out.txt"], `touch '${marker}'`)],
    setup: [],
    message: "m",
    identity,
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /conflicts outside the generated paths: plain\.txt/);
  assert.ok(!existsSync(marker));
});

const project = (generated: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-config-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(
    join(root, ".sandcastle", "config.ts"),
    `export default { name: "t", tracker: "github", gates: [{ name: "g", command: "true" }]${generated} };\n`,
  );
  return root;
};

test("loadProject: validates and normalises `generated`", async () => {
  await assert.rejects(
    loadProject(project(`, generated: [{ paths: [], regen: "x" }]`)),
    { message: ".sandcastle/config.ts: each `generated` entry needs `paths` (files, or directories) and `regen` (the command that writes them)." },
  );
  await assert.rejects(loadProject(project(`, generated: [{ paths: ["a"], regen: "" }]`)), /each `generated` entry needs/);
  assert.deepEqual((await loadProject(project(`, generated: [{ paths: ["./dist/"], regen: "x" }]`))).generated, [
    { paths: ["dist/"], regen: "x" },
  ]);
  assert.deepEqual((await loadProject(project(""))).generated, []);
});
