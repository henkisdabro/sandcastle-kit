// The command-shaped fixes in `sandcastle doctor`: shell quoting, the .gitignore fix and the
// queue-label check against a fake `gh`. No Docker, no network, no real gh.
//
//   pnpm test:file test/doctor-fix.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = join(tmp, "cache");
process.env.XDG_CONFIG_HOME = join(tmp, "config");
const { gitignoreFix, queueLabel, shellQuote } = await import("../src/doctor.ts");

// A fake gh: logs where it ran and what it was given, then prints $FAKE_LABELS or fails.
const bin = join(tmp, "bin");
const log = join(tmp, "gh.log");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), '#!/bin/sh\n{ pwd; echo "$*"; } >> "$FAKE_GH_LOG"\n[ "$FAKE_GH_FAIL" = 1 ] && exit 1\nprintf \'%s\' "$FAKE_LABELS"\n');
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = bin + delimiter + process.env.PATH;
process.env.FAKE_GH_LOG = log;

const project = (name: string) => {
  const root = join(tmp, name);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  return root;
};
const sh = (script: string, cwd?: string) => execFileSync("sh", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
const inBackticks = (text: string) => text.match(/^`(.*)`$/s)![1];

test("shellQuote leaves a plain path alone, quotes a space, and a quote survives sh", () => {
  assert.equal(shellQuote("/a/b-c.d"), "/a/b-c.d");
  assert.equal(shellQuote("/a b"), "'/a b'");
  for (const text of ["it's", "/a b/it's here", "a'b'c"]) assert.equal(sh(`printf '%s' ${shellQuote(text)}`), text);
});

test("queueLabel: a case-insensitive match is ok, asked of gh from the project", () => {
  const root = project("ok");
  process.env.FAKE_GH_FAIL = "0";
  process.env.FAKE_LABELS = '[{"name":"Ready-For-Agent"}]';
  writeFileSync(log, "");
  assert.equal(queueLabel(root, "ready-for-agent").state, "ok");
  const [dir, args] = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(realpathSync(dir), realpathSync(root));
  assert.equal(args, "label list --search ready-for-agent --limit 100 --json name");
});

test("queueLabel: a missing label names the gh label create command", () => {
  process.env.FAKE_GH_FAIL = "0";
  process.env.FAKE_LABELS = '[{"name":"bug"}]';
  const root = project("missing");
  const missing = queueLabel(root, "ready-for-agent");
  assert.equal(missing.state, "missing");
  assert.equal(missing.fix, "`gh label create ready-for-agent --description 'Queued for a Sandcastle agent run'`");
  assert.ok(queueLabel(root, "agent queue").fix.includes("gh label create 'agent queue' "));
  const quoted = queueLabel(root, "it's").fix;
  assert.equal(sh(`printf '%s' ${quoted.match(/gh label create (.*) --description/)![1]}`), "it's");
});

test("queueLabel: gh failing or printing nonsense is not checked, never missing", () => {
  const root = project("fail");
  process.env.FAKE_GH_FAIL = "1";
  assert.equal(queueLabel(root, "ready-for-agent").state, "not checked");
  process.env.FAKE_GH_FAIL = "0";
  process.env.FAKE_LABELS = "not json";
  assert.equal(queueLabel(root, "ready-for-agent").state, "not checked");
});

test("gitignoreFix names what is missing, and the command it prints completes the file", () => {
  const root = project("ignore dir");
  const file = join(root, ".sandcastle/.gitignore");
  writeFileSync(file, ".env\nlogs/\n");
  const fix = gitignoreFix(root);
  assert.ok(fix.includes("printf '%s\\n' worktrees/ .run/ triage/ >> "));
  sh(inBackticks(fix), root);
  const lines = readFileSync(file, "utf8").split("\n");
  for (const entry of [".env", "logs/", "worktrees/", ".run/", "triage/"]) assert.equal(lines.filter((l) => l === entry).length, 1, entry);
  assert.match(gitignoreFix(root), /git check-ignore -v \.sandcastle\/logs\/x/);
});

test("gitignoreFix with no file at all names all five entries", () => {
  assert.ok(gitignoreFix(project("none")).includes("'%s\\n' .env logs/ worktrees/ .run/ triage/ >>"));
});

test("gitignoreFix on a file with no final newline keeps its last line intact", () => {
  const root = project("no newline");
  const file = join(root, ".sandcastle/.gitignore");
  writeFileSync(file, ".env");
  sh(inBackticks(gitignoreFix(root)), root);
  const lines = readFileSync(file, "utf8").split("\n");
  for (const entry of [".env", "logs/", "worktrees/", ".run/", "triage/"]) assert.equal(lines.filter((l) => l === entry).length, 1, entry);
});
