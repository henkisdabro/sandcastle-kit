// The log archive is pruned by age whenever logs are archived: files over 14 days old go, and
// raw .jsonl streams over 2 days old go, while the readable .log of that age stays. Temp dirs
// only; no Docker, no model calls, no network.
//
//   pnpm exec tsx --test test/archive-prune.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";
import { archiveFinishedLogs, pruneArchive } from "../src/run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-archive-prune-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const DAY = 24 * 60 * 60;

const repo = (name: string) => {
  const root = join(TMP, name);
  mkdirSync(join(root, ".sandcastle", "logs", "archive"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);
  return { root, baseBranch: "main" } as Project;
};

const aged = (project: Project, name: string, days: number) => {
  const path = join(project.root, ".sandcastle/logs/archive", name);
  writeFileSync(path, "x\n");
  const t = Date.now() / 1000 - days * DAY;
  utimesSync(path, t, t);
  return path;
};

test("pruneArchive deletes files over 14 days and .jsonl streams over 2 days, and keeps the rest", () => {
  const project = repo("prune");
  const files = {
    freshLog: aged(project, "agent-issue-1-impl-1.log", 1),
    freshRaw: aged(project, "agent-issue-1-impl-1.jsonl", 1),
    midLog: aged(project, "agent-issue-2-impl-2.log", 10),
    midRaw: aged(project, "agent-issue-2-impl-2.jsonl", 3),
    oldLog: aged(project, "agent-issue-3-impl-3.log", 15),
    oldRaw: aged(project, "agent-issue-3-impl-3.jsonl", 15),
    oldOutput: aged(project, "run-output.log", 20),
  };
  assert.equal(pruneArchive(project), 4);
  for (const k of ["freshLog", "freshRaw", "midLog"] as const) assert.ok(existsSync(files[k]), `${k} was deleted`);
  for (const k of ["midRaw", "oldLog", "oldRaw", "oldOutput"] as const) assert.ok(!existsSync(files[k]), `${k} was kept`);
});

test("pruneArchive does nothing without an archive directory", () => {
  const project = repo("none");
  rmSync(join(project.root, ".sandcastle/logs/archive"), { recursive: true });
  assert.equal(pruneArchive(project), 0);
});

test("archiveFinishedLogs prunes the archive as it moves a finished branch's logs in", () => {
  const project = repo("archiving");
  const logs = join(project.root, ".sandcastle/logs");
  const old = aged(project, "agent-issue-4-impl-4.log", 30);
  const oldRaw = aged(project, "agent-issue-4-impl-4.jsonl", 5);
  writeFileSync(join(logs, "agent-issue-5-impl-5.log"), "readable\n");
  writeFileSync(join(logs, "agent-issue-5-impl-5.jsonl"), '{"raw":1}\n');
  archiveFinishedLogs(project);
  assert.ok(!existsSync(old));
  assert.ok(!existsSync(oldRaw));
  assert.ok(existsSync(join(logs, "archive", "agent-issue-5-impl-5.log")));
  assert.ok(existsSync(join(logs, "archive", "agent-issue-5-impl-5.jsonl")));
});
