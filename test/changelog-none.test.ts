// `<changelog>none</changelog>` (or `n/a`, any case, a full stop allowed) is the agents' answer for a change
// nobody outside the code would notice: it is never a changelog line, a pass that gives only that leaves the
// earlier set standing, and a ticket left with no line because an agent said none is recorded
// `changelogNone`, which `report --changelog` lists apart from the tickets with no suggested line. The pipeline
// through test/base-red-harness.ts and the report over made-up history in a temp git repo; no Docker, model or
// network.
//
//   pnpm test:file test/changelog-none.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GREEN, commit, harness } from "./base-red-harness.ts";

process.env.XDG_CONFIG_HOME ??= mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { addChangelog, changelogOf, changelogRead } = await import("../src/burndown.ts");
const { readHeads, renderPrompts } = await import("../src/run.ts");
const { changelogSince } = await import("../src/report.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const tag = (...lines: string[]) => lines.map((l) => `<changelog>${l}</changelog>`).join("\n");

test("none or n/a alone in a tag is no line, in any case, with or without a full stop", () => {
  for (const said of ["none", "None", "NONE", "none.", "None.", "n/a", "N/A", "n/a.", "  none  "]) {
    assert.deepEqual(changelogRead(tag(said)), { lines: [], dropped: 0, none: true }, JSON.stringify(said));
    assert.deepEqual(changelogOf(tag(said)), []);
  }
});

test("none among real lines is dropped and the real lines stand; a line that merely starts with none is a line", () => {
  assert.deepEqual(changelogRead(tag("Fixed: a", "none")).lines, ["Fixed: a"]);
  assert.deepEqual(changelogOf(tag("None of the keys changed")), ["None of the keys changed"]);
  assert.equal(changelogRead(tag("Fixed: none of the keys")).none, undefined);
  assert.deepEqual(changelogRead("no tags here"), { lines: [], dropped: 0 });
});

test("a pass whose only tag says none leaves the earlier set standing, whatever kind of pass it is", () => {
  for (const narrow of [false, true]) {
    const lines: string[] = [];
    addChangelog(lines, tag("Added: a key"));
    assert.equal(addChangelog(lines, tag("none"), narrow), 0);
    assert.deepEqual(lines, ["Added: a key"]);
  }
});

test("the implement and review prompts name the exact form", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-none-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = {
    root, name: "t", baseBranch: "main", label: "ready-for-agent", concurrency: 1, mounts: [], setup: [],
    lean: { keep: [], dropHooks: [] }, gates: [{ name: "unit", command: "true" }], hookTests: [], land: "merge" as const,
    generated: [], implement: {}, review: {}, repair: {}, tracker: fakeTracker(), changelog: true,
  };
  const paths = renderPrompts(p, makeTracker(p));
  const texts = Object.fromEntries(["implement", "review", "rereview", "remerge"].map((k) => [k, readFileSync((paths as Record<string, string>)[k], "utf8")]));
  for (const [kind, text] of Object.entries(texts)) assert.ok(text.includes("`<changelog>none</changelog>`"), `${kind} prompt names the exact form`);
});

test("a ticket whose agents all said none is recorded changelogNone in the outcome and the head record", async () => {
  const h = harness(() => [GREEN]);
  h.agents.impl = (_id, wt) => {
    commit(wt, "src/a.ts", "a\n");
    return "Done.\n<changelog>none</changelog>";
  };
  h.agents.review = () => "<changelog>None.</changelog>";
  const o = await h.attempt("7");
  assert.equal(o.status, "green");
  assert.equal(o.changelog, undefined, "none is no line");
  assert.equal(o.changelogNone, true);
  assert.equal(readHeads(h.root)["7"]?.changelogNone, true);
});

test("a reviewer's none does not replace the implementer's lines, and no changelogNone is recorded", async () => {
  const h = harness(() => [GREEN]);
  h.agents.impl = (_id, wt) => {
    commit(wt, "src/a.ts", "a\n");
    return tag("Added: a key");
  };
  h.agents.review = () => "<changelog>none</changelog>";
  const o = await h.attempt("7");
  assert.deepEqual(o.changelog, ["Added: a key"]);
  assert.equal(o.changelogNone, undefined);
  assert.equal(readHeads(h.root)["7"]?.changelogNone, undefined);
});

test("a ticket whose agents said nothing is not recorded as none", async () => {
  const h = harness(() => [GREEN]);
  const o = await h.attempt("7");
  assert.equal(o.changelogNone, undefined);
});

const git = (root: string, args: string[], date?: string) =>
  execFileSync("git", args, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) } });

test("report --changelog lists a ticket the agents said none for apart from one with no suggested line", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-none-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "release"], "2026-06-01T12:00:00Z");
  git(root, ["tag", "v1.0.0"]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const tickets = {
    "21": { state: "merged", title: "Quiet", changelogNone: true },
    "22": { state: "merged", title: "Silent" },
    "23": { state: "merged", title: "Loud", changelog: ["Fixed: a bug."] },
  };
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ startedAt: "2026-06-03T09:00:00Z", finishedAt: "2026-06-03T10:00:00Z", exitCode: 0, tickets }));
  const out = changelogSince({ root, baseBranch: "main", name: "fixture", changelog: true } as unknown as Project);
  const lines = out.split("\n");
  assert.ok(lines.includes("No entry needed (the agents said none):"), out);
  assert.equal(lines[lines.indexOf("No entry needed (the agents said none):") + 1], "  #21 Quiet");
  assert.equal(lines[lines.indexOf("No suggested line - write from the ticket:") + 1], "  #22 Silent");
  assert.doesNotMatch(out, /Changed: none/);
  assert.match(out, /^ {2}Fixed: a bug\. \(#23\)$/m);
});
