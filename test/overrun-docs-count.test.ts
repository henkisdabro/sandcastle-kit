// The overrun note folds the docs every change must edit into a count ("+2 docs files"), so the
// source files a ticket's Touches line missed stay readable, and the closing report separates the
// ticket's title from the note.
//
//   pnpm exec tsx --test test/overrun-docs-count.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { overrunLine, overrunPaths, render } = await import("../src/report.ts");
const { isDocPath } = await import("../src/touches.ts");

test("isDocPath: Markdown anywhere, and docs/ and skill/", () => {
  for (const p of ["README.md", "docs/architecture.md", "docs/img/a.svg", "skill/run.md", "skill/assets/x.json", "pkg/NOTES.md", "./docs/INSTALL.md"]) assert.ok(isDocPath(p), p);
  for (const p of ["src/run.ts", "src/docs.ts", "mydocs/a.ts", "bin/sandcastle"]) assert.ok(!isDocPath(p), p);
});

test("docs paths fold into a count after the source files", () => {
  assert.equal(
    overrunPaths(["src/ledger.ts", "README.md", "docs/architecture.md", "src/run.ts", "skill/update.md"]),
    "src/ledger.ts, src/run.ts, +3 docs files",
  );
});

test("one docs file is singular, and docs alone are still reported as a count", () => {
  assert.equal(overrunPaths(["src/a.ts", "docs/x.md"]), "src/a.ts, +1 docs file");
  assert.equal(overrunPaths(["README.md", "docs/y.md"]), "+2 docs files");
});

test("test files and docs fold side by side; a Markdown file under test/ counts as a test", () => {
  assert.equal(overrunPaths(["src/a.ts", "test/a.test.ts", "README.md", "test/notes.md"]), "src/a.ts, +2 test files, +1 docs file");
});

test("the close comment keeps its own wording", () => {
  assert.equal(overrunLine(["src/a.ts", "README.md"]), "changed beyond its Touches line: src/a.ts, +1 docs file");
});

test("the closing report separates the title from the note", () => {
  const facts = {
    base: "main", tracker: "github", started: "2026-10-02T10:00:00Z", finished: "2026-10-02T10:30:00Z", live: false, dryRun: false,
    gateCount: 1,
    tickets: { "241": { state: "merged", title: "nest a second store inside the host's", overrun: ["src/ledger.ts", "src/run.ts", "README.md", "skill/update.md"] } },
    runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, stage: "report", exitCode: 0,
  } as unknown as Parameters<typeof render>[0];
  const text = render(facts, true);
  assert.ok(text.includes("#241 nest a second store inside the host's - beyond Touches: src/ledger.ts, src/run.ts, +2 docs files"), text);
});
