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
const { INERT_ROOT_ENTRIES, protectedPathsNote, protectedRules } = await import("../src/guard.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-protected-prompt-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const project = (protectedPaths?: string[], unheldPaths?: string[]) =>
  ({ root: TMP, name: "fixture", label: "fixture", gates: [{ name: "test", command: "run-tests" }], protectedPaths, unheldPaths, tracker: fakeTracker() }) as unknown as Parameters<typeof renderPrompts>[0];

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

// The rule table is the one source: the prompt is rendered from it, and the two docs that list the protected paths
// are held to it, so an entry added to the table and not to the docs (or dropped from it) turns this red.
test("the prompt note, docs/safety.md and docs/architecture.md name every rule and inert root entry", () => {
  const p = project();
  const values = [...protectedRules(p).map((r) => r.value), ...INERT_ROOT_ENTRIES.map((r) => r.value)];
  const sources = {
    note: protectedPathsNote(p, "implement"),
    "docs/safety.md": readFileSync(join(import.meta.dirname, "../docs/safety.md"), "utf8"),
    "docs/architecture.md": readFileSync(join(import.meta.dirname, "../docs/architecture.md"), "utf8"),
  };
  for (const [name, text] of Object.entries(sources)) {
    assert.deepEqual(values.filter((v) => !text.includes(`\`${v}\``)), [], `${name} does not name these`);
  }
});

test("the note names the project's unheldPaths and the fixed entries they cannot release", () => {
  const note = protectedPathsNote(project(undefined, [".claude/skills/"]), "implement");
  assert.match(note, /`unheldPaths` lets these land all the same: `\.claude\/skills\/`; never a path under [^.]*`\.husky\/`.*`\.envrc`/);
  assert.doesNotMatch(protectedPathsNote(project(), "implement"), /lets these land/);
});
