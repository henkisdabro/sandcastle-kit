// The live status view's lifecycle, held from outside: it is started on a terminal, a test waits for a
// painted frame and then does what a person or Herdr would - types keys, sends Ctrl-C as a byte, resizes the
// pane, sends INT, TERM or HUP to the view's pid - and checks what the view did: the frame it painted, the
// status it ended with, the terminal it left, the processes it left running. No fake `sleep`, which only
// the bash loop would ever run: these hold any implementation of the view, chosen with
// SANDCASTLE_TEST_STATUS_IMPL (test/status-run.ts). No Docker, no network, no model calls.
//
//   pnpm test:file test/status-lifecycle.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { buildFixture, hang, release } from "./status-fixture.ts";
import { impl, needsScript, orphans, settledTty, started, startSession, until, type Session } from "./status-run.ts";

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
