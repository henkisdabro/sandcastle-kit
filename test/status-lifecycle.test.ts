// The live status view's lifecycle, held from outside: it is started on a terminal, a test waits for a
// painted frame and then does what a person or Herdr would - types keys, sends Ctrl-C as a byte, resizes the
// pane, sends INT, TERM or HUP to the view's pid - and checks what the view did: the frame it painted, the
// status it ended with, the terminal it left, the processes it left running. No fake `sleep`, which only
// the bash loop would ever run: these hold any implementation of the view, chosen with
// SANDCASTLE_TEST_STATUS_IMPL (test/status-run.ts). No Docker, no network, no model calls.
//
//   pnpm test:file test/status-lifecycle.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { buildFixture, hang, release } from "./status-fixture.ts";
import { impl, needsScript, orphans, settledTty, started, startSession, until, type Painted, type Session } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-lifecycle-"));
// An older orchestrator's live run: a few rows, one sandbox container, so a frame is quick and the view calls docker, git and sandcastle.
const fixture = buildFixture("legacy", TMP);
after(() => {
  fixture.stop();
  rmSync(TMP, { recursive: true, force: true });
});

/** Starts the view; whatever a test leaves of it is ended after the test. */
const opened: Session[] = [];
afterEach(() => opened.splice(0).forEach((session) => session.close()));
const open = async (options: Parameters<typeof startSession>[1] = {}) => {
  const session = await startSession(fixture, options);
  opened.push(session);
  return session;
};

const widthOf = (frame: { text: string }) => [...frame.text.split("\n")[0]!].length;
/** The sequences a live view writes to leave the alternate screen and give the terminal back. */
const LEFT = ["\x1b[?1007h", "\x1b[?7h", "\x1b[?25h", "\x1b[?1049l"];

// Strictly held only for a view that stops what it started: the bash view's traps wait out a command in
// flight, so there the checks are kept for SANDCASTLE_TEST_STATUS_STRICT=1, which shows them failing.
const inFlight = { skip: impl() === "bash" && !process.env.SANDCASTLE_TEST_STATUS_STRICT ? "status.sh waits out a command in flight (SANDCASTLE_TEST_STATUS_STRICT=1 runs this anyway)" : false as const };

// ---------------------------------------------------------------------------
// The first frame and the terminal while the view runs.
// ---------------------------------------------------------------------------

test("the live view draws its frame on the alternate screen, with echo and line mode off and Ctrl-C still a signal", needsScript, async () => {
  const view = await open();
  const first = await view.frame();
  const out = view.output();
  assert.ok(out.indexOf("\x1b[?1049h") >= 0 && out.indexOf("\x1b[?1049h") < out.indexOf("\x1b[H"), "no alternate screen before the first frame");
  assert.ok(out.indexOf("\x1b[?1007l") >= 0 && out.indexOf("\x1b[?1007l") < out.indexOf("\x1b[2J"), "alternate scroll not turned off on entry");
  assert.match(first.text, /fixture/, "the frame is the project's");
  const flags = await view.flags();
  assert.match(flags, /-echo\b/, "echo left on while the view is live");
  assert.match(flags, /-icanon\b/, "input left line-buffered while the view is live");
  assert.match(flags, /(^|\s)isig\b/, "isig turned off: Ctrl-C would no longer stop the view");
});

test("a key typed into the live view is not echoed and does not end it", needsScript, async () => {
  const view = await open({ args: ["1"] });
  const first = await view.frame();
  const typed = view.output().length;
  view.send("hello\x1b[A\x1b[B");
  // The view is still drawing: a frame that starts after the keys, with none of them on the screen.
  await view.frame(typed + 1);
  assert.ok(!view.output().slice(typed).includes("hello"), "typed keys were echoed onto the frame");
  assert.ok(view.frames(first.end).length >= 1);
  view.send("\x03");
  assert.equal((await view.ended("Ctrl-C")).status, 130);
});

test("the live view keeps drawing on its interval", needsScript, async () => {
  const view = await open({ args: ["1"] });
  const first = await view.frame();
  const second = await view.frame(first.end);
  await view.frame(second.end);
});

// ---------------------------------------------------------------------------
// Every way out: the status, the terminal handed back, nothing of the view's left running.
// ---------------------------------------------------------------------------

type Exit = { name: string; popup?: boolean; act: (view: Session) => void; status: number[] };
const EXITS: Exit[] = [
  { name: "q", popup: true, act: (v) => v.send("q"), status: [0] },
  { name: "Esc", popup: true, act: (v) => v.send("\x1b"), status: [0] },
  { name: "Ctrl-C as a byte", act: (v) => v.send("\x03"), status: [130] },
  { name: "INT", act: (v) => v.signal("SIGINT"), status: [130] },
  { name: "TERM", act: (v) => v.signal("SIGTERM"), status: [130] },
  // Bash is killed by the hangup (129); a view that traps it may end 130.
  { name: "HUP", act: (v) => v.signal("SIGHUP"), status: [129, 130] },
];

for (const exit of EXITS) {
  test(`${exit.name} ends the view, hands the terminal back and leaves no docker, gh, git or sandcastle running`, needsScript, async () => {
    const view = await open({ env: exit.popup ? { SANDCASTLE_STATUS_KEYS: "1" } : {} });
    await view.frame();
    // The check below would hold for a view that started nothing: it has asked docker, git and the queue by now.
    assert.deepEqual([...new Set(started(fixture).map((p) => p.name))].sort(), ["docker", "git", "sandcastle"], "the view started what the check looks for");
    exit.act(view);
    const ended = await view.ended(exit.name, 10_000);
    assert.ok(exit.status.includes(ended.status), `ended ${ended.status}, expected ${exit.status.join(" or ")}`);
    assert.equal(settledTty(ended.after), settledTty(ended.before), "tty state not restored on exit");
    const out = view.output();
    for (const seq of LEFT) assert.ok(out.lastIndexOf(seq) > out.lastIndexOf("\x1b[H"), `${JSON.stringify(seq)} not written after the last frame`);
    assert.deepEqual(await orphans(fixture), [], "processes the view started are still running");
  });
}

test("a Ctrl-C byte stops a view with a command in flight, and leaves nothing running", needsScript, async () => {
  // The byte reaches the whole foreground group, so the command in flight is signalled by the terminal, as at a keyboard.
  hang(fixture, "docker");
  const view = await open();
  await until("docker in flight", () => (started(fixture).some((p) => p.name === "docker") ? true : undefined));
  view.send("\x03");
  const ended = await view.ended("Ctrl-C", 10_000);
  assert.equal(ended.status, 130);
  assert.deepEqual(await orphans(fixture), []);
});

for (const [name, status] of [["INT", [130]], ["TERM", [130]], ["HUP", [129, 130]]] as const) {
  test(`${name} stops a view with a command in flight, and leaves nothing running`, { skip: inFlight.skip || needsScript.skip }, async () => {
    // Sent to the view alone, as `kill` or Herdr does: the command in flight is not signalled by the terminal.
    hang(fixture, "docker");
    const view = await open();
    await until("docker in flight", () => (started(fixture).some((p) => p.name === "docker") ? true : undefined));
    view.signal(`SIG${name}`);
    const ended = await view.ended(name, 10_000);
    assert.ok(status.some((s) => s === ended.status), `ended ${ended.status}`);
    assert.deepEqual(await orphans(fixture), []);
  });
}

// ---------------------------------------------------------------------------
// Keys in the Herdr plugin's popup, which only closes when the view does.
// ---------------------------------------------------------------------------

test("in the popup an arrow key redraws and keeps the view open, then q closes it", needsScript, async () => {
  const view = await open({ env: { SANDCASTLE_STATUS_KEYS: "1" } });
  const first = await view.frame();
  // An arrow is Esc and two more bytes sent at once; Esc alone would close the view.
  view.send("\x1b[A");
  const again = await view.frame(first.end, undefined, 10_000);
  view.send("q");
  assert.equal((await view.ended("q after an arrow")).status, 0);
  assert.ok(again.end > first.end);
});

test("in the popup Q closes the view as q does", needsScript, async () => {
  const view = await open({ env: { SANDCASTLE_STATUS_KEYS: "1" } });
  await view.frame();
  view.send("Q");
  assert.equal((await view.ended("Q")).status, 0);
});

// ---------------------------------------------------------------------------
// The pane's size.
// ---------------------------------------------------------------------------

test("a resize redraws the frame at the new width at once, not at the next interval", needsScript, async () => {
  const view = await open({ cols: 100 });
  const first = await view.frame();
  assert.equal(widthOf(first), 100);
  view.resize(40, 70);
  // The interval is 30 s: only the resize can have drawn it.
  const narrow = await view.frame(first.end, (f) => widthOf(f) === 70, 15_000);
  for (const line of narrow.text.split("\n")) assert.ok([...line].length <= 70, `wider than the pane: ${line}`);
  view.resize(60, 120);
  const wide = await view.frame(narrow.end, (f) => widthOf(f) === 120, 15_000);
  assert.ok(wide.end > narrow.end);
});

test("a resize that lands while a frame is being drawn is not lost", needsScript, async () => {
  // The first docker call stays out until the pane has been resized: the frame in progress was started at the old size.
  hang(fixture, "docker");
  const view = await open({ cols: 100 });
  await until("docker in flight", () => (started(fixture).some((p) => p.name === "docker") ? true : undefined));
  view.resize(40, 70);
  await release(fixture);
  const frame = await view.frame(0, (f) => widthOf(f) === 70, 15_000);
  assert.match(frame.text, /fixture/);
});

// ---------------------------------------------------------------------------
// Instant redraws: the view draws from its snapshot and never waits on a source (#706). Timed from outside, with
// room for a loaded CI machine; the numbers each test saw are in its failure message.
// ---------------------------------------------------------------------------

// The bash loop reads every source for each frame: no tick, no debounce. These hold the TypeScript view.
const instant = { skip: impl() === "bash" ? "status.sh reads every source for each frame" : needsScript.skip };

/** Every frame painted from now on, with when it arrived (ms, performance.now()): polled every few ms until `stop()`. */
const watch = (view: Session) => {
  const seen: { at: number; frame: Painted }[] = [];
  let from = view.output().length;
  const timer = setInterval(() => {
    for (const frame of view.frames(from)) {
      seen.push({ at: performance.now(), frame });
      from = frame.end;
    }
  }, 5);
  return { seen, stop: () => clearInterval(timer) };
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** How many processes the fakes have logged so far. */
const logged = () => readFileSync(fixture.pids, "utf8").split("\n").filter(Boolean).length;
/** Waits until every source has answered and nothing more is being started: the fakes' log still for `ms`. */
const settled = async (view: Session, ms = 700) => {
  await view.frame(0, (f) => !f.text.includes("loading…"));
  let count = logged();
  let since = performance.now();
  await until("the collectors to go quiet", () => {
    if (logged() !== count) [count, since] = [logged(), performance.now()];
    return performance.now() - since >= ms ? true : undefined;
  });
};

test("the first paint comes at once, saying the queue is loading while it hangs", instant, async () => {
  hang(fixture, "sandcastle");
  const t0 = performance.now();
  const view = await open({ args: ["30"] });
  const first = await view.frame();
  const took = performance.now() - t0;
  assert.match(first.text, /queue: loading…/);
  assert.match(first.text, /fixture/, "the project's frame");
  // 500 ms asked; the view's own start (node and its imports) is in this figure, and a loaded runner is slower.
  assert.ok(took < 1500, `first paint ${Math.round(took)} ms after the view started`);
  await release(fixture);
  const full = await view.frame(first.end, (f) => !f.text.includes("queue: loading…"), 15_000);
  assert.ok(full.end > first.end);
});

test("a drag of the pane ends in one repaint, at the final size, soon after the last resize", instant, async () => {
  const view = await open({ args: ["30"], cols: 100 });
  await settled(view);
  const frames = watch(view);
  let last = 0;
  for (const cols of [90, 80, 70]) {
    if (last) await pause(40);
    view.resize(40, cols);
    last = performance.now();
  }
  try {
    const final = await until("the repaint at 70 columns", () => frames.seen.find((f) => widthOf(f.frame) === 70));
    const took = final.at - last;
    // 300 ms asked: the pane is still for 150 ms, then a paint from the snapshot.
    assert.ok(took < 600, `repainted ${Math.round(took)} ms after the last resize`);
    await pause(300);
    const widths = frames.seen.map((f) => widthOf(f.frame));
    assert.deepEqual([...new Set(widths)], [70], `frames painted during and after the drag: ${widths.join(", ")}`);
  } finally {
    frames.stop();
  }
});

test("a tick redraws every second, on time, while docker and the queue hang", instant, async () => {
  hang(fixture, "docker");
  hang(fixture, "sandcastle");
  // Collecting every second too: the record, git and the pool are asked again while docker and the queue hang.
  const view = await open({ args: ["1"] });
  await view.frame(0, (f) => f.text.includes("queue: loading…"));
  await pause(1500);
  const frames = watch(view);
  await pause(4300);
  frames.stop();
  assert.ok(view.frames().every((f) => f.text.includes("queue: loading…")), "the queue answered: it was meant to hang");
  const at = frames.seen.map((f) => f.at);
  const gaps = at.slice(1).map((t, i) => Math.round(t - at[i]!));
  assert.ok(at.length >= 4, `${at.length} paints in 4.3 s: ${gaps.join(", ")} ms apart`);
  // Within 200 ms of time: each tick a second after the one before.
  for (const gap of gaps) assert.ok(gap >= 800 && gap <= 1200, `ticks ${gaps.join(", ")} ms apart`);
});

test("a tick and a resize repaint start no docker, gh, git or sandcastle", instant, async () => {
  // The interval is 30 s: once the collectors have answered, nothing is due to collect while this runs.
  const view = await open({ args: ["30"], cols: 100 });
  await settled(view);
  const before = logged();
  const frames = watch(view);
  await pause(2200);
  view.resize(40, 80);
  await until("the repaint at 80 columns", () => frames.seen.find((f) => widthOf(f.frame) === 80));
  frames.stop();
  assert.ok(frames.seen.length >= 3, `${frames.seen.length} paints: two ticks and the resize's were expected`);
  const after = readFileSync(fixture.pids, "utf8").split("\n").filter(Boolean).slice(before);
  assert.deepEqual(after, [], "processes started by a tick or a resize");
});

for (const exit of EXITS) {
  test(`${exit.name} with docker and the queue mid-refresh leaves nothing running`, instant, async () => {
    hang(fixture, "docker");
    hang(fixture, "sandcastle");
    const view = await open({ env: exit.popup ? { SANDCASTLE_STATUS_KEYS: "1" } : {} });
    await view.frame();
    await until("docker and the queue in flight", () => {
      const names = started(fixture).map((p) => p.name);
      return names.includes("docker") && names.includes("sandcastle") ? true : undefined;
    });
    exit.act(view);
    const ended = await view.ended(exit.name, 10_000);
    assert.ok(exit.status.includes(ended.status), `ended ${ended.status}, expected ${exit.status.join(" or ")}`);
    assert.deepEqual(await orphans(fixture), [], "processes the view started are still running");
  });
}
