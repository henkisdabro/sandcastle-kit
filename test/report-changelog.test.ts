// `sandcastle report --changelog`: the suggested changelog lines of every ticket that landed since a
// ref, across runs (history.jsonl and run.json), and the record of a run killed without its exit
// handler kept in history by the next run. Made-up history files in a temp git repo; no Docker,
// model or network.
//
//   pnpm test:file test/report-changelog.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { KIT, runKit } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { changelogSince } = await import("../src/report.ts");
type Project = import("../src/config.ts").Project;

const git = (root: string, args: string[], date?: string) =>
  execFileSync("git", args, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) } });

// A repo whose one commit, tagged v1.0.0, is dated 2026-06-01.
const repo = (tag = true) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "release"], "2026-06-01T12:00:00Z");
  if (tag) git(root, ["tag", "v1.0.0"]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  return root;
};
const project = (root: string, changelog = true) => ({ root, baseBranch: "main", name: "fixture", changelog }) as unknown as Project;
const runLine = (startedAt: string, tickets: Record<string, unknown>, extra: object = {}) => JSON.stringify({ startedAt, finishedAt: startedAt, exitCode: 0, tickets, ...extra });
const writeHistory = (root: string, ...lines: string[]) => writeFileSync(join(root, ".sandcastle/logs/history.jsonl"), lines.join("\n") + "\n");

test("lines from two runs are both shown, grouped, with Upgrading notes apart", () => {
  const root = repo();
  writeHistory(
    root,
    runLine("2026-06-02T09:00:00Z", { "11": { state: "merged", title: "One", changelog: ["Added: a thing."] }, "12": { state: "held", changelog: ["Added: never landed."] } }),
  );
  // The current run.json is not yet in history.
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    runLine("2026-06-03T09:00:00Z", { "13": { state: "merged", changelog: ["Fixed: a bug.", "Upgrading: run setup again."] }, "14": { state: "merged", changelog: ["Tweaked a default."] } }),
  );
  const out = changelogSince(project(root));
  assert.match(out, /3 ticket\(s\) landed in runs started after v1\.0\.0/);
  assert.match(out, /^ {2}Added: a thing\. \(#11\)$/m);
  assert.match(out, /^ {2}Fixed: a bug\. \(#13\)$/m);
  assert.match(out, /^ {2}Changed: Tweaked a default\. \(#14\)$/m);
  assert.doesNotMatch(out, /never landed/);
  const lines = out.split("\n");
  assert.ok(lines.findIndex((l) => l.includes("Added: a thing")) < lines.findIndex((l) => l.includes("Fixed: a bug")));
  const upgrading = lines.findIndex((l) => l.startsWith("Upgrading notes"));
  assert.ok(upgrading > lines.findIndex((l) => l.includes("Fixed: a bug")));
  assert.equal(lines[upgrading + 1], "  Upgrading: run setup again. (#13)");
});

test("a ticket landed in two runs is shown once, with its latest lines", () => {
  const root = repo();
  writeHistory(
    root,
    runLine("2026-06-02T09:00:00Z", { "20": { state: "merged", changelog: ["Added: first half."] } }),
    runLine("2026-06-04T09:00:00Z", { "20": { state: "merged", changelog: ["Added: whole thing."] } }),
  );
  const out = changelogSince(project(root));
  assert.match(out, /1 ticket\(s\) landed/);
  assert.match(out, /Added: whole thing\. \(#20\)/);
  assert.doesNotMatch(out, /first half/);
  assert.equal(out.match(/#20/g)!.length, 1);
});

test("a finished run in both history and run.json counts once", () => {
  const root = repo();
  const line = runLine("2026-06-02T09:00:00Z", { "21": { state: "merged", changelog: ["Added: once."] } });
  writeHistory(root, line);
  writeFileSync(join(root, ".sandcastle/logs/run.json"), line);
  assert.equal(changelogSince(project(root)).match(/once\./g)!.length, 1);
});

test("a landed ticket with no suggested line is listed to write from the ticket", () => {
  const root = repo();
  writeHistory(root, runLine("2026-06-02T09:00:00Z", { "30": { state: "merged", title: "Quiet change" }, "31": { state: "merged", changelog: ["Fixed: loud."] } }));
  const out = changelogSince(project(root));
  const tail = out.slice(out.indexOf("No suggested line - write from the ticket:"));
  assert.match(tail, /^No suggested line - write from the ticket:\n {2}#30 Quiet change$/);
  assert.doesNotMatch(tail, /#31/);
});

test("only runs started after the ref's commit are read, and --since names another ref", () => {
  const root = repo();
  git(root, ["commit", "-q", "--allow-empty", "-m", "later"], "2026-06-10T12:00:00Z");
  git(root, ["tag", "v1.1.0"]);
  writeHistory(
    root,
    runLine("2026-06-02T09:00:00Z", { "40": { state: "merged", changelog: ["Added: before 1.1."] } }),
    runLine("2026-06-12T09:00:00Z", { "41": { state: "merged", changelog: ["Added: after 1.1."] } }),
    runLine("2026-06-13T09:00:00Z", { "42": { state: "merged", changelog: ["Added: dry."] } }, { dryRun: true }),
  );
  const latest = changelogSince(project(root));
  assert.match(latest, /after v1\.1\.0/);
  assert.match(latest, /after 1\.1\./);
  assert.doesNotMatch(latest, /before 1\.1\.|dry/);
  const older = changelogSince(project(root), "v1.0.0");
  assert.match(older, /before 1\.1\./);
  assert.match(older, /after 1\.1\./);
});

test("with no tag, all history is read; an unknown --since is refused", () => {
  const root = repo(false);
  writeHistory(root, "not json", runLine("2026-01-02T09:00:00Z", { "50": { state: "merged", changelog: ["Added: old."] } }));
  assert.match(changelogSince(project(root)), /the start of the history[\s\S]*Added: old\. \(#50\)/);
  assert.throws(() => changelogSince(project(root), "no-such-ref"), /`no-such-ref` is not a git ref/);
});

test("a project without `changelog: true` says why no tickets have lines", () => {
  const root = repo();
  writeHistory(root, runLine("2026-06-02T09:00:00Z", { "60": { state: "merged" } }));
  assert.match(changelogSince(project(root, false)), /no `changelog: true`/);
});

// A run killed with no exit handler leaves run.json unfinished: the next run's record keeps it in history.
const startRun = (root: string, cache: string) => {
  const script = join(root, "record.mts");
  writeFileSync(
    script,
    `import { recordRun } from ${JSON.stringify(pathToFileURL(join(KIT, "src/run.ts")).href)};
recordRun({ root: ${JSON.stringify(root)}, name: "fixture" } as any, {});
`,
  );
  const res = runKit([], { script, encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cache } });
  assert.equal(res.status, 0, res.stderr);
};
const history = (root: string) => readFileSync(join(root, ".sandcastle/logs/history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("a killed run's record, with its changelog lines, is kept in history by the next run", () => {
  const root = repo();
  const cache = mkdtempSync(join(tmpdir(), "sandcastle-changelog-cache-"));
  // No finishedAt, and a pid no process holds.
  const killed = { orchestrator: "fixture", pid: 2 ** 22 + 12345, startedAt: "2026-06-05T09:00:00.000Z", tickets: { "70": { state: "merged", changelog: ["Added: survived the kill."] } } };
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify(killed));
  startRun(root, cache);
  const [kept, ...rest] = history(root);
  assert.deepEqual(kept, killed);
  // The new run's own exit appends its record after it.
  assert.equal(rest.length, 1);
  assert.ok(rest[0].finishedAt);
  assert.match(changelogSince(project(root)), /Added: survived the kill\. \(#70\)/);
});

test("a run that finished is not appended a second time by the next run", () => {
  const root = repo();
  const cache = mkdtempSync(join(tmpdir(), "sandcastle-changelog-cache-"));
  writeFileSync(join(root, ".sandcastle/logs/run.json"), runLine("2026-06-05T09:00:00.000Z", { "71": { state: "merged" } }));
  startRun(root, cache);
  assert.equal(history(root).length, 1, "only the new run's own line");
});

test("the command prints the lines for --since, and refuses --since with no ref", () => {
  const root = repo();
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", changelog: true, gates: [{ name: "t", command: "true" }] };\n`);
  writeHistory(root, runLine("2026-06-02T09:00:00Z", { "80": { state: "merged", changelog: ["Added: by the command."] } }));
  const env = { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  const ok = runKit(["report", "--changelog", "--since", "v1.0.0"], { encoding: "utf8", cwd: root, env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Added: by the command\. \(#80\)/);
  const bad = runKit(["report", "--changelog", "--since"], { encoding: "utf8", cwd: root, env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /`--since` takes a git ref/);
});
