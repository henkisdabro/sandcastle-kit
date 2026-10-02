// The reviewer's <ungated> line: how it is read (ungatedOf), how the closing summary lists a
// merged ticket that carries one, and that the review prompt asks for it. No repo for most of it;
// no Docker, model or network.
//
//   pnpm exec tsx --test test/ungated.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Importing run.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { ungatedOf } = await import("../src/burndown.ts");
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { render } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

// The body of one section: the lines between its heading and the next.
const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("ungatedOf reads one tag, and the last of two", () => {
  assert.equal(ungatedOf("done.\n<ungated>open the page</ungated>\n"), "open the page");
  assert.equal(ungatedOf("<ungated>first</ungated> then <ungated>second</ungated>"), "second");
});

test("ungatedOf ignores the placeholder, an empty tag and no tag", () => {
  assert.equal(ungatedOf("<ungated>...</ungated>"), undefined);
  assert.equal(ungatedOf("<ungated>  </ungated>"), undefined);
  assert.equal(ungatedOf("nothing to flag"), undefined);
});

test("ungatedOf makes one line of a multi-line tag and cuts it to 200 characters", () => {
  assert.equal(ungatedOf("<ungated>open the page\n   and check\tpage 2</ungated>"), "open the page and check page 2");
  assert.equal(ungatedOf(`<ungated>${"x".repeat(500)}</ungated>`)?.length, 200);
});

test("a merged ticket with an ungated line is listed under Needs you, once, and counted", () => {
  const out = render(
    facts({
      tickets: {
        "3": { state: "merged", title: "Rebuild the PDFs", ungated: "open docs/guide.pdf and check page 2" },
        "4": { state: "merged", title: "b" },
      },
    }),
  );
  const needs = body(out, "## 🙋 Needs you");
  assert.ok(needs.split("\n").includes("- #3 Rebuild the PDFs - merged - check by hand: open docs/guide.pdf and check page 2"), needs);
  assert.ok(!needs.includes("#4"), needs);
  assert.match(out, / - 1 need you - /);
  const done = body(out, "## ✅ Done");
  assert.match(done, /2 merged and closed on GitHub: #3 #4/);
  assert.match(out, /Check #3 by hand: merged, but no gate exercises the change/);
});

test("a held ticket with an ungated line is listed once, as held", () => {
  const out = render(
    facts({
      tickets: { "3": { state: "held", title: "Rebuild the PDFs", files: ["a.txt"], ungated: "open docs/guide.pdf" } },
      changed: { "3": 1 },
    }),
  );
  const needs = body(out, "## 🙋 Needs you");
  assert.equal(needs.split("\n").filter((l) => l.startsWith("- ")).length, 1, needs);
  assert.ok(!needs.includes("check by hand"), needs);
  assert.match(out, / - 1 need you - /);
  assert.ok(!out.includes("Check #3 by hand"));
});

test("a merged ticket whose close failed and that has an ungated line counts once in the headline", () => {
  const out = render(
    facts({ tickets: { "3": { state: "merged", title: "a", closeFailed: "boom", ungated: "look" } } }),
  );
  assert.match(out, / - 1 need you - /);
});

test("the review prompt asks for the <ungated> line and gains no placeholder", (t) => {
  assert.ok(readFileSync(join(import.meta.dirname, "../prompts/review.md"), "utf8").includes("<ungated>...</ungated>"));
  const root = mkdtempSync(join(tmpdir(), "sandcastle-ungated-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project: Project = {
    root,
    name: "ungated-test",
    baseBranch: "main",
    label: "ready-for-agent",
    concurrency: 1,
    mounts: [],
    setup: [],
    lean: { keep: [], dropHooks: [] },
    gates: [{ name: "unit", command: "echo gate-ok" }],
    hookTests: [],
    implement: {},
    review: {},
    repair: {},
    tracker: { kind: "github", held: "ready-for-human", triage: "needs-triage", dir: "", done: [], source: "default" },
  };
  const paths = renderPrompts(project, makeTracker(project));
  for (const file of [paths.review, paths.rereview]) {
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("<ungated>...</ungated>"), file);
    assert.ok(!text.includes("{{KIT_"), file);
  }
});
