// An `Upgrading:` changelog line: what an existing project must act on. The reader keeps it, a
// reviewer's full set carries it like any other line, the prompts say when one is needed, and the
// closing summary lists it apart from the ordinary lines. No Docker, model or network.
//
//   node --test test/changelog-upgrading.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { addChangelog, changelogOf } = await import("../src/burndown.ts");
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Facts = import("../src/report.ts").Facts;

const facts = (tickets: Facts["tickets"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: { "4": 1 },
});

test("the reader keeps an Upgrading line among the others, in order", () => {
  assert.deepEqual(
    changelogOf("<changelog>Changed: links show later</changelog>\n<changelog>Upgrading: run `sandcastle herdr configure` again</changelog>"),
    ["Changed: links show later", "Upgrading: run `sandcastle herdr configure` again"],
  );
});

test("a reviewer's set replaces the implementer's, its Upgrading line with it", () => {
  // The reviewer lifts the instruction the implementer folded into a Changed line: its set stands alone.
  const have = ["Changed: links show later, so run the herdr configure command again"];
  addChangelog(have, "<changelog>Changed: links show later</changelog>\n<changelog>Upgrading: run the herdr configure command again</changelog>");
  assert.deepEqual(have, ["Changed: links show later", "Upgrading: run the herdr configure command again"]);
  // A pass that gives none leaves the Upgrading line standing.
  addChangelog(have, "no tags here");
  assert.equal(have.length, 2);
});

test("the closing summary lists an Upgrading line apart from the changes, for merged tickets only", () => {
  const out = render(
    facts({
      "3": { state: "merged", title: "a", changelog: ["Changed: links show later", "Upgrading: run `sandcastle herdr configure` again"] },
      "4": { state: "held", title: "b", files: ["a"], changelog: ["Upgrading: held, so unlisted"] },
    }),
  );
  const lines = out.split("\n");
  const upgrading = lines.findIndex((l) => l.startsWith("Upgrading notes the agents suggested"));
  assert.ok(upgrading >= 0, out);
  assert.equal(lines[upgrading + 1], "  Upgrading: run `sandcastle herdr configure` again (#3)");
  assert.ok(lines.includes("  Changed: links show later (#3)"), out);
  assert.ok(!lines.slice(0, upgrading).some((l) => l.includes("Upgrading: run")), "not among the changes");
  assert.ok(!out.includes("held, so unlisted"), out);
});

test("with no Upgrading line the summary has no such block", () => {
  const out = render(facts({ "3": { state: "merged", title: "a", changelog: ["Fixed: a crash"] } }));
  assert.ok(out.includes("Fixed: a crash"));
  assert.ok(!out.includes("Upgrading notes"), out);
});

const project = (root: string): Project => ({
  root,
  name: "upgrading-test",
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
  changelog: true,
});

test("the implement and review prompts say when a change needs an Upgrading line, and the repair prompt says nothing of it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-upgrading-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = project(root);
  const paths = renderPrompts(p, makeTracker(p));
  for (const k of ["implement", "review"] as const) {
    const text = readFileSync(paths[k], "utf8");
    assert.match(text, /`Upgrading:`/, k);
    assert.match(text, /existing project must act on/, k);
    assert.match(text, /in their words/, k);
  }
  assert.match(readFileSync(paths.review, "utf8"), /give the full set with one in it/);
  assert.ok(!readFileSync(paths.repair, "utf8").includes("Upgrading:"));
});
