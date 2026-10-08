// A green branch's conflict resolution that the kit holds (the stray-path check) still reports what
// the branch carries: its real commit count and the gate results recorded at its green head, in the
// outcome the run record and the per-ticket line are written from. Temp git repo; no Docker, model
// or network. The pipeline's own hold is driven in test/pipeline.test.ts.
//
//   pnpm test:file test/held-resolution-facts.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { heldResolution } = await import("../src/burndown.ts");
const { describe } = await import("../src/ledger.ts");
const { gateLine } = await import("../src/gates.ts");
const { ownCommits } = await import("../src/sandbox.ts");
const { readHeads, recordHead } = await import("../src/run.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `add ${file}`);
};

test("a held resolution reports the branch's real commits and its recorded gates, not 0 and none", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-held-resolution-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  commit(dir, "a.txt");
  git(dir, "checkout", "-q", "-b", "agent/issue-9");
  commit(dir, "b.txt");
  commit(dir, "c.txt");
  recordHead(dir, "9", { branch: "agent/issue-9", green: git(dir, "rev-parse", "HEAD"), gates: [{ name: "typecheck", pass: true }, { name: "test", pass: true, ms: 1200 }] }, "run-1");

  const held = heldResolution("9", "agent/issue-9", "resolution changed a.txt", {
    commits: ownCommits("main", "agent/issue-9", dir),
    reviewCommits: 0,
    gates: readHeads(dir)["9"]?.gates ?? [],
  });
  assert.equal(held.status, "held");
  assert.equal(held.commits, 2);
  assert.equal(gateLine(held.gates), "typecheck=pass test=pass");

  // The run record's commit count and the ticket's state come from this outcome, as any pipeline's do.
  const said = describe({ kind: "pipeline", outcome: held, attempts: 1 }, { base: "main", gateNames: "typecheck, test" });
  assert.deepEqual(said.record, { state: "held", note: "resolution changed a.txt" });
  assert.deepEqual(said.outcome, { kind: "held", text: "needs a human: resolution changed a.txt" });
});
