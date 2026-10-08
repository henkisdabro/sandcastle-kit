// A held ticket merged by hand with the kit's subject, whose branch `sandcastle clean` then deleted:
// the report asked a person to review and merge a branch that is gone. With no ref to check, the merge's
// subject on the base is the proof (as the status view takes it); a branch gone with no such subject
// prints no merge command; and a hand merge that is already closed no longer says "closes on push".
// Throwaway repos, ticket files for the tracker; no gh, no Docker.
//
//   pnpm test:file test/hand-merged-branch-gone.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { gather, render } = await import("../src/report.ts");
const { mergedByHand } = await import("../src/run.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const started = "2026-10-01T08:00:00.000Z";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** shop-01 is held; its branch carried work and was deleted, after a merge with `subject` (none: never merged). */
const repo = (subject: string | undefined, status = "ready-for-human", outcome = "needs a human merge") => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-branch-gone-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  writeFileSync(join(root, ".scratch/shop/issues/01-a.md"), `# A\n\nStatus: ${status}\n\nDo it.\n\n## Comments\n`);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-q", "-b", "agent/issue-shop-01");
  writeFileSync(join(root, "work.txt"), "work\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the work");
  git(root, "checkout", "-q", "main");
  if (subject) git(root, "merge", "--no-ff", "-qm", subject, "agent/issue-shop-01");
  git(root, "branch", "-D", "agent/issue-shop-01");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/outcomes.json"), JSON.stringify({ "shop-01": { run: started, kind: "held", text: outcome } }));
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: "2026-10-01T09:00:00.000Z", exitCode: 0, stage: "report", tickets: { "shop-01": { state: "held", title: "A", note: "human merge: x.sh" } } }),
  );
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  return { root, project };
};

test("mergedByHand: a deleted branch counts when its merge subject is on the base", () => {
  assert.equal(mergedByHand(repo("Merge agent/issue-shop-01 (closes shop-01)").root, "main", "shop-01"), true);
  assert.equal(mergedByHand(repo("Merge agent/issue-shop-01 (part of shop-01)").root, "main", "shop-01"), true);
  assert.equal(mergedByHand(repo(undefined).root, "main", "shop-01"), false);
  // Another ticket's subject, or the right words for a different ticket, prove nothing.
  assert.equal(mergedByHand(repo("Merge agent/issue-shop-02 (closes shop-02)").root, "main", "shop-01"), false);
  assert.equal(mergedByHand(repo("Merge agent/issue-shop-01").root, "main", "shop-01"), false);
});

test("report: a held ticket merged by hand and cleaned is done, with no merge command", async () => {
  const { project } = repo("Merge agent/issue-shop-01 (closes shop-01)");
  const out = render(await gather(project, () => undefined), true);
  assert.match(out, /^## Done\n.*merged by hand; closes on push: .*shop-01/ms);
  assert.match(out, /0 need you/);
  assert.doesNotMatch(out, /git merge --no-ff/);
  assert.doesNotMatch(out, /Review and merge/);
});

test("report: a deleted branch with no merge on the base prints no merge command, and still needs you", async () => {
  const { project } = repo(undefined);
  const out = render(await gather(project, () => undefined), true);
  assert.match(out, /1 need you/);
  assert.match(out, /shop-01 .*its branch agent\/issue-shop-01 is gone and no merge of it is on main/);
  assert.doesNotMatch(out, /git merge --no-ff/);
  assert.doesNotMatch(out, /Review and merge/);
  assert.doesNotMatch(out, /merged by hand/);
});

test("report: a hand merge whose ticket is already closed drops \"closes on push\"", async () => {
  const { project } = repo("Merge agent/issue-shop-01 (closes shop-01)", "done");
  const out = render(await gather(project, () => undefined), true);
  assert.match(out, /merged by hand, and closed: .*shop-01/);
  assert.doesNotMatch(out, /closes on push/);
});

test("report: a handed-back ticket whose empty branch was cleaned still asks for the agent's comment to be read", async () => {
  const { project } = repo(undefined, "ready-for-human", "needs a human: handed back");
  const out = render(await gather(project, () => undefined), true);
  assert.match(out, /shop-01 .*no commits - read the agent's comment/);
  assert.doesNotMatch(out, /is gone and no merge of it/);
  assert.doesNotMatch(out, /git merge --no-ff/);
});
