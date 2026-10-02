// Agent-filed follow-ups: ensureTriageLabel creates the needs-triage label
// without --force and never throws, and the closing report lists open
// needs-triage issues created since the run started. A fake `gh` first on PATH
// (plain sh, the same on macOS and Linux) logs its arguments and answers from
// fixtures, so no network is needed. Dates are compared in TypeScript.
//
//   pnpm exec tsx --test test/triage-label.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { ensureTriageLabel } = await import("../src/tracker.ts");
const { gather, render } = await import("../src/report.ts");
type Facts = Parameters<typeof render>[0];

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
const log = join(dir, "calls.log");
const gh = join(dir, "gh");
writeFileSync(
  gh,
  `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
[ "$FAKE_GH_FAIL" = 1 ] && { printf 'HTTP 403: forbidden\\n' >&2; exit 1; }
case "$1 $2" in
  "label list") printf '%s\\n' "$FAKE_GH_LABELS" ;;
  "issue list") printf '%s\\n' "$FAKE_GH_ISSUES" ;;
esac
exit 0
`,
);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const calls = () => {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const reset = () => {
  writeFileSync(log, "");
  delete process.env.FAKE_GH_FAIL;
};

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:00:00.000Z",
  finished: "2026-09-30T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 0,
  tickets: { "1": { state: "merged", title: "a" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const needsYou = (text: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("## 🙋 Needs you"));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("report: a filed issue is listed under Needs you; with none, the section says none", () => {
  const section = needsYou(render(facts({ filed: [{ id: "301", title: "x" }] })));
  assert.match(section, /#301 x/);
  assert.match(section, /triage it/);
  assert.match(needsYou(render(facts())), /none/);
});

test("ensureTriageLabel: an existing label is left alone", () => {
  reset();
  process.env.FAKE_GH_LABELS = '[{"name":"needs-triage-old"},{"name":"needs-triage"}]';
  ensureTriageLabel("needs-triage");
  assert.ok(calls().some((c) => c.startsWith("label list")));
  assert.ok(!calls().some((c) => c.includes("label create")));
});

test("ensureTriageLabel: a lookalike does not count, and create never passes --force", () => {
  reset();
  process.env.FAKE_GH_LABELS = '[{"name":"needs-triage-old"}]';
  ensureTriageLabel("needs-triage");
  const create = calls().filter((c) => c.startsWith("label create needs-triage"));
  assert.equal(create.length, 1);
  assert.ok(!calls().some((c) => c.includes("--force")));
});

test("ensureTriageLabel: a failing gh warns and does not throw", () => {
  reset();
  process.env.FAKE_GH_FAIL = "1";
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    assert.doesNotThrow(() => ensureTriageLabel("needs-triage"));
  } finally {
    console.log = real;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not create the needs-triage label/);
  assert.match(lines[0], /unlabelled/);
});

test("gather: only needs-triage issues created since the run started are filed", async () => {
  reset();
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({
      startedAt: "2026-09-30T06:00:00Z",
      finishedAt: "2026-09-30T07:00:00Z",
      pid: 1,
      tickets: { "1": { state: "merged", title: "a" } },
    }),
  );
  process.env.FAKE_GH_ISSUES = JSON.stringify([
    { number: 40, title: "older", createdAt: "2026-09-29T12:00:00Z" },
    { number: 41, title: "newer", createdAt: "2026-09-30T06:30:00Z" },
  ]);
  const project = { root, baseBranch: "main", tracker: { kind: "github", held: "ready-for-human", triage: "needs-triage" }, gates: [] } as any;
  const f = await gather(project);
  assert.deepEqual(f.filed, [{ id: "41", title: "newer" }]);
  assert.ok(calls().some((c) => c.includes("issue list") && c.includes("--label needs-triage")));
});
