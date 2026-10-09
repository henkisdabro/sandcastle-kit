// A tag the agents gave that was no changelog line: a full review that restates the set also resets the
// drop count (the implementer's message it replaces is no longer what the ticket carries), and a tag
// dropped for its length says it was too long, with its length, not that it was "not a changelog line".
// No Docker, model or network.
//
//   pnpm test:file test/changelog-drop.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { addChangelog, changelogScan, CHANGELOG_MAX } = await import("../src/burndown.ts");
const { render, changelogSince } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;
type Project = import("../src/config.ts").Project;

const tag = (...lines: string[]) => lines.map((l) => `<changelog>${l}</changelog>`).join("\n");
// 527 characters, as the ticket's implementer wrote.
const long = `Fixed: ${"x".repeat(520)}`;
const fresh = () => ({ count: 0, why: [] as string[] });

test("a full review that restates the set resets the drops the implementer's message had", () => {
  const lines: string[] = [];
  const drops = fresh();
  addChangelog(lines, tag(long, "Added: a key"), false, drops);
  assert.deepEqual(drops, { count: 1, why: ["too long (527 characters)"] });
  addChangelog(lines, tag("Added: a key", "Fixed: the long one, shortened"), false, drops);
  assert.deepEqual(lines, ["Added: a key", "Fixed: the long one, shortened"]);
  assert.deepEqual(drops, { count: 0, why: [] });
});

test("a full review's own drops are what the ticket carries after it", () => {
  const lines: string[] = [];
  const drops = fresh();
  addChangelog(lines, tag(long), false, drops);
  addChangelog(lines, tag("Added: a key", "Fixed: a commit 3f2a9c1d in it"), false, drops);
  assert.deepEqual(drops, { count: 1, why: ["holds a commit sha"] });
});

test("a narrow pass, or a review that gives no line, adds its drops to the earlier ones", () => {
  const lines: string[] = [];
  const drops = fresh();
  addChangelog(lines, tag("Added: a key", long), false, drops);
  addChangelog(lines, tag("Fixed: a commit 3f2a9c1d in it", "Fixed: a crash"), true, drops);
  addChangelog(lines, tag(long), false, drops);
  assert.deepEqual(lines, ["Added: a key", "Fixed: a crash"]);
  assert.deepEqual(drops, { count: 3, why: ["too long (527 characters)", "holds a commit sha", "too long (527 characters)"] });
});

test("each dropped tag is told by its reason, the length first", () => {
  const list = "<changelog>\n- Added: one\n- Fixed: two\n</changelog>";
  const scan = changelogScan(`${tag(long)}\n${list}\n${tag("Fixed: a commit 3f2a9c1d in it", "Added: fine")}`);
  assert.deepEqual(scan.why, ["too long (527 characters)", "spans list items", "holds a commit sha"]);
  assert.deepEqual(scan.lines, ["Added: fine"]);
  assert.equal(changelogScan(tag(`Fixed: ${"x".repeat(CHANGELOG_MAX - 7)}`)).why.length, 0, "a line at the limit stays");
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

test("the closing summary says a line was too long, with its length, and no ticket says it twice", () => {
  const out = render(
    facts({
      tickets: {
        "3": { state: "merged", title: "a", changelog: ["Fixed: kept"], changelogDropped: 1, changelogDroppedWhy: ["too long (527 characters)"] },
        "4": { state: "merged", title: "b", changelogDropped: 2 },
        "5": { state: "merged", title: "c", changelogDropped: 1, changelogDroppedWhy: ["holds a commit sha"] },
      },
    }),
  );
  assert.ok(out.includes("A suggested line for #3 was too long (527 characters): it is left out, so write that entry from the ticket."), out);
  assert.ok(!out.includes("#3 was not a changelog line"), out);
  assert.ok(out.includes("A suggested line for #4 was not a changelog line (2 of them): it is left out"), out);
  assert.ok(out.includes("A suggested line for #5 was not a changelog line (it holds a commit sha): it is left out"), out);
});

test("`report --changelog` words a length drop the same way", () => {
  const git = (root: string, args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_COMMITTER_DATE: "2026-06-01T12:00:00Z", GIT_AUTHOR_DATE: "2026-06-01T12:00:00Z" } });
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "release"]);
  git(root, ["tag", "v1.0.0"]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ startedAt: "2026-06-02T09:00:00Z", exitCode: 0, tickets: { "7": { state: "merged", title: "t", changelogDropped: 1, changelogDroppedWhy: ["too long (527 characters)"] } } }),
  );
  const out = changelogSince({ root, baseBranch: "main", name: "fixture", changelog: true } as unknown as Project);
  assert.match(out, /A suggested line for #7 was too long \(527 characters\): it is left out/);
  assert.doesNotMatch(out, /not a changelog line/);
});

test("the pipeline hands each pass's tags to the ticket's drops and records the reasons", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.ok(source.includes("addChangelog(changelog, text, narrow, drops);"));
  assert.ok(source.includes("changelogDroppedWhy: drops.why.length ? [...drops.why] : undefined,"));
});
