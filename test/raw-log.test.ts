// The raw agent stream sidecar: each pass's stdout lines land verbatim in a
// .jsonl beside its readable .log, archived with it and never shown by the
// status view as a log. Temp dirs only; no Docker, no model calls, no network.
//
//   pnpm exec tsx --test test/raw-log.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";
import { quietly } from "./quiet.ts";
import { kitLikeProcess } from "./kit-process.ts";
import { agentLog, agentLogging, archiveFinishedLogs, logOwner, rawLog } from "../src/run.ts";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-raw-log-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const repo = (name: string) => {
  const root = join(TMP, name);
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);
  return { root, baseBranch: "main" } as Project;
};

test("rawLog swaps the extension", () => {
  assert.equal(rawLog("/x/agent-issue-12-impl-12.log"), "/x/agent-issue-12-impl-12.jsonl");
});

test("logOwner reads a sidecar like its log, even for an id holding a phase word", () => {
  assert.equal(logOwner("agent-issue-12-impl-12.jsonl"), "12");
  assert.equal(logOwner("agent-issue-code-review-01-review-code-review-01.jsonl"), "code-review-01");
});

test("agentLogging appends raw events verbatim to the sidecar and leaves the readable log alone", () => {
  const project = repo("logging");
  const logging = agentLogging(project, "7", "impl-7", "run-1");
  assert.equal(logging.type, "file");
  assert.equal((logging as { path: string }).path, agentLog(project, "7", "impl-7"));
  const onEvent = (logging as { onAgentStreamEvent: (e: unknown) => void }).onAgentStreamEvent;
  const a = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}';
  const b = '{"type":"user","message":{"content":[{"type":"tool_result","content":"usage limit"}]}}';
  onEvent({ type: "raw", line: a, iteration: 1, timestamp: new Date() });
  onEvent({ type: "text", message: "hello", iteration: 1, timestamp: new Date() });
  onEvent({ type: "raw", line: b, iteration: 1, timestamp: new Date() });
  const lines = readFileSync(rawLog(agentLog(project, "7", "impl-7")), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const marker = JSON.parse(lines[0]);
  assert.equal(marker.sandcastle, "run");
  assert.equal(marker.run, "run-1");
  assert.deepEqual(lines.slice(1), [a, b]);
  for (const line of lines) JSON.parse(line);
  const readable = readFileSync(agentLog(project, "7", "impl-7"), "utf8");
  assert.match(readable, /# run run-1,/);
  assert.doesNotMatch(readable, /tool_use|tool_result/);
});

test("archiveFinishedLogs moves a sidecar with its log, unless the worktree is live", async () => {
  const project = repo("archive");
  const logs = join(project.root, ".sandcastle/logs");
  writeFileSync(join(logs, "agent-issue-9-impl-9.log"), "readable\n");
  writeFileSync(join(logs, "agent-issue-9-impl-9.jsonl"), '{"raw":1}\n');
  mkdirSync(join(project.root, ".sandcastle/worktrees/agent-issue-9"), { recursive: true });
  archiveFinishedLogs(project);
  assert.ok(existsSync(join(logs, "agent-issue-9-impl-9.jsonl")));
  assert.ok(existsSync(join(logs, "agent-issue-9-impl-9.log")));
  rmSync(join(project.root, ".sandcastle/worktrees/agent-issue-9"), { recursive: true });
  await quietly(() => archiveFinishedLogs(project));
  for (const [name, text] of [["agent-issue-9-impl-9.log", "readable\n"], ["agent-issue-9-impl-9.jsonl", '{"raw":1}\n']]) {
    assert.ok(!existsSync(join(logs, name)), `${name} still in logs/`);
    assert.equal(readFileSync(join(logs, "archive", name), "utf8"), text);
  }
});

// The status view, with the harness of status-queue.test.ts: a fake sandcastle and docker.
const view = (project: Project) => {
  const fake = join(TMP, "bin");
  mkdirSync(fake, { recursive: true });
  for (const [name, body] of [["sandcastle", "#!/bin/sh\nprintf '[]\\n'\n"], ["docker", "#!/bin/sh\nexit 1\n"]]) {
    writeFileSync(join(fake, name), body);
    chmodSync(join(fake, name), 0o755);
  }
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [fake, process.env.PATH].join(":"),
      SANDCASTLE_PROJECT: project.root,
      SANDCASTLE_BIN: join(fake, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: "80",
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
  });
  return (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, "");
};

test("the status view never shows a sidecar as a log", () => {
  const project = repo("status-only");
  writeFileSync(join(project.root, ".sandcastle/logs/agent-issue-205-impl-205.jsonl"), '{"type":"assistant"}\n');
  assert.doesNotMatch(view(project), /#205/);
});

test("the status view reads the readable log, not a newer sidecar", () => {
  const project = repo("status-both");
  const git = (...args: string[]) => execFileSync("git", ["-C", project.root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  git("checkout", "-q", "-b", "agent/issue-205");
  writeFileSync(join(project.root, "f"), "x\n");
  git("add", "f");
  git("commit", "-q", "-m", "issue 205");
  git("checkout", "-q", "main");
  const logs = join(project.root, ".sandcastle/logs");
  const log = join(logs, "agent-issue-205-impl-205.log");
  const raw = join(logs, "agent-issue-205-impl-205.jsonl");
  writeFileSync(log, "Bash(pnpm test)\n");
  writeFileSync(raw, '{"type":"assistant","message":"x"}\n{"type":"user"}\n');
  // A live run (a process under the kit's command line) with #205 implementing, so its row shows the newest log's last line.
  const now = Math.floor(Date.now() / 1000);
  const run = kitLikeProcess();
  writeFileSync(
    join(logs, "run.json"),
    JSON.stringify({
      orchestrator: "fixture", pid: run.pid, startedAt: new Date().toISOString(), models: "implement m/high", stage: "implementing",
      concurrency: 1, issues: ["205"], tickets: { "205": { state: "implement", since: now - 30, started: now - 60 } },
    }),
  );
  utimesSync(log, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  utimesSync(raw, new Date(), new Date());
  try {
    const frame = view(project);
    assert.match(frame, /pnpm test/);
    assert.doesNotMatch(frame, /"type":/);
  } finally {
    run.kill();
  }
});
