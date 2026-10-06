// `sandcastle init` gitignores .sandcastle/triage/, where the queue action's subagents persist
// their results; otherwise they show as untracked and a run's clean-tree check refuses to start.
// A throwaway repo, no Docker and no model calls.
//
//   node --test test/triage-dir.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { init } from "../src/init.ts";

test("init gitignores .sandcastle/triage/", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-triage-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: {} }));

  const log = console.log;
  console.log = () => {};
  try {
    init(root);
  } finally {
    console.log = log;
  }

  const lines = readFileSync(join(root, ".sandcastle/.gitignore"), "utf8").split("\n");
  assert.ok(lines.includes("triage/"), `.gitignore lacks triage/: ${lines.join(" | ")}`);
  execFileSync("git", ["-C", root, "check-ignore", "-q", ".sandcastle/triage/12.json"]);
});
