// A sandbox can write the shared `.git` while its ticket runs. A merge driver it puts in
// `.git/config`, mapped to every path by `.git/info/attributes`, would run on the host at the
// kit's next `git merge-tree`, before any fingerprint check sees it. Every host merge-tree runs in
// a throwaway git directory that borrows only the objects, so the driver never runs, and a real
// conflict is still found: the resolve check (`strayChanges`), the pipeline's check before review
// and gates (`conflictBefore`, through `mergeTree`), landing's pre-check (`landOne`) and the
// landing merge's tree check (`plainMergeNote`). Temp git repos - no Docker, model or network.
//
//   pnpm test:file test/merge-driver.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

// Its own TMPDIR: `temps()` below lists the `sandcastle-merge-*` directories there, and every other test file that reaches
// `withObjectsOnly` makes and removes one in the shared TMPDIR between its two listings.
process.env.TMPDIR = mkdtempSync(join(tmpdir(), "sandcastle-driver-tmp-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-driver-cache-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-driver-cfg-"));
process.env.SANDCASTLE_MAX_SANDBOXES = "1";
const { mergeTree, strayChanges } = await import("../src/resolution.ts");
const { plainMergeNote } = await import("../src/land.ts");
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { inject } = await import("../src/pool.ts");
const { commandOf } = await import("../src/live-runs.ts");
// A landing the driver let through would take a slot, as a run would: `ps` would call this a test runner, and its slot stale.
inject({ probe: (pid) => (pid === process.pid ? everyPidIsTheKit() : commandOf(pid)) });
type Project = import("../src/config.ts").Project;
type Ctx = import("../src/landing.ts").LandContext;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-driver-"));
let n = 0;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const commit = (root: string, files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
};

const lines = (first: string, last: string) => `${first}\n2\n3\n4\n5\n6\n${last}\n`;

/**
 * main starts with `shared.txt` and `both.txt`. `agent/issue-7` changes `shared.txt`'s first line,
 * as main does after it (ticket 3 landing): a real conflict. `agent/issue-8` changes `both.txt`'s
 * first line and main its last: a clean merge that still runs a merge driver. Then the sandbox's
 * driver is planted, after the merge of `agent/issue-8` was made, as a landing sandbox makes it.
 */
const setup = (objectFormat = "sha1") => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main", `--object-format=${objectFormat}`);
  commit(root, { "shared.txt": lines("start", "end"), "both.txt": lines("start", "end") }, "start");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  commit(root, { "shared.txt": lines("from seven", "end") }, "work on 7");
  git(root, "checkout", "-q", "-b", "agent/issue-8", "main");
  commit(root, { "both.txt": lines("from eight", "end") }, "work on 8");
  git(root, "checkout", "-q", "main");
  commit(root, { "shared.txt": lines("from three", "end"), "both.txt": lines("start", "from three") }, "ticket 3 landed");
  const base = git(root, "rev-parse", "main");
  const seven = git(root, "rev-parse", "agent/issue-7");
  const eight = git(root, "rev-parse", "agent/issue-8");
  git(root, "checkout", "-q", "-b", "landing", "main");
  git(root, "merge", "-q", "--no-edit", eight);
  const landing = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");

  // What a sandbox can write: a driver that leaves a marker and "resolves" every merge to its own text.
  const marker = join(tmp, `ran${n++}`);
  git(root, "config", "merge.planted.driver", `touch '${marker}'; echo planted > %A; exit 0`);
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  writeFileSync(join(root, ".git", "info", "attributes"), "* merge=planted\n");
  // The fixture is armed: the repository's own merge-tree runs the driver, and it hides the conflict.
  const own = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", base, seven], { cwd: root, encoding: "utf8" });
  assert.equal(own.status, 0, "the planted driver resolved the conflict in the repository's own merge-tree");
  assert.ok(existsSync(marker), "the repository's own merge-tree ran the planted driver");
  rmSync(marker);
  return { root, base, seven, eight, landing, marker };
};

test("the pipeline's conflict check finds a real conflict and runs no merge driver from the shared .git", () => {
  const { root, base, seven, marker } = setup();
  assert.deepEqual([...mergeTree(root, base, seven).conflicted], ["shared.txt"]);
  assert.equal(existsSync(marker), false);
});

test("the resolve check finds the real conflict and runs no merge driver from the shared .git", () => {
  const { root, base, seven, marker } = setup();
  git(root, "checkout", "-q", "agent/issue-7");
  // The resolver's merge, made by hand so no driver takes part: the conflict resolved, main's both.txt kept.
  git(root, "merge", "-q", "-s", "ours", "--no-commit", base);
  writeFileSync(join(root, "shared.txt"), lines("from seven and three", "end"));
  writeFileSync(join(root, "both.txt"), lines("start", "from three"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-edit");
  const resolved = git(root, "rev-parse", "HEAD");
  // A driver that ran would have merged shared.txt cleanly, and the resolution of it would be a stray.
  assert.deepEqual(strayChanges(root, { ours: seven, theirs: base, resolved }), []);
  assert.equal(existsSync(marker), false);
});

test("landing's pre-check finds a real conflict and runs no merge driver from the shared .git", async () => {
  const { root, seven, marker } = setup();
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const opened: string[] = [];
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, close: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: async (name) => {
      opened.push(name);
      throw new Error("no sandbox in this test");
    },
    withdrawal: () => undefined,
    // Fingerprinted with the driver in place: it was written between two checks, so none stops it.
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [], failures: [] }),
    landed: new Map([["3", { commit: git(root, "rev-parse", "main"), files: ["shared.txt", "both.txt"] }]]),
  };
  const { result } = await quietly(() => landOne(ctx, { issue: "7", branch: "agent/issue-7", status: "green", commits: 1, repairs: 0, head: seven }));
  assert.deepEqual(result, { kind: "conflict", files: ["shared.txt"], with: ["3"] });
  assert.deepEqual(opened, []);
  assert.equal(existsSync(marker), false);
});

test("the landing merge's tree check runs no merge driver from the shared .git, and still tells a planted tree", () => {
  const { root, base, eight, landing, marker } = setup();
  // A driver that ran would have written its own both.txt, and the sandbox's true merge would look planted.
  assert.equal(plainMergeNote(root, landing, base, eight), undefined);
  assert.equal(existsSync(marker), false);
  git(root, "checkout", "-q", "landing");
  commit(root, { "both.txt": "planted\n" }, "planted");
  const planted = git(root, "rev-parse", "HEAD");
  assert.equal(plainMergeNote(root, planted, base, eight), "landing merge does not hold the tree the host's own merge makes");
  assert.equal(existsSync(marker), false);
});

test("a SHA-256 repository's conflict is still found", () => {
  const { root, base, seven, marker } = setup("sha256");
  assert.equal(base.length, 64);
  assert.deepEqual([...mergeTree(root, base, seven).conflicted], ["shared.txt"]);
  assert.equal(existsSync(marker), false);
});

test("the check writes nothing into the shared object store and leaves no temp directory behind", () => {
  const { root, base, eight } = setup();
  const objects = () => git(root, "count-objects", "-v");
  const temps = () => readdirSync(tmpdir()).filter((f) => f.startsWith("sandcastle-merge-"));
  const before = { objects: objects(), temps: temps() };
  mergeTree(root, base, eight);
  assert.equal(objects(), before.objects);
  assert.deepEqual(temps(), before.temps);
});

test("every host merge-tree in src/ runs through the throwaway git directory's runner", () => {
  for (const file of readdirSync("src").filter((f) => f.endsWith(".ts"))) {
    for (const line of readFileSync(join("src", file), "utf8").split("\n")) {
      if (line.includes('"merge-tree"')) assert.match(line, /\bgit\(\["merge-tree"/, `${file}: ${line.trim()}`);
    }
  }
  // The pipeline's check before review and gates is `mergeTree`'s caller, not a git call of its own.
  const burndown = readFileSync(join("src", "burndown.ts"), "utf8");
  assert.match(burndown, /const conflictBefore = [\s\S]*?\[\.\.\.mergeTree\(project\.root, /);
});

test("a project whose path holds a colon or a quote still has its conflict found", () => {
  // GIT_ALTERNATE_OBJECT_DIRECTORIES is a colon-separated list: unquoted, `a:b` names two stores that do not exist.
  for (const name of ['with:colon', 'with"quote\\slash']) {
    const { root, base, seven } = setup();
    const moved = join(tmp, `${name}${n++}`);
    renameSync(root, moved);
    assert.deepEqual([...mergeTree(moved, base, seven).conflicted], ["shared.txt"], name);
  }
});

test("a merge-tree that exits 1 with no tree id is no answer, not a clean merge", () => {
  const { root, base, seven } = setup();
  // Git exits 1 for a merge it could not start too ("not something we can merge"), with nothing on stdout.
  const bin = mkdtempSync(join(tmp, "bin-"));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = merge-tree ]; then echo "fatal: not something we can merge" >&2; exit 1; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    assert.throws(() => mergeTree(root, base, seven), /no tree/);
  } finally {
    process.env.PATH = path;
  }
});

test("a committed merge=union file merges in the throwaway directory as in the project", () => {
  // Two tickets each add a changelog line: git's union driver merges them, and the throwaway directory, which has no work
  // tree to read `.gitattributes` from, read none and called it a conflict before review and at landing.
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  commit(root, { ".gitattributes": "CHANGES.md merge=union\n", "CHANGES.md": "# Changes\n" }, "start");
  git(root, "checkout", "-q", "-b", "agent/issue-9");
  commit(root, { "CHANGES.md": "# Changes\n- nine\n" }, "work on 9");
  git(root, "checkout", "-q", "main");
  commit(root, { "CHANGES.md": "# Changes\n- three\n" }, "ticket 3 landed");
  const base = git(root, "rev-parse", "main");
  const nine = git(root, "rev-parse", "agent/issue-9");
  // GIT_ATTR_SOURCE is git 2.42's: an older git reads no attributes there, and the conflict stands.
  const [major, minor] = git(root, "--version").match(/(\d+)\.(\d+)/)!.slice(1).map(Number);
  const attrSource = major > 2 || (major === 2 && minor >= 42);
  assert.equal(spawnSync("git", ["merge-tree", "--write-tree", base, nine], { cwd: root }).status, 0, "the project's own merge is clean");
  assert.deepEqual([...mergeTree(root, base, nine).conflicted], attrSource ? [] : ["CHANGES.md"]);
});
