// The report's "held, merged by hand" line named "closes on push" for a GitHub ticket that was pushed and
// closed (the adapter could not say it was closed), and for a "part of" merge, which a push never closes.
// A throwaway repo and a fake gh on PATH; no Docker, network or model calls.
//
//   pnpm test:file test/hand-merged-report-words.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const started = "2026-10-01T08:00:00.000Z";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A gh that answers `issue view <n> --json state` with `answer` (a JSON line), or fails when it is empty. */
const fakeGh = (answer: string) => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-fake-gh-"));
  writeFileSync(join(bin, "gh"), answer ? `#!/bin/sh\necho '${answer}'\n` : "#!/bin/sh\necho 'could not reach github' >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
};

/**
 * Ticket 7 is held and its branch was merged by hand with `subject`; the run record carries `unmet` on it.
 * `kind` picks the tracker: GitHub issues (the fake gh), or ticket files (`Status: done` when `closed`).
 */
const repo = (subject: string, kind: "github" | "files", closed = false, unmet?: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hand-words-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  writeFileSync(join(root, ".scratch/shop/issues/07-a.md"), `# A\n\nStatus: ${closed ? "done" : "ready-for-human"}\n\nDo it.\n\n## Comments\n`);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  writeFileSync(join(root, "work.txt"), "work\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "the work");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-qm", subject, "agent/issue-7");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/outcomes.json"), JSON.stringify({ "7": { run: started, kind: "held", text: "needs a human merge" } }));
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: "2026-10-01T09:00:00.000Z", exitCode: 0, stage: "report", tickets: { "7": { state: "held", title: "A", note: "human merge: x.sh", ...(unmet ? { unmet } : {}) } } }),
  );
  return { root, project: { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind }) } as unknown as Project };
};

const report = async (project: Project, gh: string) => {
  const path = process.env.PATH;
  process.env.PATH = `${fakeGh(gh)}${delimiter}${path}`;
  try {
    return render(await gather(project, () => undefined), true);
  } finally {
    process.env.PATH = path;
  }
};

test("report: a GitHub ticket merged by hand, pushed and closed, says merged by hand, and closed", async () => {
  const { project } = repo("Merge agent/issue-7 (closes #7)", "github");
  const out = await report(project, '{"state":"CLOSED"}');
  assert.match(out, /1 held, merged by hand, and closed: .*#7/);
  assert.doesNotMatch(out, /closes on push/);
});

test("report: a GitHub ticket merged by hand and still open keeps closes on push", async () => {
  const { project } = repo("Merge agent/issue-7 (closes #7)", "github");
  assert.match(await report(project, '{"state":"OPEN"}'), /1 held, merged by hand; closes on push: .*#7/);
});

test("report: a GitHub ticket whose state cannot be read keeps closes on push", async () => {
  const { project } = repo("Merge agent/issue-7 (closes #7)", "github");
  assert.match(await report(project, ""), /1 held, merged by hand; closes on push: .*#7/);
});

test("report: a part-of merge by hand stays open, and shows its unmet criterion", async () => {
  const { project } = repo("Merge agent/issue-7 (part of #7)", "github", false, "the export needs a second format");
  const out = await report(project, '{"state":"OPEN"}');
  assert.match(out, /1 held, merged by hand, partly done: stays open: .*#7/);
  assert.match(out, /#7 A - criterion unmet: the export needs a second format/);
  assert.doesNotMatch(out, /closes on push/);
});

test("report: a part-of merge by hand with ticket files and no recorded criterion is still not a closes on push", async () => {
  const { project } = repo("Merge agent/issue-7 (part of #7)", "files");
  const out = await report(project, '{"state":"OPEN"}');
  assert.match(out, /merged by hand, partly done: stays open/);
  assert.doesNotMatch(out, /closes on push/);
});

test("report: a part-of merge whose ticket was closed since reads closed", async () => {
  const { project } = repo("Merge agent/issue-7 (part of #7)", "github", false, "x");
  assert.match(await report(project, '{"state":"CLOSED"}'), /merged by hand, and closed: .*#7/);
});
