// A held branch that a person then merges by hand (the path the closing summary recommends) has an
// empty diff against the base, as an agent's hand-back does. It was read as "the agent committed
// nothing": the report told the person to do the work themselves and counted it under needs you, the
// status view still said "needs a human merge", and the queue said a dependant waits for a ticket
// held for a human. Only the held-work outcome tells the two apart, and only an ancestor check says
// the merge happened. Throwaway repos, ticket files for the tracker; no gh, no Docker.
//
//   pnpm test:file test/hand-merged.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { blockerProblems, blockerWhy } = await import("../src/blockers.ts");
const { gather, render } = await import("../src/report.ts");
const { mergedByHand } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const started = "2026-10-01T08:00:00.000Z";
const HELD = "needs a human merge";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const ticketFile = (title: string, status: string, head = "") => `# ${title}\n\nStatus: ${status}\n${head}\nDo it.\n\n## Comments\n`;

/**
 * shop-01 is held (its outcome says why), shop-02 waits for it. `how` is what became of shop-01's
 * branch: merged by hand, left unmerged, or handed back with no commits.
 */
const repo = (how: "merged" | "unmerged" | "handed back", id = "shop-01", heldText = HELD) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hand-merged-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  writeFileSync(join(root, ".scratch/shop/issues/01-a.md"), ticketFile("A", "ready-for-human"));
  writeFileSync(join(root, ".scratch/shop/issues/02-b.md"), ticketFile("B", "ready-for-agent", "Blocked by: 01"));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-q", "-b", `agent/issue-${id}`);
  git(root, "checkout", "-q", "main");
  if (how !== "handed back") {
    git(root, "checkout", "-q", `agent/issue-${id}`);
    writeFileSync(join(root, "work.txt"), "work\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "the work");
    git(root, "checkout", "-q", "main");
    if (how === "merged") git(root, "merge", "--no-ff", "-qm", `Merge agent/issue-${id}`, `agent/issue-${id}`);
  }
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const outcome = how === "handed back" ? { kind: "held", text: "needs a human: handed back" } : { kind: "held", text: heldText };
  writeFileSync(join(root, ".sandcastle/logs/outcomes.json"), JSON.stringify({ [id]: { run: started, ...outcome } }));
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  return { root, project, tracker: makeTracker(project) };
};

test("mergedByHand: only held work whose branch tip is on the base", () => {
  assert.equal(mergedByHand(repo("merged").root, "main", "shop-01"), true);
  assert.equal(mergedByHand(repo("unmerged").root, "main", "shop-01"), false);
  // Its branch is on the base too (cut from it, nothing added), but nothing was held for a merge.
  assert.equal(mergedByHand(repo("handed back").root, "main", "shop-01"), false);
  assert.equal(mergedByHand(repo("merged").root, "main", "shop-99"), false);
  // A conflict resolution the kit would not trust is held work too, with its own words.
  const resolution = "needs a human: the conflict resolution changed lines outside the conflict (a.ts)";
  assert.equal(mergedByHand(repo("merged", "shop-01", resolution).root, "main", "shop-01"), true);
  assert.equal(mergedByHand(repo("unmerged", "shop-01", resolution).root, "main", "shop-01"), false);
});

test("queue: a dependant waits for a blocker merged locally, which closes on push", async () => {
  const { project, tracker } = repo("merged");
  const queued = tracker.queued(false);
  assert.deepEqual(queued.map((t) => t.id), ["shop-02"]);
  const lines = await blockerProblems(project, tracker, queued);
  assert.deepEqual(lines, ["shop-02 waits for shop-01, which is merged locally and closes on push - it starts once shop-01 is closed."]);
  const b = { kind: "ticket" as const, id: "shop-01", state: "open" as const };
  assert.equal(blockerWhy(project, tracker)(b), "merged-by-hand");
});

test("queue: an unmerged or handed-back blocker is still held for a human", async () => {
  for (const how of ["unmerged", "handed back"] as const) {
    const { project, tracker } = repo(how);
    const lines = await blockerProblems(project, tracker, tracker.queued(false));
    assert.deepEqual(lines, ["shop-02 waits for shop-01, which is held for a human - it starts once shop-01 is closed."], how);
  }
});

const factsOf = async (how: "merged" | "unmerged" | "handed back") => {
  const { root, project } = repo(how);
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: "2026-10-01T09:00:00.000Z", exitCode: 0, stage: "report", tickets: { "shop-01": { state: "held", title: "A", note: "human merge: x.sh" } } }),
  );
  return gather(project, () => undefined);
};

test("report: a held ticket merged by hand is done, not needs you, and not told to be redone", async () => {
  const out = render(await factsOf("merged"), true);
  assert.match(out, /^## Done\n.*merged by hand; closes on push: .*shop-01/ms);
  assert.match(out, /0 need you/);
  assert.doesNotMatch(out, /do it yourself/);
  assert.doesNotMatch(out, /no commits/);
  assert.doesNotMatch(out, /Read the agent's comment/);
});

test("report: an unmerged held branch still needs a merge, and a hand-back still needs a reader", async () => {
  const unmerged = render(await factsOf("unmerged"), true);
  assert.match(unmerged, /1 need you/);
  assert.match(unmerged, /git merge --no-ff agent\/issue-shop-01/);
  assert.doesNotMatch(unmerged, /merged by hand/);
  const back = render(await factsOf("handed back"), true);
  assert.match(back, /1 need you/);
  assert.match(back, /no commits - read the agent's comment: do it yourself/);
  assert.doesNotMatch(back, /merged by hand/);
});

/** The status view's frame for the repo, as the shell test renders it. */
const statusOf = (root: string, ticket: string) => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-bin-"));
  writeFileSync(join(bin, "sandcastle"), "#!/usr/bin/env bash\necho '[]'\n");
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "sandcastle"), 0o755);
  chmodSync(join(bin, "docker"), 0o755);
  const r = spawnSync("bash", [join(import.meta.dirname, "../status.sh"), "0", "all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SANDCASTLE_PROJECT: root,
      SANDCASTLE_BIN: join(bin, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: "120",
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(bin, "cache"),
    },
  });
  const frame = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  return frame.split("\n").filter((l) => l.includes(ticket)).join("\n") || `(no row for ${ticket}) ${r.status}\n${frame}`;
};

test("status: a held branch merged by hand reads merged, and a hand-back or unmerged one stays held", () => {
  const resolution = "needs a human: resolution held";
  const cases = [
    ["merged", HELD, /merged .*merged by hand; closes on push/],
    ["merged", resolution, /merged .*merged by hand; closes on push/],
    ["unmerged", HELD, /held .*needs a human merge/],
    ["unmerged", resolution, /held .*resolution held/],
    ["handed back", HELD, /held .*handed back/],
  ] as const;
  for (const [how, text, want] of cases) {
    // A number for the id keeps the row's cell simple.
    const { root } = repo(how, "7", text);
    // A branch is a row once an agent log names it.
    writeFileSync(join(root, ".sandcastle/logs/agent-issue-7-impl-7.log"), "done\n");
    writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: started, exitCode: 0, tickets: {} }));
    const row = statusOf(root, "#7");
    assert.match(row, want, `${how}: ${row}`);
    if (how !== "merged") assert.doesNotMatch(row, /merged by hand/, how);
  }
});
