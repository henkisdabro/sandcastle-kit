// The agent's hand-back command (the GitHub tracker's BLOCKED wording): it must
// work in a repo that has no hold label (`ready-for-human`) yet, and must not ask for a
// label nothing creates - `gh issue edit` with an unknown label fails whole, yet
// still applies --remove-label, leaving the ticket with no labels at all.
//
//   node --test test/handback.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { makeTracker } from "../src/tracker.ts";
import { fakeTracker } from "./fixtures.ts";

// Building the tracker calls no `gh`.
const project: Project = {
  root: ".",
  name: "handback-test",
  baseBranch: "main",
  label: "ready-for-agent",
  concurrency: 1,
  mounts: [],
  setup: [],
  lean: { keep: [], dropHooks: [] },
  gates: [{ name: "noop", command: "true" }],
  hookTests: [],
  land: "merge",
  generated: [],
  implement: {},
  review: {},
  repair: {},
  tracker: fakeTracker(),
};

const blocked = makeTracker(project).words.BLOCKED;

test("the hand-back asks for no label that nothing creates", () => {
  assert.ok(!blocked.includes("agent-blocked"));
});

test("the hand-back adds the hold label and leaves the queue", () => {
  assert.ok(blocked.includes("--add-label ready-for-human"));
  assert.ok(blocked.includes("--remove-label {{KIT_LABEL}}"));
});

test("the hold label is created, without --force, before the issue is edited", () => {
  const create = blocked.indexOf("gh label create ready-for-human");
  const edit = blocked.indexOf("gh issue edit");
  assert.ok(create >= 0, "no label create line");
  assert.ok(create < edit, "label create must come before the edit");
  const line = blocked.slice(create, blocked.indexOf("\n", create));
  assert.ok(!line.includes("--force"));
  assert.match(line, /2>\/dev\/null \|\| true$/);
});
