// The implement and review prompts name the paths that hold a branch for a person (the defaults and the
// project's `protectedPaths`), so an agent does not make an edit the ticket did not need and cost the branch
// its automatic landing; the review is told to revert one. No model calls.
//
//   pnpm test:file test/prompt-protected-paths.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-protected-prompt-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const project = (protectedPaths?: string[]) =>
  ({ root: TMP, name: "fixture", label: "fixture", gates: [{ name: "test", command: "run-tests" }], protectedPaths, tracker: fakeTracker() }) as unknown as Parameters<typeof renderPrompts>[0];

test("the implement and review prompts list the default and the project's protected paths", () => {
  const p = project(["deploy/", "release.config."]);
  const paths = renderPrompts(p, makeTracker(p));
  for (const kind of ["implement", "review", "rereview", "remerge"] as const) {
    const text = readFileSync(paths[kind], "utf8");
    assert.match(text, /# Protected paths/, kind);
    for (const want of ["`pnpm-workspace.yaml`", "`.github/`", "`.husky/`", "`deploy/`", "`release.config.`", "`postinstall`"]) {
      assert.ok(text.includes(want), `${kind}: missing ${want}`);
    }
    assert.match(text, /holds the whole branch for a person to merge/, kind);
    assert.ok(!text.includes("{{KIT_"), kind);
  }
});

test("the implementer is told to change one only when the ticket needs it, the reviewer to revert an unneeded change", () => {
  const p = project();
  const paths = renderPrompts(p, makeTracker(p));
  assert.match(readFileSync(paths.implement, "utf8"), /Change one only when the ticket needs it/);
  assert.match(readFileSync(paths.review, "utf8"), /did not need that change, revert it/);
  assert.doesNotMatch(readFileSync(paths.implement, "utf8"), /revert it in a commit/);
});

test("a project with no protectedPaths still lists the defaults", () => {
  const p = project();
  const text = readFileSync(renderPrompts(p, makeTracker(p)).implement, "utf8");
  assert.ok(text.includes("`.githooks/`") && text.includes("`.sandcastle/`"));
});
