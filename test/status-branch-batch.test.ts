// The status view's git collector asks about every branch at once: one `for-each-ref` for the tips, the
// commits over the base and which are on it, and one `rev-parse` and one `diff-tree` for the lines each
// adds and removes. Its facts are what `git rev-list --count` and `git diff --numstat base...branch`
// say branch by branch - for a rename, a binary file, two merge bases, no merge base, no net change and
// two branches on one tip - and a git older than 2.41 (no `%(ahead-behind)`) gets the same facts. A
// temp repository; no Docker, no network.
//
//   pnpm test:file test/status-branch-batch.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-branch-batch-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
after(() => rmSync(TMP, { recursive: true, force: true }));
const { readGit } = await import("../src/status-snapshot.ts");
type RecordPart = Parameters<typeof readGit>[2];

const REPO = join(TMP, "repo");
mkdirSync(join(REPO, ".sandcastle"), { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = (file: string, text: string, message = file) => {
  writeFileSync(join(REPO, file), text);
  git("add", "-A");
  git("commit", "-q", "-m", message);
};
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join("");

git("init", "-q", "-b", "main");
commit("long.txt", lines(60));
commit("a.txt", "a\n");
// 1: a rename with an edit, and a binary file, from a base that has moved on since.
git("checkout", "-q", "-b", "agent/issue-1");
git("mv", "long.txt", "moved.txt");
writeFileSync(join(REPO, "moved.txt"), lines(60) + "one more\n");
writeFileSync(join(REPO, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
git("add", "-A");
git("commit", "-q", "-m", "rename");
// 7: the same tip as 1.
git("branch", "agent/issue-7");
// 5: two commits that leave nothing changed.
git("checkout", "-q", "-b", "agent/issue-5", "main");
commit("tmp.txt", "x\n");
git("rm", "-q", "tmp.txt");
git("commit", "-q", "-m", "undo");
// 2: a criss-cross with main, so the two have two merge bases.
git("checkout", "-q", "-b", "agent/issue-2", "main");
commit("b.txt", lines(30));
git("checkout", "-q", "main");
commit("c.txt", "c\n");
git("checkout", "-q", "-b", "side", "main");
git("merge", "-q", "--no-edit", "agent/issue-2");
git("checkout", "-q", "agent/issue-2");
git("merge", "-q", "--no-edit", "main");
commit("d.txt", lines(3));
git("checkout", "-q", "main");
git("merge", "-q", "--no-edit", "side");
// 4: merged into main.
git("checkout", "-q", "-b", "agent/issue-4", "main~1");
git("checkout", "-q", "main");
// 3: no history in common with main.
git("checkout", "-q", "--orphan", "agent/issue-3");
git("rm", "-q", "-rf", ".");
commit("lone.txt", "lone\n");
git("checkout", "-q", "main");
commit("e.txt", "e\n");

const IDS = ["1", "2", "3", "4", "5", "6", "7"];
const part = { live: true, tickets: Object.fromEntries(IDS.map((id) => [id, {}])), logs: [] } as unknown as RecordPart;
const read = (env: NodeJS.ProcessEnv) => readGit(join(REPO, ".sandcastle"), { ...env, SANDCASTLE_BASE: "main" }, part, new AbortController().signal);

// What git says of each branch, asked one at a time as the collector used to.
const byHand = (id: string) => {
  const branch = `agent/issue-${id}`;
  try {
    git("rev-parse", "--verify", "--quiet", branch);
  } catch {
    return { exists: false };
  }
  const commits = Number(git("rev-list", "--count", `main..${branch}`).trim());
  let diff: { added: number; removed: number } | undefined;
  try {
    diff = { added: 0, removed: 0 };
    for (const m of git("diff", "--numstat", "--no-ext-diff", `main...${branch}`).matchAll(/^(\d+)\t(\d+)\t/gm)) [diff.added, diff.removed] = [diff.added + Number(m[1]), diff.removed + Number(m[2])];
  } catch {
    diff = undefined; // no merge base
  }
  return { exists: true, commits, diff };
};

test("each branch's commits and lines are what git says of it branch by branch", async () => {
  // The repo has what the test means: two merge bases for 2, none for 3.
  assert.equal(git("merge-base", "--all", "main", "agent/issue-2").trim().split("\n").length, 2);
  assert.throws(() => git("merge-base", "main", "agent/issue-3"));
  const { branches } = await read(process.env);
  for (const id of IDS) {
    const fact = branches[id]!;
    const want = byHand(id);
    assert.equal(fact.exists, want.exists, `#${id} exists`);
    if (!want.exists) continue;
    assert.equal(fact.commits, want.commits, `#${id} commits`);
    assert.deepEqual(fact.diff, want.commits === 0 ? { added: 0, removed: 0 } : want.diff, `#${id} diff`);
    assert.equal(fact.onBase, want.commits === 0, `#${id} on the base`);
  }
  assert.deepEqual(branches["1"]!.diff, { added: 1, removed: 0 }, "a rename counts its edit, not the whole file");
  assert.deepEqual(branches["5"]!.diff, { added: 0, removed: 0 });
  assert.equal(branches["3"]!.diff, undefined);
});

test("a git without %(ahead-behind) gets the same facts, asked branch by branch", async () => {
  const bin = join(TMP, "old-git");
  const asked = join(TMP, "old-git.log");
  mkdirSync(bin);
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\necho "$*" >> '${asked}'\ncase "$*" in *'%(ahead-behind'*) echo "fatal: unknown field name: ahead-behind:main" >&2; exit 128;; esac\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const now = await read(process.env);
  const old = await read({ ...process.env, PATH: [bin, process.env.PATH ?? ""].join(delimiter) });
  assert.deepEqual(old, now);
  const calls = readFileSync(asked, "utf8");
  assert.match(calls, /ahead-behind/);
  assert.match(calls, /^rev-list --count main\.\.agent\/issue-1$/m, "the older git counts each branch's commits itself");
});
