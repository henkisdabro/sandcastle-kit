// Blockers that hold a queued ticket for good, or let it start too soon, are reported with what
// to change: a blocker that does not exist, tickets that wait for each other, a Linear id whose key
// the config does not name (ignored), a configured one with no LINEAR_API_KEY, and a ticket file's
// "Blocked by: 01" written in a comment. Each of these was silent. Ticket files in a temp repo;
// no network.
//
//   node --test test/blocker-problems.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { blockerProblems, commentOnlyBlocks, commentBlockLine } = await import("../src/blockers.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const repo = (tickets: Record<string, string>, extra: object = {}) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-blockers-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  for (const [name, text] of Object.entries(tickets)) writeFileSync(join(root, ".scratch/shop/issues", name), text);
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "t"], { cwd: root });
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker({ kind: "files" }), ...extra } as unknown as Project;
  const tracker = makeTracker(project);
  return { project, tracker };
};
const ticket = (title: string, head = "", comments = "") => `# ${title}\n\nStatus: ready-for-agent\n${head}\nDo it.\n\n## Comments\n${comments}`;

test("a missing blocker, a cycle and an unconfigured Linear key are each named, with the fix", async () => {
  const { project, tracker } = repo({
    "01-a.md": ticket("A", "Blocked by: 02"),
    "02-b.md": ticket("B", "Blocked by: 01"),
    "03-c.md": ticket("C", "Blocked by: 09"),
    "04-d.md": ticket("D", "Blocked by ENG-42"),
    "05-e.md": ticket("E"),
  });
  const lines = await blockerProblems(project, tracker, tracker.queued(false));
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.ok(lines.includes('shop-03 waits for shop-09, which does not exist - it will never start. Fix the "Blocked by" line, or remove it.'), lines.join("\n"));
  assert.ok(lines.some((l) => /^shop-04 says "Blocked by ENG-42", but ENG is not in `blockers.linear`.*the line is ignored and a run starts the ticket/.test(l)), lines.join("\n"));
  assert.ok(lines.includes('shop-01, shop-02 wait for each other - none of them can ever start. Remove one "Blocked by" line.'), lines.join("\n"));
});

test("a configured Linear key with no LINEAR_API_KEY says the blocker cannot be read", async () => {
  const { project, tracker } = repo({ "01-a.md": ticket("A", "Blocked by ENG-42") }, { blockers: { linear: ["ENG"] } });
  const lines = await blockerProblems(project, tracker, tracker.queued(false));
  assert.deepEqual(lines, ["shop-01 waits for ENG-42, which could not be read from Linear (no LINEAR_API_KEY in ~/.config/sandcastle-kit/.env) - a blocker that cannot be read counts as open, so it waits."]);
});

test("a chain that ends is not a cycle, and a clean queue has nothing to say", async () => {
  const { project, tracker } = repo({ "01-a.md": ticket("A"), "02-b.md": ticket("B", "Blocked by: 01"), "03-c.md": ticket("C", "Blocked by: 02") });
  assert.deepEqual(await blockerProblems(project, tracker, tracker.queued(false)), []);
});

test("a ticket file's \"Blocked by: 01\" in a comment is found, as a run would not read it", async () => {
  const { project, tracker } = repo({ "01-a.md": ticket("A"), "02-b.md": ticket("B", "", "\n### 2026-10-01 - maintainer\nBlocked by: 01\n") });
  const found = await commentOnlyBlocks(project, tracker, tracker.open().map((t) => ({ ...t, queued: true })));
  assert.equal(found.length, 1);
  assert.match(commentBlockLine(found[0]), /^shop-02: a comment says blocked by shop-01 \(open\), but the body does not/);
});
