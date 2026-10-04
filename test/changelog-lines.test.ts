// `changelog: true`: the implement and review prompts ask for each changelog line in a
// <changelog> tag (and only then), changelogOf reads them, the config key is checked, and the
// closing summary lists the merged tickets' lines under Done, grouped Added / Changed / Fixed.
// No Docker, model or network.
//
//   pnpm exec tsx --test test/changelog-lines.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Importing run.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { addChangelog, changelogOf, changelogRead, CHANGELOG_MAX } = await import("../src/burndown.ts");
const { loadProject } = await import("../src/config.ts");
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
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

const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("changelogOf reads every tag, in order, one line each", () => {
  assert.deepEqual(changelogOf("<changelog>Fixed: a\n  b</changelog>\nand\n<changelog>Added: c</changelog>"), ["Fixed: a b", "Added: c"]);
});

test("changelogOf ignores the placeholder, an empty tag and no tag", () => {
  assert.deepEqual(changelogOf("<changelog>...</changelog>\n<changelog>  </changelog>\nnothing"), []);
});

test("a tag that is no changelog line is dropped and counted, never cut off", () => {
  const long = `<changelog>Fixed: ${"word ".repeat(300)}</changelog>`;
  const sha = "<changelog>Fixed: the reader, in commit 3f2a9c1d, takes the line</changelog>";
  const list = "<changelog>Fixed: the reader\n- takes the base's line\n- not the branch's</changelog>";
  const fine = "<changelog>Fixed: the reader takes the branch's line in version 1315 of the 7 gates.</changelog>";
  assert.deepEqual(changelogRead(long), { lines: [], dropped: 1 });
  assert.deepEqual(changelogRead(sha), { lines: [], dropped: 1 });
  assert.deepEqual(changelogRead(list), { lines: [], dropped: 1 });
  assert.deepEqual(changelogRead(`${long}\n${sha}\n${fine}\n<changelog>...</changelog>`), { lines: ["Fixed: the reader takes the branch's line in version 1315 of the 7 gates."], dropped: 2 });
  assert.ok(changelogOf(`<changelog>Fixed: ${"x".repeat(CHANGELOG_MAX - 7)}</changelog>`).length === 1, "a line at the limit stays");
  // A word that merely looks like a hash is no sha.
  assert.equal(changelogRead("<changelog>Fixed: a defaced label is kept</changelog>").dropped, 0);
});

test("a final message that names the tag in prose, then closes it, is not a line", () => {
  const message = ["Done: commit 0123abc.", "<changelog> tag reader now takes the last one", "", "- the typecheck and all tests pass (1315 pass, 0 fail)", "- it ignores fenced tags</changelog>"].join("\n");
  assert.deepEqual(changelogRead(message), { lines: [], dropped: 1 });
});

test("the closing summary lists merged tickets' lines under Done, grouped, with the ticket", () => {
  const out = render(
    facts({
      tickets: {
        "3": { state: "merged", title: "a", changelog: ["Fixed: the report drops a line", "Added: a `changelog` key"] },
        "4": { state: "merged", title: "b", changelog: ["Changed: help names the key", "Reworded the docs"] },
        "5": { state: "held", title: "c", files: ["a"], changelog: ["Added: never landed"] },
      },
      changed: { "5": 1 },
    }),
  );
  const done = body(out, "## ✅ Done").split("\n");
  const at = done.indexOf("Changelog lines the agents suggested:");
  assert.ok(at >= 0, done.join("\n"));
  assert.deepEqual(done.slice(at + 1, at + 5), [
    "  Added: a `changelog` key (#3)",
    "  Changed: help names the key (#4)",
    "  Changed: Reworded the docs (#4)",
    "  Fixed: the report drops a line (#3)",
  ]);
  assert.ok(!out.includes("never landed"), out);
});

test("a merged ticket whose suggested line was dropped says so, and a ticket that did not land says nothing", () => {
  const out = render(
    facts({
      tickets: {
        "3": { state: "merged", title: "a", changelog: ["Fixed: kept"], changelogDropped: 1 },
        "4": { state: "merged", title: "b", changelogDropped: 1 },
        "5": { state: "held", title: "c", files: ["a"], changelogDropped: 1 },
      },
      changed: { "5": 1 },
    }),
  );
  const done = body(out, "## ✅ Done");
  assert.match(done, /A suggested line for #3 was not a changelog line/);
  assert.match(done, /A suggested line for #4 was not a changelog line/);
  assert.ok(!done.includes("#5 was not"), done);
  assert.ok(!out.includes("…"), out);
});

test("with no lines recorded the summary has no changelog block", () => {
  assert.ok(!render(facts({ tickets: { "3": { state: "merged", title: "a" } } })).includes("Changelog lines"));
});

const project = (root: string, changelog?: boolean): Project => ({
  root,
  name: "changelog-test",
  baseBranch: "main",
  label: "ready-for-agent",
  concurrency: 1,
  mounts: [],
  setup: [],
  lean: { keep: [], dropHooks: [] },
  gates: [{ name: "unit", command: "echo gate-ok" }],
  hookTests: [],
  land: "merge",
  generated: [],
  implement: {},
  review: {},
  repair: {},
  tracker: fakeTracker(),
  ...(changelog === undefined ? {} : { changelog }),
});

test("the implement and review prompts ask for <changelog> lines only when the project says so", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const asked = (p: Project) => {
    const paths = renderPrompts(p, makeTracker(p));
    return Object.fromEntries(
      (["implement", "review", "rereview", "remerge", "repair", "resolve"] as const).map((k) => {
        const text = readFileSync(paths[k], "utf8");
        assert.ok(!text.includes("{{KIT_"), k);
        return [k, text.includes("<changelog>...</changelog>")];
      }),
    );
  };
  assert.deepEqual(asked(project(root)), { implement: false, review: false, rereview: false, remerge: false, repair: false, resolve: false });
  assert.deepEqual(asked(project(root, true)), { implement: true, review: true, rereview: true, remerge: true, repair: false, resolve: false });
});

test("without the key the implement prompt is the one with the ask taken out", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const render = (p: Project) => readFileSync(renderPrompts(p, makeTracker(p)).implement, "utf8");
  const on = render(project(root, true));
  const ask = on.slice(on.indexOf("**Changelog lines.**"), on.indexOf("The same gates"));
  assert.ok(ask.includes("<changelog>...</changelog>"));
  assert.equal(on.replace(ask, ""), render(project(root)));
});

test("`changelog` must be true or false", async (t) => {
  // A fresh directory per load: Node caches an imported config by its path.
  const load = (extra: string) => {
    const root = mkdtempSync(join(tmpdir(), "sc-config-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }], ${extra} };\n`);
    return loadProject(root);
  };
  assert.equal((await load("changelog: true")).changelog, true);
  await assert.rejects(load('changelog: "yes"'), /`changelog` must be true or false, not "yes"/);
});

test("the pipeline counts what it dropped and records the count", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /changelogDropped \+= addChangelog\(changelog, text\);/);
});
