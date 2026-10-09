// A spec that carries the queue label beside its child tickets is run as one ticket: a queued
// ticket that a queued child names under `## Parent` gets a line saying to unqueue it. Plain text,
// no tracker call; ticket files in a temp repo and a GitHub-style project with made-up tickets.
//
//   pnpm test:file test/spec-parent.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { blockerProblems } = await import("../src/blockers.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;
type Tracker = import("../src/tracker.ts").Tracker;

const github = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker({ kind: "github" }) } as unknown as Project;
// Nothing here may reach the tracker: every method but the local `declaredBlockers` read throws.
const noCalls = new Proxy({}, {
  get: (_t, name) => () => {
    if (name === "declaredBlockers") return [];
    throw new Error(`tracker.${String(name)} called`);
  },
}) as unknown as Tracker;
const problems = (queued: { id: string; body?: string }[], project = github) => blockerProblems(project, noCalls, queued);
const WHOLE = "a run would implement the whole spec as one ticket";

test("a queued spec that queued children name under ## Parent is told to be unqueued", async () => {
  const lines = await problems([
    { id: "12", body: "Spec.\n" },
    { id: "14", body: "Build it.\n\n## Parent\n\n#12\n\n## What to build\nx" },
    { id: "15", body: "## Parent\n\nhttps://github.com/acme/shop/issues/12\n" },
  ]);
  assert.deepEqual(lines, [`#12 is the parent of #14, #15 - ${WHOLE}: unqueue #12`]);
});

test("a parent that is not queued gives no line", async () => {
  assert.deepEqual(await problems([{ id: "14", body: "## Parent\n\n#12\n" }]), []);
});

test("a ## Parent inside a code block gives no line", async () => {
  const lines = await problems([
    { id: "12", body: "Spec.\n" },
    { id: "14", body: "Example of the template:\n\n```md\n## Parent\n\n#12\n```\n" },
  ]);
  assert.deepEqual(lines, []);
});

test("a ref outside the ## Parent section is not a parent", async () => {
  const lines = await problems([
    { id: "12", body: "Spec.\n" },
    { id: "14", body: "See #12 for context.\n\n## Parent\n\n#99\n\n## Notes\n\n#12\n" },
  ]);
  assert.deepEqual(lines, []);
});

test("a ticket file names its parent by path", async () => {
  const files = { root: tmpdir(), name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const lines = await problems(
    [
      { id: "shop-01", body: "Status: ready-for-agent\n\nSpec.\n" },
      { id: "shop-02", body: "Status: ready-for-agent\n\n## Parent\n\n.scratch/shop/issues/01-spec.md\n" },
    ],
    files,
  );
  assert.deepEqual(lines, [`shop-01 is the parent of shop-02 - ${WHOLE}: unqueue shop-01`]);
});

test("the queue skill says a spec with child tickets is not queued, and that /to-spec labels its spec", () => {
  const queue = readFileSync(join(import.meta.dirname, "../skill/queue.md"), "utf8");
  assert.match(queue, /A spec split into child tickets is not queued itself/);
  assert.match(queue, /`\/to-spec` comes already labelled, so take the label off/);
});
