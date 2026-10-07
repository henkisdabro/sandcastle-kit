// Every landing that comes to its merge writes a `landing` timings line with its wait for a machine-wide
// sandbox slot as `waitMs`: a fast-forward (no slot: 0), a conflict found on the host before one, a landing
// that stood for a slot and then found a conflict in the sandbox, and one that merged. A landing decided
// without a merge (taken back, held) writes none. The line is no part of a ticket's pipeline time: the
// estimate and `typicalTimes` leave it out, as they leave out the landing gates it holds. Temp repos, a
// host worktree for the sandbox, a one-slot pool - no Docker, no model, no network.
//
//   pnpm test:file test/landing-wait-recorded.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-landing-wait-cache-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-landing-wait-cfg-"));
process.env.SANDCASTLE_MAX_SANDBOXES = "1";
const { createHostGit, didMerge, landingWork } = await import("../src/landing.ts");
const { LANDING, LANDING_GATES, writeLandingLine } = await import("../src/gates.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { inject, withSlot } = await import("../src/pool.ts");
const { commandOf } = await import("../src/live-runs.ts");
const { estimate, typicalTimes } = await import("../src/run.ts");
// This process takes slots, as a run would: `ps` would call it a test runner, and its slot stale.
inject({ probe: (pid) => (pid === process.pid ? everyPidIsTheKit() : commandOf(pid)) });
type Project = import("../src/config.ts").Project;
type Ctx = import("../src/landing.ts").LandContext;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-landing-wait-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};
const commit = (root: string, files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  git(root, "add", "-A");
  assert.equal(git(root, "commit", "-q", "-m", message).status, 0);
};

type Line = { phase: string; issue: string; run: string; ms: number; waitMs?: number; ok: boolean; result: string; carried?: boolean };

/**
 * main holds `shared.txt`; `agent/issue-7` changes `branch`. With `base` the base moves on after the fork (not a
 * fast-forward); the sandbox is a host worktree. `land` lands ticket 7 through the run's own port and returns the
 * timings lines it wrote, with the real `writeLandingLine` behind `ctx.timed` as `burndown()` wires it.
 */
const setup = (branch: Record<string, string>, base?: Record<string, string>, over: Partial<Ctx> = {}, generated: Project["generated"] = []) => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  // The landing's own merge commit reads the repo's identity: a Linux sandbox has none to guess, unlike macOS.
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, { "shared.txt": "start\n" }, "start");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  commit(root, branch, "work on 7");
  git(root, "checkout", "-q", "main");
  const head = git(root, "rev-parse", "agent/issue-7").out;
  if (base) commit(root, base, "ticket 3 landed");
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated, gates: [], setup: [] } as unknown as Project;
  const open: Opener = async (name) => {
    const path = join(tmp, `wt${n++}`);
    assert.equal(git(root, "worktree", "add", "-q", "-b", name, path, "main").status, 0);
    return {
      worktreePath: path,
      exec: async (cmd) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => git(root, "worktree", "remove", "--force", path),
    };
  };
  const timings = join(root, "timings.jsonl");
  const slotWanted = { n: 0 };
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, close: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: open,
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [], failures: [] }),
    landed: new Map([["3", { commit: git(root, "rev-parse", "main").out, files: Object.keys(base ?? {}) }]]),
    slotWanted,
    timed: (id, took, landed) => writeLandingLine(timings, { run: "r1", project: "fixture", issue: id, carried: true }, took, { ok: didMerge(landed), kind: landed.kind }),
    ...over,
  };
  const lines = (): Line[] => {
    try {
      return readFileSync(timings, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const land = async () => (await quietly(() => landingWork(ctx).land({ issue: "7", branch: "agent/issue-7", status: "green", commits: 1, repairs: 0, head }))).result;
  return { root, ctx, land, lines, slotWanted };
};

test("a fast-forward landing writes a landing line with no wait, and says it landed", async () => {
  const { land, lines } = setup({ "b.txt": "b\n" });
  assert.equal((await land()).kind, "merged");
  const [l, ...rest] = lines();
  assert.deepEqual(rest, []);
  assert.deepEqual([l.phase, l.issue, l.run, l.ok, l.result, l.carried, l.waitMs], [LANDING, "7", "r1", true, "merged", true, undefined]);
  assert.equal(typeof l.ms, "number");
});

test("a conflict found on the host, before any slot, writes a landing line that did not land", async () => {
  const { land, lines } = setup({ "shared.txt": "from seven\n" }, { "shared.txt": "from three\n" });
  assert.equal((await land()).kind, "conflict");
  const [l, ...rest] = lines();
  assert.deepEqual(rest, []);
  assert.deepEqual([l.phase, l.ok, l.result, l.waitMs], [LANDING, false, "conflict", undefined]);
});

test("a landing that waited for a sandbox slot records the wait as waitMs, out of ms, and a merge in the sandbox is a landing", async () => {
  const { land, lines } = setup({ "b.txt": "b\n" }, { "c.txt": "c\n" });
  const HELD = 300;
  let landing!: ReturnType<typeof land>;
  await withSlot("sandboxes", "holder", async () => {
    landing = land();
    await sleep(HELD);
  });
  assert.equal((await landing).kind, "merged");
  const [l, ...rest] = lines();
  assert.deepEqual(rest, []);
  // The pool looks again every 5 s, so the wait is at least as long as the slot was held.
  assert.ok(l.waitMs! >= HELD, `waitMs ${l.waitMs}`);
  assert.deepEqual([l.phase, l.ok, l.result], [LANDING, true, "merged"]);
});

test("a landing that waited for a slot and then found a conflict in the sandbox still writes its line", async () => {
  // A conflict confined to a generated file is left to the sandbox, which cannot regenerate it here (no regen command that fixes it).
  const generated = [{ paths: ["lock.txt"], regen: "false" }];
  const { land, lines } = setup({ "lock.txt": "lock 7\n" }, { "lock.txt": "lock 3\n" }, {}, generated);
  const HELD = 300;
  let landing!: ReturnType<typeof land>;
  await withSlot("sandboxes", "holder", async () => {
    landing = land();
    await sleep(HELD);
  });
  assert.equal((await landing).kind, "conflict");
  const [l, ...rest] = lines();
  assert.deepEqual(rest, []);
  assert.ok(l.waitMs! >= HELD, `waitMs ${l.waitMs}`);
  assert.deepEqual([l.ok, l.result], [false, "conflict"]);
});

test("a landing decided without a merge (a hold, a ticket taken back) writes no line", async () => {
  const taken = setup({ "b.txt": "b\n" }, undefined, { withdrawal: () => ({ held: true, reason: "marked for a human during the run" }) });
  assert.equal((await taken.land()).kind, "taken-back");
  assert.deepEqual(taken.lines(), []);
  const out = setup({ "b.txt": "b\n" }, undefined, { withdrawal: () => ({ held: false, reason: "ticket closed during the run" }) });
  assert.equal((await out.land()).kind, "withdrawn");
  assert.deepEqual(out.lines(), []);
});

test("a throw in the timings writer costs a landing nothing", async () => {
  const { land } = setup({ "b.txt": "b\n" }, undefined, {
    timed: () => {
      throw new Error("disk full");
    },
  });
  assert.equal((await land()).kind, "merged");
});

test("burndown wires the landing line to the landing port, as the landing gates are", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /timed: \(id, took, landed\) => writeLandingLine\(timings, \{ run: runId, project: project\.name, issue: id, carried: carriedAtStart\.has\(id\) \}, took, \{ ok: didMerge\(landed\), kind: landed\.kind \}\)/);
});

// -- the landing line is no part of a ticket's pipeline time ------------------------------------------------------

const MIN = 60_000;
const tokens = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };
const entry = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });
const history = (withLanding: boolean) => {
  const root = mkdtempSync(join(tmp, "estimate-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = ["1", "2", "3"].flatMap((issue) => [
    entry({ issue, phase: "implement", ms: 4 * MIN, tokens }),
    entry({ issue, phase: "gates", ms: 3 * MIN }),
    entry({ issue, phase: LANDING_GATES, ms: 5 * MIN, waitMs: 30 * MIN }),
    ...(withLanding ? [entry({ issue, phase: LANDING, ms: 6 * MIN, waitMs: 8 * MIN, ok: true, result: "merged" })] : []),
  ]);
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

test("typicalTimes leaves the landing line out of a ticket's time and of the landing gates", () => {
  const typical = typicalTimes(history(true));
  assert.equal(typical.issue, 7 * 60);
  assert.equal(typical[LANDING_GATES], 5 * 60);
  assert.equal(typical[LANDING], undefined);
  assert.deepEqual(typical, typicalTimes(history(false)));
});

test("the estimate prices a run the same with the landing lines in the history as without them", () => {
  const priced = (withLanding: boolean) => estimate(history(withLanding), 3, 1);
  assert.match(priced(false) ?? "", /\d/);
  assert.equal(priced(true), priced(false));
});
