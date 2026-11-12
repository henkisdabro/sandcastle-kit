// `sandcastle report --run <pid|startedAt>`: the closing summary of a run that a newer run replaced in
// run.json and that printed none of its own (stopped, crashed, killed). Made-up run.json and history.jsonl
// records over a ticket-files tracker in a temp git repo; no Docker, model or network.
//
//   pnpm test:file test/report-run-flag.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, findRun, render } = await import("../src/report.ts");
const { runKit } = await import("./cli-spawn.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const kit = () => "sandcastle run";

const record = (pid: number, startedAt: string, tickets: Record<string, object>, over: Record<string, unknown> = {}) => ({
  orchestrator: "demo",
  pid,
  startedAt,
  finishedAt: startedAt.replace(/T(\d\d)/, (_, h) => `T${String(Number(h) + 1).padStart(2, "0")}`),
  exitCode: 0,
  tickets,
  verify: null,
  ...over,
});

const FIRST = record(1111, "2026-10-01T08:00:00.000Z", { "shop-01": { state: "merged", title: "First work" } });
const SECOND = record(2222, "2026-10-02T08:00:00.000Z", { "shop-02": { state: "merged", title: "Second work" } });
const THIRD = record(3333, "2026-10-03T08:00:00.000Z", { "shop-03": { state: "merged", title: "Third work" } });

const turnOf = (n: number, tickets: Record<string, object>) => record(4444, `2026-10-04T0${n}:00:00.000Z`, tickets, { settings: { autonomy: "drain", turn: n, cap: 20 } });
const TURN1 = turnOf(1, { "shop-04": { state: "merged", title: "Needs eyes", ungated: "the cart page has no test" } });
const TURN2 = turnOf(2, { "shop-05": { state: "merged", title: "Fifth work" } });

/** A project (a ticket-files tracker, a config the CLI loads) whose run.json is `current` and whose history.jsonl holds `history`. */
const project = (t: { after: (fn: () => void) => void }, current: object, history: object[]) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-report-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const dir = join(root, ".scratch/shop/issues");
  mkdirSync(dir, { recursive: true });
  const titles = ["First work", "Second work", "Third work", "Needs eyes", "Fifth work"];
  titles.forEach((title, i) => writeFileSync(join(dir, `0${i + 1}-t.md`), `# ${title}\n\nStatus: done\n\nDo it.\n\n## Comments\n`));
  writeFileSync(join(root, "README.md"), "base\n");
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "demo", gates: [{ name: "g", command: "true" }], tracker: "files" };\n`);
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const logs = join(root, ".sandcastle/logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "run.json"), JSON.stringify(current));
  writeFileSync(join(logs, "history.jsonl"), history.map((h) => JSON.stringify(h) + "\n").join(""));
  return root;
};

/** `sandcastle report ...args` in the project, with a config home of its own. */
const report = (root: string, ...args: string[]) => {
  const config = mkdtempSync(join(tmpdir(), "sandcastle-report-run-cfg-"));
  return runKit(["report", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "", HOME: config, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(config, "cache"), GIT_CEILING_DIRECTORIES: tmpdir() },
  });
};

test("--run a replaced run's pid prints that run's summary, not run.json's", (t) => {
  const root = project(t, THIRD, [FIRST, SECOND]);
  const out = report(root, "--run", "1111");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^## 🏁 Run/m);
  assert.match(out.stdout, /shop-01/);
  assert.doesNotMatch(out.stdout, /shop-02|shop-03/);
  assert.match(out.stdout, /^## 👉 Next step/m);
  assert.ok(out.stdout.indexOf("shop-01") < out.stdout.indexOf("## 👉 Next step"), "the tickets come before the next step");
  // Without the flag, run.json's run is the one shown.
  const last = report(root);
  assert.match(last.stdout, /shop-03/);
  assert.doesNotMatch(last.stdout, /shop-01/);
});

test("--run a start time exactly names the record", (t) => {
  const root = project(t, THIRD, [FIRST, SECOND]);
  const out = report(root, "--run", SECOND.startedAt);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /shop-02/);
  assert.doesNotMatch(out.stdout, /shop-01|shop-03/);
});

test("--run run.json's own pid prints run.json's run", (t) => {
  const root = project(t, THIRD, [FIRST, SECOND]);
  const out = report(root, "--run", "3333");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /shop-03/);
});

test("an unknown pid exits 1 and lists the runs it knows, newest first, at most 10", (t) => {
  const many = Array.from({ length: 12 }, (_, i) => record(5000 + i, `2026-09-${String(10 + i).padStart(2, "0")}T08:00:00.000Z`, {}));
  const root = project(t, THIRD, [FIRST, SECOND, ...many]);
  const out = report(root, "--run", "9999");
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /9999/);
  assert.match(out.stderr, /pid 3333 {2}started 2026-10-03T08:00:00\.000Z/);
  assert.match(out.stderr, /pid 5011 /);
  const listed = out.stderr.match(/^ {2}pid \d+/gm) ?? [];
  assert.equal(listed.length, 10);
  assert.doesNotMatch(out.stderr, /pid 1111 /, "only the latest 10");
  assert.ok(out.stderr.indexOf("pid 3333") < out.stderr.indexOf("pid 5011") && out.stderr.indexOf("pid 5011") < out.stderr.indexOf("pid 5003"));
});

test("--run with no value is refused", (t) => {
  const out = report(project(t, THIRD, []), "--run");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /`--run` takes a pid or a start time/);
});

test("a pid with two turns renders the last turn, with the earlier turn's items marked (turn 1)", async (t) => {
  const root = project(t, THIRD, [TURN1, TURN2]);
  const p = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: (await import("./fixtures.ts")).fakeTracker({ kind: "files" }) } as never;
  const out = render(await gather(p, kit, findRun(root, "4444")), true);
  assert.match(out, /check by hand: the cart page has no test \(turn 1\)$/m);
  assert.match(out, /shop-05/);
  assert.doesNotMatch(out, /shop-03/);
});

test("two turns of one pid followed by a later run's line still carry the earlier turn", (t) => {
  const root = project(t, THIRD, [TURN1, TURN2, SECOND]);
  const out = report(root, "--run", "4444");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /check by hand: the cart page has no test \(turn 1\)$/m);
  assert.match(out.stdout, /shop-05/);
  assert.doesNotMatch(out.stdout, /shop-02|shop-03/);
});

test("a pid reused by a later run names that run's latest record", (t) => {
  const reused = record(4444, "2026-10-09T08:00:00.000Z", { "shop-03": { state: "merged", title: "Third work" } });
  const root = project(t, THIRD, [TURN1, TURN2, reused]);
  assert.equal(findRun(root, "4444").startedAt, reused.startedAt);
});
