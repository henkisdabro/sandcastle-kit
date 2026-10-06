// A red merged tree also blames a landed ticket that changed a file the failing test imports or names,
// though the branch never touched it: the branch adds a test for (or a caller of) x.ts, a ticket that
// landed first changed x.ts. The subject is read from the gate output and the test file, as far as they
// show it (the output only finds the test file). Temp repos and a host worktree for the sandbox: no Docker, no gh, no network. The fake
// sandbox strips the `timeout -k` wrapper macOS lacks.
//
//   node --test test/requeue-red-subject.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne, redSubject } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-red-subject-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};

// main holds src/x.ts. 1 changes it, 3 adds an unrelated file; 2 adds a test that uses x.ts and touches nothing else.
const makeRepo = (testText: string, bulk = 0) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  if (bulk) {
    // Paths of some 200 characters, one blob, written straight to the index: no 6,000 file writes.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "x\n", encoding: "utf8" }).trim();
    const entries = Array.from({ length: bulk }, (_, i) => `100644 ${blob}\tbulk/${"a".repeat(190)}${i}.txt\n`).join("");
    execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: entries });
  }
  commitFile(root, "src/x.ts", "export const x = 1;\n", "start");
  if (bulk) git(root, "reset", "-q", "--hard");
  const branch = (id: string, files: Record<string, string>) => {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    for (const [file, text] of Object.entries(files)) commitFile(root, file, text, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  };
  branch("1", { "src/x.ts": "export const x = 2;\n" });
  branch("3", { "src/other.ts": "export const other = 1;\n" });
  branch("2", { "test/x.test.ts": testText });
  return root;
};

const opener = (root: string): Ctx["opener"] => async (branch) => {
  const path = join(TMP, `wt${n++}`);
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

const failureWith = (output: string) => ({ name: "test", command: "test", exitCode: 1, output });
const redWith = (output: string): GateRun => ({ gates: [{ name: "test", pass: false }], failure: failureWith(output), failures: [failureWith(output)] });
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

// Red once 1's change to x.ts is in the tree together with the branch's test.
const harness = (root: string, output: string) => {
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, get: () => ({ body: "" }), close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async (box) => ((await box.exec("grep -q 'x = 2' src/x.ts && test -e test/x.test.ts")).exitCode === 0 ? redWith(output) : GREEN),
    landed: new Map(),
  };
  return { land: (id: string) => landOne(ctx, { issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${id}`) }) };
};

test("red names the landed ticket that changed a file the failing test imports, though the branch never touched it", async () => {
  const root = makeRepo('import { x } from "../src/x.ts";\nconsole.log(x);\n');
  const h = harness(root, "✖ x is 1 (0.4ms)\n  at test/x.test.ts:3:1\n");
  await h.land("1");
  await h.land("3");
  assert.deepEqual(await h.land("2"), { kind: "red", with: ["1"], gates: ["test"], failing: ["x is 1"] });
});

test("red names a landed ticket that changed a file only the test's text names", async () => {
  const root = makeRepo('import { readFileSync } from "node:fs";\nreadFileSync("src/x.ts");\n');
  const h = harness(root, "FAIL test/x.test.ts\n");
  await h.land("1");
  await h.land("3");
  assert.deepEqual(await h.land("2"), { kind: "red", with: ["1"], gates: ["test"], failing: ["test/x.test.ts"] });
});

test("a source file only the gate output names is no suspect: the output finds the test, and the test says what it uses", async () => {
  const root = makeRepo("console.log(1);\n");
  const h = harness(root, "Error: bad value\n    at x (/work/tree/src/x.ts:1:1)\n");
  await h.land("1");
  await h.land("3");
  const landed = await h.land("2");
  assert.deepEqual(landed.kind === "red" && landed.with, []);
});

test("red names only the landed ticket whose file the failing test uses, not the others", async () => {
  const root = makeRepo('import { other } from "../src/other.ts";\nconsole.log(other);\n');
  const h = harness(root, "FAIL test/x.test.ts\n");
  await h.land("1");
  await h.land("3");
  const landed = await h.land("2");
  assert.equal(landed.kind, "red");
  // 3 changed src/other.ts, which the test imports; 1's src/x.ts is nothing the test uses.
  assert.deepEqual(landed.kind === "red" && landed.with, ["3"]);
});

test("red on the merged tree when neither the branch nor its failing test shares a file with what landed", async () => {
  const root = makeRepo("console.log(1);\n");
  const h = harness(root, "FAIL test/x.test.ts\n");
  await h.land("1");
  await h.land("3");
  const landed = await h.land("2");
  assert.deepEqual(landed.kind === "red" && landed.with, []);
});

test("redSubject: the test files the output names, their relative imports, and the paths their text names", () => {
  const tree = ["src/x.ts", "src/lib/index.ts", "src/y.js", "test/x.test.ts", "pkg/mod.py", "tests/test_mod.py", "README.md"];
  const texts: Record<string, string> = {
    "test/x.test.ts": 'import a from "../src/x.js";\nimport b from "../src/lib";\nconst p = "src/y.js";\nimport c from "left-pad";\n',
    "tests/test_mod.py": "from pkg.mod import f\nimport os\n",
  };
  const read = (f: string) => texts[f];
  assert.deepEqual([...redSubject("FAIL ./test/x.test.ts\n", tree, read)].sort(), ["src/lib/index.ts", "src/x.ts", "src/y.js", "test/x.test.ts"]);
  assert.deepEqual([...redSubject("FAILED tests/test_mod.py::test_f - boom\n", tree, read)].sort(), ["pkg/mod.py", "tests/test_mod.py"]);
  // An absolute path from a sandbox is cut from the left; a file the tree lacks, or a source file, is no subject.
  assert.deepEqual([...redSubject("at /home/agent/work/test/x.test.ts:1:1 and /nowhere/ghost.test.ts", tree, () => undefined)], ["test/x.test.ts"]);
  assert.deepEqual([...redSubject("at /home/agent/work/src/x.ts:1:1", tree, () => undefined)], []);
  assert.deepEqual([...redSubject("nothing to see", tree, read)], []);
});

test("red still names the landed ticket when the tree's listing passes Node's 1 MiB output limit", async () => {
  // 6,000 paths: a listing of about 1.2 MiB.
  const root = makeRepo('import { x } from "../src/x.ts";\nconsole.log(x);\n', 6000);
  const h = harness(root, "FAIL test/x.test.ts\n");
  await h.land("1");
  await h.land("3");
  const landed = await h.land("2");
  assert.deepEqual(landed.kind === "red" && landed.with, ["1"]);
});
