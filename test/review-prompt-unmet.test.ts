// The review prompt: it shows the ticket's comments as the implement prompt does, and the
// implementer's <unmet> line as a per-ticket argument that is empty when there is none, so the
// rendered prompt carries no placeholder text. Review, rereview and remerge all render review.md.
//
//   pnpm exec tsx --test test/review-prompt-unmet.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { implUnmetView } = await import("../src/burndown.ts");
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-review-unmet-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const project = () => ({ root: TMP, name: "fixture", label: "fixture", gates: [{ name: "test", command: "run-tests" }], tracker: fakeTracker() }) as unknown as Parameters<typeof renderPrompts>[0];

test("the review prompt shows the ticket's comments and takes the implementer's line as IMPL_UNMET", () => {
  const p = project();
  const paths = renderPrompts(p, makeTracker(p));
  for (const kind of ["review", "rereview", "remerge"] as const) {
    const text = readFileSync(paths[kind], "utf8");
    assert.match(text, /# Comments on the ticket/, kind);
    assert.ok(text.includes("{{IMPL_UNMET}}"), `${kind}: the placeholder is left for Sandcastle to fill`);
  }
  assert.ok(!readFileSync(paths.implement, "utf8").includes("{{IMPL_UNMET}}"));
});

test("implUnmetView is empty with no line, and names the line and the ask with one", () => {
  assert.equal(implUnmetView(undefined), "");
  const view = implUnmetView("The comment's scope is not done.");
  assert.match(view, /The comment's scope is not done\./);
  assert.match(view, /Finish it yourself, or restate it/);
  assert.ok(view.endsWith("\n\n"), "the next heading starts its own paragraph");
});
