// A gap an earlier turn's reviewer named in prose is carried into the last turn's summary on the same
// uncounted `Worth a glance` line as the last turn's own, marked with its turn: not under Needs you, not in
// the headline's `need you`, and no Next step. Made-up run.json and history.jsonl records of one run's two
// turns in a temp git repo; no Docker, model or network.
//
//   pnpm test:file test/gap-in-prose-turns.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const PID = 4242;
const turn = (n: number, started: string, finished: string, tickets: object) => ({
  orchestrator: "demo",
  pid: PID,
  startedAt: started,
  finishedAt: finished,
  exitCode: 0,
  settings: { autonomy: "drain", turn: n, cap: 20 },
  tickets,
  verify: null,
});

test("an earlier turn's gap sentence is on the Worth a glance line with its turn, and counted nowhere", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-gap-turns-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const dir = join(root, ".scratch/shop/issues");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-one.md"), "# One\n\nStatus: done\n\nDo it.\n\n## Comments\n");
  writeFileSync(join(dir, "02-two.md"), "# Two\n\nStatus: done\n\nDo it.\n\n## Comments\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const one = turn(1, "2026-10-01T08:00:00.000Z", "2026-10-01T08:30:00.000Z", { "shop-01": { state: "merged", title: "One", gap: "One gap remains: the CLI still says the old name." } });
  const two = turn(2, "2026-10-01T08:31:00.000Z", "2026-10-01T09:00:00.000Z", { "shop-02": { state: "merged", title: "Two", gap: "The Linux path is left alone." } });
  const logs = join(root, ".sandcastle/logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "run.json"), JSON.stringify(two));
  writeFileSync(join(logs, "history.jsonl"), `${JSON.stringify(one)}\n${JSON.stringify(two)}\n`);
  const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;

  const out = render(await gather(project, () => "sandcastle run"), true);
  assert.deepEqual(
    out.split("\n").filter((l) => l.startsWith("Worth a glance")),
    ['Worth a glance - the reviewer\'s prose may name a gap: shop-02 "The Linux path is left alone."; shop-01 "One gap remains: the CLI still says the old name." (turn 1)'],
  );
  assert.match(out, / - 0 need you - /);
  assert.doesNotMatch(out, /\(turn 1\)\.$/m);
  const needs = out.slice(out.indexOf("## Needs you"), out.indexOf("\n## ", out.indexOf("## Needs you")));
  assert.doesNotMatch(needs, /shop-0[12]/);
});
