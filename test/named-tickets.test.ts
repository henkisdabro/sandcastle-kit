// `ISSUES=...` (or `sandcastle run 12 15`): a closed or unknown ticket is refused as an operator
// error, so the CLI prints one line instead of a stack trace. A temp repo with ticket files; no
// Docker, no gh, no network.
//
//   pnpm exec tsx --test test/named-tickets.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { namedTickets } = await import("../src/burndown.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { OperatorError } = await import("../src/errors.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const root = mkdtempSync(join(tmpdir(), "sandcastle-named-tickets-"));
after(() => rmSync(root, { recursive: true, force: true }));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
mkdirSync(join(root, ".scratch/demo/issues"), { recursive: true });
writeFileSync(join(root, ".scratch/demo/issues/01-open.md"), "# Open\n\nStatus: ready-for-agent\n\nDo it.\n");
writeFileSync(join(root, ".scratch/demo/issues/02-done.md"), "# Done\n\nStatus: done\n\nDone.\n");
const project = {
  name: "demo",
  root,
  baseBranch: "main",
  tracker: fakeTracker({ kind: "files" }),
  label: "ready-for-agent",
} as unknown as Project;
const tracker = makeTracker(project);

test("an open ticket is returned", () => {
  assert.deepEqual(
    namedTickets(tracker, " demo-01 ").map((t) => t.id),
    ["demo-01"],
  );
});

test("a closed ticket is an operator error naming it", () => {
  assert.throws(
    () => namedTickets(tracker, "demo-01,demo-02"),
    (e: Error) => e instanceof OperatorError && /demo-02 is closed/.test(e.message),
  );
});

test("an unknown ticket is an operator error too", () => {
  assert.throws(
    () => namedTickets(tracker, "demo-09"),
    (e: Error) => e instanceof OperatorError && /No ticket demo-09/.test(e.message),
  );
});
