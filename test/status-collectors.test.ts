// The status view's collectors (GLOSSARY.md): each source refreshed on its own, within its deadline, one refresh at
// a time, its last good reading kept and marked stale when a refresh fails, a late answer dropped - first with a
// made-up source, then with a project's real sources against the status fixture's fakes (test/status-fixture.ts):
// the queue's minute, a failing source, everything ended when the view stops. No Docker, no network, no model calls.
//
//   pnpm test:file test/status-collectors.test.ts

// The view these tests start is the TypeScript one: status.sh has no collectors.
process.env.SANDCASTLE_TEST_STATUS_IMPL = "ts";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createCollector, createSources, snapshotOf } from "../src/status-snapshot.ts";
import { buildFixture, fixtureEnv, hang, release, type Fixture } from "./status-fixture.ts";
import { orphans, started, statusCommand, until } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-collectors-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** A promise and the hands that settle it: a source that answers when the test says. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => ([resolve, reject] = [res, rej]));
  return { promise, resolve, reject };
};

/** A made-up source: each read is answered by the test, and the signal each was given is kept. */
const source = <T>() => {
  const reads: { answer: ReturnType<typeof deferred<T>>; signal: AbortSignal }[] = [];
  const read = (signal: AbortSignal) => {
    const answer = deferred<T>();
    reads.push({ answer, signal });
    return answer.promise;
  };
  return { reads, read };
};

// ---------------------------------------------------------------------------
// One collector.
// ---------------------------------------------------------------------------

test("a source is loading until its first answer, then current with what it read", async () => {
  const s = source<string>();
  const collector = createCollector({ read: s.read, deadline: 5_000 });
  assert.deepEqual(collector.reading, { status: "loading" });
  const done = collector.refresh();
  assert.equal(collector.busy, true);
  s.reads[0]!.answer.resolve("first");
  await done;
  assert.deepEqual(collector.reading, { status: "current", value: "first" });
  assert.equal(collector.busy, false);
});

test("a failed refresh keeps the last good reading, marked stale with why, until one succeeds", async () => {
  const s = source<string>();
  const collector = createCollector({ read: s.read, deadline: 5_000 });
  let done = collector.refresh();
  s.reads[0]!.answer.resolve("good");
  await done;
  done = collector.refresh();
  s.reads[1]!.answer.reject(new Error("docker ps failed"));
  await done;
  assert.deepEqual(collector.reading, { status: "stale", value: "good", error: "docker ps failed" });
  done = collector.refresh();
  s.reads[2]!.answer.resolve("better");
  await done;
  assert.deepEqual(collector.reading, { status: "current", value: "better" });
});

test("a source that fails before it ever answered is unavailable", async () => {
  const s = source<string>();
  const collector = createCollector({ read: s.read, deadline: 5_000 });
  const done = collector.refresh();
  s.reads[0]!.answer.reject(new Error("not signed in"));
  await done;
  assert.deepEqual(collector.reading, { status: "unavailable", error: "not signed in" });
});

test("a refresh asked while one is in flight starts none: the one in flight answers both", async () => {
  const s = source<string>();
  const collector = createCollector({ read: s.read, deadline: 5_000 });
  const first = collector.refresh();
  const second = collector.refresh();
  assert.equal(s.reads.length, 1, "a second read started while the first was in flight");
  s.reads[0]!.answer.resolve("one");
  await Promise.all([first, second]);
  assert.deepEqual(collector.reading, { status: "current", value: "one" });
  // Once it is in, the next refresh reads again.
  const third = collector.refresh();
  assert.equal(s.reads.length, 2);
  s.reads[1]!.answer.resolve("two");
  await third;
});

test("a refresh still out at its deadline is given up: its signal aborts, the source goes stale and the late answer is dropped", async () => {
  const s = source<string>();
  let changes = 0;
  const collector = createCollector({ read: s.read, deadline: 50, onChange: () => changes++ });
  let done = collector.refresh();
  s.reads[0]!.answer.resolve("kept");
  await done;
  done = collector.refresh();
  await done;
  assert.equal(s.reads[1]!.signal.aborted, true, "the given-up refresh was not told to stop");
  assert.deepEqual(collector.reading, { status: "stale", value: "kept", error: "no answer in 0.05 s" });
  assert.equal(collector.busy, false, "a given-up refresh still holds the source");
  const seen = changes;
  // The answer that comes after the deadline is not the source's reading.
  s.reads[1]!.answer.resolve("late");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(collector.reading, { status: "stale", value: "kept", error: "no answer in 0.05 s" });
  assert.equal(changes, seen, "a late answer was told as a change");
});

test("a refresh that reads what the source had tells no one", async () => {
  const s = source<{ n: number }>();
  let changes = 0;
  const collector = createCollector({ read: s.read, deadline: 5_000, onChange: () => changes++ });
  let done = collector.refresh();
  s.reads[0]!.answer.resolve({ n: 1 });
  await done;
  assert.equal(changes, 1);
  done = collector.refresh();
  s.reads[1]!.answer.resolve({ n: 1 });
  await done;
  assert.equal(changes, 1, "a reading the same as the last was told as a change");
});

test("stopping a collector gives up its refresh in flight and starts none again", async () => {
  const s = source<string>();
  let changes = 0;
  const collector = createCollector({ read: s.read, deadline: 5_000, onChange: () => changes++ });
  const done = collector.refresh();
  collector.stop();
  await done;
  assert.equal(s.reads[0]!.signal.aborted, true);
  await collector.refresh();
  assert.equal(s.reads.length, 1, "a stopped collector read again");
  s.reads[0]!.answer.resolve("after the stop");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(collector.reading, { status: "loading" });
  assert.equal(changes, 0);
});

// ---------------------------------------------------------------------------
// A project's sources, against the fixture's fakes.
// ---------------------------------------------------------------------------

/** A fresh fixture, its environment, and the calls its fakes logged by name. */
const project = (name: string): { fixture: Fixture; env: NodeJS.ProcessEnv; dir: string; calls: (fake: string) => number } => {
  const fixture = buildFixture("live", join(TMP, name));
  after(() => fixture.stop());
  const env: NodeJS.ProcessEnv = { ...process.env, ...fixtureEnv(fixture) };
  const calls = (fake: string) => readFileSync(fixture.pids, "utf8").split("\n").filter((l) => l.endsWith(` ${fake}`)).length;
  return { fixture, env, dir: join(fixture.root, ".sandcastle"), calls };
};

test("every source answers, and the snapshot says each is current", async () => {
  const { env, dir } = project("current");
  const sources = createSources(dir, env);
  assert.equal(sources.answered(), false);
  await sources.refresh();
  assert.equal(sources.answered(), true);
  const snapshot = snapshotOf(dir, sources.readings(), { env });
  assert.deepEqual(snapshot.sources, { record: "current", git: "current", docker: "current", queue: "current", pool: "current" });
  assert.ok(snapshot.queue.tickets.length > 0, "the queue's tickets");
  assert.ok(Object.keys(snapshot.containers).length > 0, "the sandbox containers");
  assert.ok(Object.values(snapshot.branches).some((b) => b.exists), "the branches");
});

test("the queue is asked once a minute, and again as soon as the run record changes", async () => {
  const { env, dir, calls } = project("queue-minute");
  const sources = createSources(dir, env);
  await sources.refresh();
  await sources.refresh();
  assert.equal(calls("sandcastle"), 1, "the queue was asked again within its minute");
  // A run rewrites its record when it starts and when it ends, having closed what it landed.
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(dir, "logs/run.json"), later, later);
  await sources.refresh();
  assert.equal(calls("sandcastle"), 2, "the queue was not asked again after the run record changed");
  assert.ok(calls("docker") >= 3, "docker is sampled on every refresh");
});

test("a source that fails after a good reading keeps it in the snapshot, marked stale", async () => {
  const { env, dir } = project("stale");
  const sources = createSources(dir, env);
  await sources.refresh();
  const good = snapshotOf(dir, sources.readings(), { env });
  // Docker stops answering, and so does the tracker.
  delete env.FAKE_DOCKER;
  env.FAKE_QUEUE_FAIL = "gh: not signed in";
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(dir, "logs/run.json"), later, later);
  await sources.refresh();
  const snapshot = snapshotOf(dir, sources.readings(), { env });
  assert.equal(snapshot.sources?.docker, "stale");
  assert.equal(snapshot.sources?.queue, "stale");
  assert.deepEqual(snapshot.containers, good.containers, "the last containers seen were dropped");
  assert.deepEqual(snapshot.queue.tickets, good.queue.tickets, "the last queue read was dropped");
  assert.equal(snapshot.queue.error, "gh: not signed in", "why the queue could not be read is not said");
});

test("stopping the sources mid-refresh ends what the collectors started", async () => {
  const { fixture, env, dir } = project("stop");
  fixture.mark = readFileSync(fixture.pids, "utf8").split("\n").filter(Boolean).length;
  hang(fixture, "docker");
  hang(fixture, "sandcastle");
  const sources = createSources(dir, env);
  const done = sources.refresh();
  await until("docker and the queue in flight", () => {
    const names = started(fixture).map((p) => p.name);
    return names.includes("docker") && names.includes("sandcastle") ? true : undefined;
  });
  sources.stop();
  await done;
  assert.deepEqual(await orphans(fixture), []);
  assert.equal(sources.readings().docker.status, "loading", "a stopped source took an answer");
});

test("STATUS_FRAMES counts only the frames drawn once every source has answered", async () => {
  const { fixture, env } = project("frames");
  hang(fixture, "sandcastle");
  const { command, args } = statusCommand(["1"]);
  const view = spawn(command, args, { env: { ...env, STATUS_FRAMES: "1", TERM_COLS: "100", TERM_ROWS: "40", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  view.stdout!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  view.stderr!.on("data", () => {});
  const ended = new Promise<number | null>((resolve) => view.once("close", resolve));
  try {
    // Frames are drawn while the queue hangs, and none of them is counted: the view is still running.
    await until("a frame with the queue loading", () => (out.includes("queue: loading…") ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(view.exitCode, null, "the view ended before every source had answered");
    await release(fixture);
    assert.equal(await ended, 0);
    const frames = out.split("\x1b[H");
    assert.doesNotMatch(frames.at(-1)!, /queue: loading…/, "the counted frame is not one drawn with every source in");
  } finally {
    view.kill("SIGKILL");
  }
});
