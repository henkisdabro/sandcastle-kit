// The log archive also drops the head records of finished tickets and the old turns of the file-shares log,
// so neither file grows with every ticket ever run. Temp repos only; no Docker, no model calls.
//
//   pnpm test:file test/heads-prune.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";
import type { Project } from "../src/config.ts";
import { archiveFinishedLogs, readHeads } from "../src/run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-heads-prune-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const repo = (name: string) => {
  const root = join(TMP, name);
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);
  return { root, baseBranch: "main" } as Project;
};

const writeHeads = (project: Project, heads: Record<string, { branch: string; at: string }>) =>
  writeFileSync(join(project.root, ".sandcastle/logs/heads.json"), JSON.stringify(Object.fromEntries(Object.entries(heads).map(([id, h]) => [id, { ...h, run: "r" }]))));

test("archiving drops an old head record whose branch is gone, and keeps a recent one and one whose branch exists", async () => {
  const project = repo("heads");
  execFileSync("git", ["-C", project.root, "branch", "agent/issue-2"]);
  writeHeads(project, {
    "1": { branch: "agent/issue-1", at: ago(30) },
    "2": { branch: "agent/issue-2", at: ago(30) },
    "3": { branch: "agent/issue-3", at: ago(3) },
    "4": { branch: "agent/issue-4", at: "not a date" },
  });
  await quietly(() => archiveFinishedLogs(project));
  assert.deepEqual(Object.keys(readHeads(project.root)).sort(), ["2", "3", "4"]);
});

test("archiving trims file-shares.log to the turns inside the window", async () => {
  const project = repo("shares");
  const file = join(project.root, ".sandcastle/logs/file-shares.log");
  const recent = ago(1);
  writeFileSync(file, `loose line before any header\n--- ${ago(20)}, run pid 1 ---\n#1 + #2: a.ts\n--- ${recent}, run pid 2 ---\n#3 + #4: b.ts\n#3 + #5: b.ts\n`);
  await quietly(() => archiveFinishedLogs(project));
  assert.equal(readFileSync(file, "utf8"), `--- ${recent}, run pid 2 ---\n#3 + #4: b.ts\n#3 + #5: b.ts\n`);
});
