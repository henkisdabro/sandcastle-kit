// The audit action clusters findings that touch the same files before it shows the filing list: one
// ticket per file cluster where three or more small findings share most files, and no order-only
// blocker line for overlap the run's landing already handles. Pins that step's place and content.
//
//   node --test test/skill-audit-clusters.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Normalise line endings so the test reads the same checked out on either platform.
const audit = readFileSync(join(root, "skill", "audit.md"), "utf8").replace(/\r\n/g, "\n");

// Top-level steps only: a digit run at the start of a line, then ". **".
const steps = [...audit.matchAll(/^(\d+)\. \*\*([^\n]*)/gm)].map((m) => ({
  n: Number(m[1]),
  at: m.index ?? 0,
  head: m[2] ?? "",
}));
const clusterStep = steps.find((s) => /^Cluster findings/.test(s.head));
const listStep = steps.find((s) => /^Show the filing list/.test(s.head));
const body = (i: number) => {
  const next = steps.find((s) => s.n === i + 1);
  return audit.slice(steps.find((s) => s.n === i)?.at ?? 0, next?.at ?? audit.length).replace(/\s+/g, " ");
};

test("the steps are numbered in order", () => {
  assert.deepEqual(steps.map((s) => s.n), steps.map((_, i) => i + 1));
});

test("a clustering step exists and comes right before the filing list", () => {
  assert.ok(clusterStep, "no clustering step");
  assert.ok(listStep, "no filing list step");
  assert.ok(clusterStep.at < listStep.at, "clustering is not before the filing list");
  assert.equal(clusterStep.n + 1, listStep.n);
});

test("the clustering step groups by touches and proposes one ticket per file cluster", () => {
  const flat = body(clusterStep?.n ?? 0);
  assert.ok(flat.includes("touches"));
  assert.ok(flat.includes("three or more"));
  assert.ok(flat.includes("one ticket per file cluster"));
});

test("it separates real dependencies from order-only overlap and writes no order-only blocker", () => {
  const flat = body(clusterStep?.n ?? 0);
  assert.ok(flat.includes("real dependencies"));
  assert.ok(flat.includes("order overlapping work"));
  assert.ok(flat.includes("Write no order-only blocker line"));
});

test("the filing list shows the clusters and still needs the user's yes", () => {
  const flat = body(listStep?.n ?? 0);
  assert.ok(flat.includes("cluster"));
  assert.ok(flat.includes("the user's yes before filing anything"));
});
