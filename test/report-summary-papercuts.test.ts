// Two closing-summary papercuts: the merge command printed for a held branch gives the kit's own merge
// subject (so the push closes the ticket and the kit finds the hand merge), and a red ticket, still queued,
// is listed under Runnable now. Ticket numbers, paths and names are made up.
//
//   pnpm test:file test/report-summary-papercuts.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@localhost" });
const { render } = await import("../src/report.ts");
const { landTicket } = await import("../src/land.ts");
const { recordHead } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Facts = import("../src/report.ts").Facts;
type Project = import("../src/config.ts").Project;

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "1M in / 10k out",
  verify: { green: true, line: "check=pass" },
  gateCount: 1,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("Needs you prints the merge command with the kit's merge subject, closing the ticket", () => {
  const out = render(facts({ tickets: { "31": { state: "held", title: "touch the hook", note: "protected", files: [".githooks/pre-push"] } }, changed: { "31": 2 } }));
  assert.ok(body(out, "## 🙋 Needs you").includes('merge: git merge --no-ff -m "Merge agent/issue-31 (closes #31)" agent/issue-31'), out);
});

test("Needs you words the merge command 'part of' for a ticket with an unmet criterion", () => {
  const out = render(facts({ tickets: { "32": { state: "held", title: "big", note: "protected", files: [".githooks/pre-push"], unmet: "the flag is not wired" } }, changed: { "32": 2 } }));
  assert.ok(body(out, "## 🙋 Needs you").includes('merge: git merge --no-ff -m "Merge agent/issue-32 (part of #32)" agent/issue-32'), out);
});

test("a ticket-files tracker's merge command carries its own ref, not a #", () => {
  const out = render(facts({ tracker: "files", tickets: { "shop-04": { state: "held", title: "touch the hook", note: "protected", files: [".githooks/pre-push"] } }, changed: { "shop-04": 1 } }));
  const needs = body(out, "## 🙋 Needs you");
  assert.ok(needs.includes('git merge --no-ff -m "Merge agent/issue-shop-04 (closes shop-04)" agent/issue-shop-04'), needs);
});

test("the earlier-held Next step line carries the closing merge subject", () => {
  const out = render(facts({ standing: ["agent/issue-7"], earlierHeld: { "agent/issue-7": "needs a human merge" } }));
  const next = body(out, "## 👉 Next step");
  assert.ok(next.includes('`git merge --no-ff -m "Merge agent/issue-7 (closes #7)" agent/issue-7`'), next);
});

test("several earlier-held branches get one merge command each, with their own ref", () => {
  const out = render(facts({ standing: ["agent/issue-7", "agent/issue-9"], earlierHeld: { "agent/issue-7": "held", "agent/issue-9": "held" } }));
  const next = body(out, "## 👉 Next step");
  assert.ok(next.includes('git merge --no-ff -m "Merge agent/issue-7 (closes #7)" agent/issue-7'), next);
  assert.ok(next.includes('git merge --no-ff -m "Merge agent/issue-9 (closes #9)" agent/issue-9'), next);
});

test("a red ticket, still queued, is listed under Runnable now", () => {
  const out = render(
    facts({
      tickets: {
        "41": { state: "red", title: "a", note: "check" },
        "42": { state: "merged", title: "b" },
      },
      runnable: ["43"],
    }),
  );
  const runnable = body(out, "## ▶️ Runnable now");
  assert.ok(runnable.includes("#41 (red - its branch resumes)"), runnable);
  assert.ok(runnable.includes("#43"), runnable);
  assert.ok(!runnable.includes("#42"), runnable);
});

// `sandcastle land` refuses a branch that changes how the repo executes, and says how to merge it by hand.
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};
const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

const protectedFixture = (unmet?: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-papercuts-"));
  const id = "demo-04";
  const branch = `agent/issue-${id}`;
  git(root, "init", "-q", "-b", "main");
  write(root, ".gitignore", ".sandcastle/\n");
  write(root, ".scratch/demo/issues/04-thing.md", "# A thing\n\nStatus: ready-for-agent\n\nDo it.\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", branch);
  write(root, ".github/workflows/x.yml", "name: x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  const head = git(root, "rev-parse", "HEAD").out;
  git(root, "checkout", "-q", "main");
  if (unmet) recordHead(root, id, { branch, green: head, unmet }, "2026-10-01T00:00:00.000Z");
  const project = {
    name: "demo",
    root,
    baseBranch: "main",
    tracker: fakeTracker({ kind: "files" }),
    label: "ready-for-agent",
    gates: [{ name: "check", command: "true" }],
    setup: [],
    generated: [],
  } as unknown as Project;
  const refuse = () =>
    landTicket(project, makeTracker(project), id, () => {
      throw new Error("prepare called");
    });
  return { refuse };
};

test("land's protected-path refusal prints the merge command with the closing subject", async () => {
  const f = protectedFixture();
  await assert.rejects(f.refuse(), (e: Error) => e.message.includes('`git merge --no-ff -m "Merge agent/issue-demo-04 (closes demo-04)" agent/issue-demo-04`'));
});

test("land's protected-path refusal says 'part of' where a criterion is recorded unmet", async () => {
  const f = protectedFixture("the flag is not wired");
  await assert.rejects(f.refuse(), (e: Error) => e.message.includes('-m "Merge agent/issue-demo-04 (part of demo-04)" agent/issue-demo-04'));
});
