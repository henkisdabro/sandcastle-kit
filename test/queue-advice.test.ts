// The advice `sandcastle queue` gives a ticket's author must be advice they can follow: a
// `Touches:` glob that matches nothing is not told to "say it is new" (that changes nothing for a
// glob), blockers listed under a "Blocked by" heading are warned about by `blockerProblems` (so
// plain `queue`, `blockers` and a run's start say it, not only `--lint`), and the skill says a
// colon after `Blocked by` is read. Ticket files in a temp repo; no Docker, gh or network.
//
//   pnpm test:file test/queue-advice.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { lintQueue } = await import("../src/lint.ts");
const { blockerProblems } = await import("../src/blockers.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const GIT = ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const ticket = (title: string, head = "", prose = "Do it.") => `# ${title}\n\nStatus: ready-for-agent\n${head}\n${prose}\n\n## Comments\n`;

const repo = (tickets: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-advice-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  mkdirSync(join(root, "src"));
  for (const [name, text] of Object.entries(tickets)) writeFileSync(join(root, ".scratch/shop/issues", name), text);
  writeFileSync(join(root, "src/app.ts"), "export {};\n");
  execFileSync("git", [...GIT, "add", "-A"], { cwd: root });
  execFileSync("git", [...GIT, "commit", "-qm", "t"], { cwd: root });
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const tracker = makeTracker(project);
  return { project, tracker, queued: tracker.queued(false) };
};
const lint = async (tickets: Record<string, string>) => {
  const { project, tracker, queued } = repo(tickets);
  return (await lintQueue(project, tracker, queued)).join("\n");
};
const problems = async (tickets: Record<string, string>) => {
  const { project, tracker, queued } = repo(tickets);
  return blockerProblems(project, tracker, queued);
};

test("a Touches glob matching nothing gets glob advice, not 'say so under ## Fix'", async () => {
  const text = await lint({ "01-a.md": ticket("A", "Touches: src/app.ts, lib/**/*.ts") });
  assert.match(text, /shop-01's Touches globs match no file on main: lib\/\*\*\/\*\.ts - a glob orders nothing until files exist: name the new files themselves/);
  assert.ok(!/names paths not on main/.test(text), text);
  assert.ok(!/say so under ## Fix\) or typos/.test(text), text);
});

test("a plain missing path keeps its line, beside a glob's own", async () => {
  const text = await lint({ "01-a.md": ticket("A", "Touches: test/new.test.ts, lib/*.ts") });
  assert.match(text, /shop-01 names paths not on main: test\/new\.test\.ts - new files \(say so under ## Fix\) or typos\?/);
  assert.match(text, /Touches globs match no file on main: lib\/\*\.ts - /);
});

test("blockers under a Blocked by heading are a blockerProblems line", async () => {
  const lines = await problems({ "01-a.md": ticket("A"), "02-b.md": ticket("B", "", "## Blocked by\n\n- #1\n") });
  assert.deepEqual(lines, [`shop-02 lists its blockers under a "Blocked by" heading, which is not read: write them on the line itself ("Blocked by #12, #14")`]);
});

test("no heading line for a blocker on the line itself, or a heading inside a code block", async () => {
  const lines = await problems({ "01-a.md": ticket("A"), "02-b.md": ticket("B", "Blocked by: 01", "```\n## Blocked by\n- #1\n```") });
  assert.deepEqual(lines, []);
});

test("--lint prints the heading line once", async () => {
  const text = await lint({ "01-a.md": ticket("A"), "02-b.md": ticket("B", "", "## Blocked by\n\n- #1\n") });
  assert.equal(text.split("lists its blockers under").length - 1, 1, text);
});

test("the skill says a colon after Blocked by is read", () => {
  const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../skill/queue.md"), "utf8").replace(/\s+/g, " ");
  assert.match(skill, /a colon after `Blocked by` is read too: `Blocked by: #12, #14` works/);
});
