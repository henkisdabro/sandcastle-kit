// The base image refresh: `--pull` only when asked, and doctor's age warning. No Docker; dates are
// parsed and subtracted in TypeScript, so macOS and Linux (and any timezone) give the same answer.
//
//   pnpm test:file test/image-refresh.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { staleImageWarning } from "../src/doctor.ts";
import { buildArgs } from "../src/sandbox.ts";

const now = new Date("2026-10-01T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

test("buildArgs adds --pull only when asked", () => {
  assert.ok(!buildArgs("t:1", {}, false).includes("--pull"));
  assert.ok(buildArgs("t:1", {}, true).includes("--pull"));
});

test("buildArgs keeps the tag, build args and the stdin Dockerfile", () => {
  assert.deepEqual(buildArgs("t:1", { A: "1" }, true), ["build", "--pull", "-t", "t:1", "--label", "sandcastle-kit=1", "--build-arg", "A=1", "-"]);
  assert.deepEqual(buildArgs("t:1", { A: "1" }, false), ["build", "-t", "t:1", "--label", "sandcastle-kit=1", "--build-arg", "A=1", "-"]);
});

test("staleImageWarning is silent at 29 days", () => {
  assert.equal(staleImageWarning(ago(29), now), undefined);
});

test("staleImageWarning names sandcastle build --force at 31 days", () => {
  const w = staleImageWarning(ago(31), now, "sandcastle-base:abc");
  assert.ok(w?.includes("sandcastle build --force"));
  assert.ok(w?.includes("sandcastle-base:abc was built 31 days ago"));
});

test("staleImageWarning reads Docker's nanosecond RFC 3339 date", () => {
  assert.ok(staleImageWarning("2026-08-01T10:20:30.123456789Z", now));
});

test("staleImageWarning is silent for a date that does not parse", () => {
  assert.equal(staleImageWarning("not a date", now), undefined);
  assert.equal(staleImageWarning("", now), undefined);
});
