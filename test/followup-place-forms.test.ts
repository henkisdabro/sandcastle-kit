// The forms a place takes in a follow-up of one source ticket (src/burndown.ts): a file named by its bare name
// (the base tree's only file of that name), a path the evidence names with no line, and any of the several
// files a finding names. A fake tracker that records what it is asked to create and comment on, and a temp git
// repo for the base-tree lookup; no Docker, model or network.
//
//   pnpm test:file test/followup-place-forms.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createFollowUpBook, fileFollowUps, namedOnBase } = await import("../src/burndown.ts");

const direct = async (fn: () => string) => fn();
const named = (title: string, evidence = "", from = "7", phase = "implement") => ({ title, evidence, from, phase });

const recording = () => {
  const made: string[] = [];
  const comments: { id: string; text: string }[] = [];
  return {
    made,
    comments,
    tracker: {
      ref: (id: string) => `#${id}`,
      create: (title: string) => String(made.push(title) + 100),
      comment: (id: string, text: string) => void comments.push({ id, text }),
    },
  };
};

const TREE = ["README.md", "src/net/client.ts"];
const SHARED = [...TREE, "src/db/client.ts"];
const lookup = (files: string[]) => {
  const exists = (path: string) => files.includes(path);
  const byName = (name: string) => {
    const hits = files.filter((f) => f.includes("/") && f.slice(f.lastIndexOf("/") + 1) === name);
    return hits.length === 1 ? hits[0] : undefined;
  };
  return { exists, named: byName };
};
const fileAll = async (followUps: ReturnType<typeof named>[], files = TREE) => {
  const { made, comments, tracker } = recording();
  const book = createFollowUpBook({ update: () => {} }, { tracker, dryRun: false, write: direct, ...lookup(files) });
  for (const f of followUps) book.push(f);
  await book.file();
  return { made, comments };
};
const direct2 = async (followUps: ReturnType<typeof named>[], files = TREE) => {
  const { made, comments, tracker } = recording();
  await fileFollowUps(tracker, followUps, { dryRun: false, write: direct, ...lookup(files) });
  return { made, comments };
};

const FULL = named("Retry count is never reset in src/net/client.ts:40", "the counter lives at module scope");
const BARE = named("client.ts never resets its retry count", "seen in review");

for (const [how, run] of [["fileFollowUps", direct2], ["the follow-up book", fileAll]] as const) {
  test(`${how}: a bare name that is the tree's only such file is the same place as its full path`, async () => {
    const { made, comments } = await run([FULL, BARE]);
    assert.deepEqual(made, [FULL.title]);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].id, "101");
    assert.match(comments[0].text, /client\.ts never resets its retry count/);
  });

  test(`${how}: a bare name two files share is no place, so the pair is filed twice`, async () => {
    const { made, comments } = await run([FULL, BARE], SHARED);
    assert.deepEqual(made, [FULL.title, BARE.title]);
    assert.deepEqual(comments, []);
  });

  test(`${how}: a path the evidence names with no line meets a title sharing two significant words`, async () => {
    const other = named("Retry count survives between requests", "src/net/client.ts keeps the count in a module variable");
    const { made, comments } = await run([FULL, other]);
    assert.deepEqual(made, [FULL.title]);
    assert.equal(comments.length, 1);
  });

  test(`${how}: a title naming another file first still meets a finding about the second`, async () => {
    const both = named("README.md and src/net/client.ts disagree on the retry count");
    const { made, comments } = await run([FULL, both]);
    assert.deepEqual(made, [FULL.title]);
    assert.equal(comments.length, 1);
  });

  test(`${how}: the same pairs from another source ticket are filed separately`, async () => {
    const pairs = [
      [FULL, BARE],
      [FULL, named("Retry count survives between requests", "src/net/client.ts keeps the count in a module variable")],
      [FULL, named("README.md and src/net/client.ts disagree on the retry count")],
    ];
    for (const [first, second] of pairs) {
      const { made, comments } = await run([first, { ...second, from: "8" }]);
      assert.equal(made.length, 2, second.title);
      assert.deepEqual(comments, []);
    }
  });

  test(`${how}: a bare name whose title shares one significant word with the other is filed separately`, async () => {
    const { made, comments } = await run([FULL, named("client.ts leaks a socket on retry")]);
    assert.equal(made.length, 2);
    assert.deepEqual(comments, []);
  });

  test(`${how}: a caller that gives no bare-name lookup resolves no bare name`, async () => {
    const { made, tracker } = recording();
    await fileFollowUps(tracker, [FULL, BARE], { dryRun: false, write: direct, exists: lookup(TREE).exists });
    assert.deepEqual(made, [FULL.title, BARE.title]);
  });
}

test("the base tree's lookup gives a unique bare name its path, and a shared name or a host none", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  for (const f of ["README.md", "src/net/client.ts", "src/net/retry.ts", "src/db/retry.ts"]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "x\n");
  }
  git("add", "-A");
  git("commit", "-q", "-m", "tree");
  const named = namedOnBase(root, "main");
  assert.equal(named("client.ts"), "src/net/client.ts");
  assert.equal(named("retry.ts"), undefined);
  assert.equal(named("missing.ts"), undefined);
  assert.equal(named("api.example.com"), undefined);
});

test("the run's follow-up book is given the base tree's bare-name lookup", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /createFollowUpBook\(run, \{[^}]*named: namedOnBase\(project\.root, project\.baseBranch\)/);
});
