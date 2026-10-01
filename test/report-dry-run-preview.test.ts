// A dry run gates each green branch on its own, so "would merge" for several says nothing about
// whether they merge together; the summary points at `sandcastle preview`, which checks that.
//
//   pnpm exec tsx --test test/report-dry-run-preview.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

const facts = (ids: string[]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:45:00.000Z",
  live: false,
  dryRun: true,
  verify: null,
  gateCount: 2,
  tickets: Object.fromEntries(ids.map((id) => [id, { state: "ready", title: `t${id}` }])),
  runnable: [],
  blocked: [],
  standing: ids.map((id) => `agent/issue-${id}`),
  keptWorktrees: [],
  changed: {},
});

test("several green branches in a dry run point at preview", () => {
  assert.match(render(facts(["50", "51"]), true), /would merge: #50 #51\. Nothing was merged or closed\. Each was gated on its own: `sandcastle preview` shows which would conflict/);
});

test("one green branch needs no preview", () => {
  assert.doesNotMatch(render(facts(["50"]), true), /sandcastle preview/);
});
