// `sandcastle requeue`: the note, the queue label, needs-human off - on GitHub (a fake `gh`
// first on PATH logs its calls) and on ticket files (a temp git repo) - and forgetting a
// recorded green head. No Docker, no model calls, no network.
//
//   pnpm exec tsx --test test/requeue.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { makeTracker, requeueTicket } = await import("../src/tracker.ts");
const { forgetHead, readHeads } = await import("../src/run.ts");

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
const log = join(dir, "calls.log");
// A plain sh script with printf: the same on macOS's /bin/sh and Linux's dash.
// FAKE_GH_ISSUE picks what `issue view` prints.
const gh = join(dir, "gh");
writeFileSync(
  gh,
  `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1 $2" = "issue view" ]; then
  case "$FAKE_GH_ISSUE" in
    held) printf '{"number":5,"title":"T","state":"OPEN","body":"","comments":[],"labels":[{"name":"needs-human"}]}\\n' ;;
    queued) printf '{"number":5,"title":"T","state":"OPEN","body":"","comments":[],"labels":[{"name":"ready-for-agent"}]}\\n' ;;
    closed) printf '{"number":5,"title":"T","state":"CLOSED","body":"","comments":[],"labels":[]}\\n' ;;
    *) printf '{"number":5,"title":"T","state":"OPEN","body":"","comments":[],"labels":[]}\\n' ;;
  esac
fi
exit 0
`,
);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const ghProject = { root: dir, label: "ready-for-agent", tracker: { kind: "github" } } as any;
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const writes = () => calls().filter((c) => /^issue (comment|edit)/.test(c));
const as = (issue: string) => {
  writeFileSync(log, "");
  process.env.FAKE_GH_ISSUE = issue;
  return makeTracker(ghProject);
};

test("GitHub, held, with a note: the note first, then the label swap", () => {
  const out = requeueTicket(as("held"), "ready-for-agent", ["5", "--note", "Use the blue."]);
  const w = writes();
  // The comment body spans lines in the log; its first line is the marker.
  assert.deepEqual(w, ["issue comment 5 --body Note for the next run, from `sandcastle requeue`:", "issue edit 5 --add-label ready-for-agent --remove-label needs-human"]);
  assert.equal(out, "#5 is back in the queue (ready-for-agent), needs-human removed, with your note.");
});

test("GitHub, not held, no note: one edit, no --remove-label, no comment", () => {
  const out = requeueTicket(as("plain"), "ready-for-agent", ["5"]);
  assert.deepEqual(writes(), ["issue edit 5 --add-label ready-for-agent"]);
  assert.equal(out, "#5 is back in the queue (ready-for-agent).");
});

test("GitHub, still queued: only the note, or nothing at all", () => {
  const out = requeueTicket(as("queued"), "ready-for-agent", ["5", "--note", "More."]);
  assert.equal(writes().length, 1);
  assert.match(writes()[0], /^issue comment 5/);
  assert.match(out, /still in the queue; added your note/);
  assert.match(requeueTicket(as("queued"), "ready-for-agent", ["5"]), /nothing to change/);
  assert.deepEqual(writes(), []);
});

test("GitHub, closed: refused with no write", () => {
  assert.throws(() => requeueTicket(as("closed"), "ready-for-agent", ["5", "--note", "x"]), /#5 is closed/);
  assert.deepEqual(writes(), []);
});

test("usage errors, and a leading # is dropped", () => {
  for (const args of [[], ["--note"], ["5", "--note"]]) assert.throws(() => requeueTicket(as("plain"), "ready-for-agent", args), /Usage: sandcastle requeue/);
  requeueTicket(as("plain"), "ready-for-agent", ["#5"]);
  assert.deepEqual(writes(), ["issue edit 5 --add-label ready-for-agent"]);
});

test("ticket files: status, comment, commit subject, clean tree, queued, reopenedSince", () => {
  const repo = mkdtempSync(join(tmpdir(), "sandcastle-files-"));
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  mkdirSync(join(repo, ".scratch/demo/issues"), { recursive: true });
  writeFileSync(join(repo, ".scratch/demo/issues/04-pick.md"), "# Pick the colour\n\nStatus: needs-human\n\nChoose one.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "ticket");
  const project = { root: repo, label: "ready-for-agent", tracker: { kind: "files", dir: ".scratch", done: ["done"] } } as any;
  const tracker = makeTracker(project);
  const before = Date.now() - 2000;
  assert.match(requeueTicket(tracker, "ready-for-agent", ["demo-04", "--note", "Use the blue."]), /demo-04 is back in the queue \(ready-for-agent\), needs-human removed, with your note\./);
  const text = readFileSync(join(repo, ".scratch/demo/issues/04-pick.md"), "utf8");
  assert.match(text, /Status: ready-for-agent/);
  assert.match(text, /## Comments[\s\S]*Use the blue\./);
  assert.equal(git("log", "-1", "--format=%s"), "requeue demo-04 (sandcastle requeue)");
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(tracker.queued().map((t) => t.id), ["demo-04"]);
  assert.equal(tracker.reopenedSince("demo-04", before), true);
  const head = git("rev-parse", "HEAD");
  assert.match(requeueTicket(makeTracker(project), "ready-for-agent", ["demo-04"]), /nothing to change/);
  assert.equal(git("rev-parse", "HEAD"), head);
});

test("forgetHead: drops one entry and leaves the rest; no file, no error and none created", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-heads-"));
  assert.equal(forgetHead(root, "5"), false);
  assert.equal(existsSync(join(root, ".sandcastle/logs/heads.json")), false);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const entry = (b: string) => ({ branch: b, green: "abc", run: "r", at: "t" });
  writeFileSync(join(root, ".sandcastle/logs/heads.json"), JSON.stringify({ 5: entry("agent/issue-5"), 6: entry("agent/issue-6") }));
  assert.equal(forgetHead(root, "5"), true);
  assert.deepEqual(readHeads(root), { 6: entry("agent/issue-6") });
  assert.equal(forgetHead(root, "5"), false);
});
