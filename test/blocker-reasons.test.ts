// Why a blocker holds its dependants, said out loud: closed as not planned (it is not done), open
// but held for a human or not queued (it will not close by itself), and a "Blocked by" line inside
// code (stripped on purpose, so a run does not wait - the author may think it does). A fake `gh`
// on PATH answers; no network.
//
//   pnpm test:file test/blocker-reasons.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { blockerProblems, blockerResolver, openBlockers } = await import("../src/blockers.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

// 10: closed as not planned, 11: open and held, 12: open and not queued, 13: closed as completed.
// `gh issue view` is logged, to count the lookups - but not the read of a ticket's native
// blockers (`--json number,blockedBy`), which is not a blocker's lookup.
const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-bin-"));
const log = join(bin, "views");
writeFileSync(
  join(bin, "gh"),
  `#!/bin/sh
case "$1" in
  api)
    case "$2" in
      */issues/10) echo "closed not_planned" ;;
      */issues/11|*/issues/12) echo "open " ;;
      */issues/13) echo "closed completed" ;;
      *) exit 1 ;;
    esac ;;
  issue)
    case "$*" in *"--json number,blockedBy") ;; *) echo "$3" >> "${log}" ;; esac
    labels='[]'
    [ "$3" = 11 ] && labels='[{"name":"needs-human"}]'
    echo "{\\"number\\":$3,\\"title\\":\\"t\\",\\"state\\":\\"OPEN\\",\\"body\\":\\"\\",\\"comments\\":[],\\"labels\\":$labels}" ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

const project = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
const tracker = makeTracker(project);
const queue = (...bodies: string[]) => bodies.map((body, i) => ({ id: String(i + 1), body }));

test("a blocker closed as not planned is open, not done; one closed as completed is done", async () => {
  const resolve = blockerResolver(project, tracker);
  assert.equal((await resolve({ kind: "github", id: "10" })).state, "closed-unmerged");
  assert.equal((await resolve({ kind: "github", id: "13" })).state, "closed");
  const held = await openBlockers(project, tracker, resolve, { id: "1", body: "Blocked by #10, #13" });
  assert.deepEqual(held.map((b) => b.id), ["10"]);
});

test("each way a blocker holds a ticket is named, with the fix", async () => {
  const lines = await blockerProblems(project, tracker, queue("Blocked by #10", "Blocked by #11", "Blocked by #12", "Blocked by #13"));
  assert.deepEqual(lines, [
    "#1 waits for #10, which was closed as not planned - it will never start. Remove the line, or reopen #10.",
    "#2 waits for #11, which is held for a human - it starts once #11 is closed.",
    "#3 waits for #12, which is open but not queued - queue #12 or remove the line.",
  ]);
});

test("a blocker in the queue is not reported, and a blocker is looked up once however many wait for it", async () => {
  writeFileSync(log, "");
  const lines = await blockerProblems(project, tracker, [{ id: "12", body: "" }, { id: "1", body: "Blocked by #12" }, { id: "2", body: "Blocked by #11" }, { id: "3", body: "Blocked by #11" }]);
  assert.deepEqual(lines, [
    "#2 waits for #11, which is held for a human - it starts once #11 is closed.",
    "#3 waits for #11, which is held for a human - it starts once #11 is closed.",
  ]);
  const views = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(views, ["11"]);
});

test("a blocker inside a fence or inline code is warned about; a plain one is not", async () => {
  const lines = await blockerProblems(
    project,
    tracker,
    queue("Intro\n\n```\nBlocked by #13\n```\n", "See `Blocked by #13` here", "Blocked by #13", "```\nBlocked by #13\n```\n\nBlocked by #13"),
  );
  assert.deepEqual(lines, [
    '#1 mentions "Blocked by #13" inside code, which a run does not read - write it as plain text if #1 should wait.',
    '#2 mentions "Blocked by #13" inside code, which a run does not read - write it as plain text if #2 should wait.',
  ]);
});
