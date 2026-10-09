// Run with `claude plugin test mod`: `/sandcastle-mark` - dismiss, hide, show and the report - with
// the clock, the process runner and the store answered by the test. No session, no model, no tracker.

import { expect, mock, test, type TestBody } from "claude-code/testing";

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const READY = (n: number) => `sandcastle · ${n} ready - /sandcastle run`;
const entry = (ageMin: number, ids: string[]) => ({ at: T0 - ageMin * MIN, ids, ok: true, tried: T0 - ageMin * MIN });
const RESULT = { stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
const START = { surface: "terminal", isInteractive: true, cwd: "/work" } as const;
const MARK = (args: string) => ({ command: "sandcastle-mark", args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } }) as const;
const READY_KEY = "ready:/work";
const MARK_KEY = "mark:/work";

/** What a band mounted now asks of the mod: the idle mark is one row of it, drawn when no run is. */
const BAND = {
  plugin: "sandcastle",
  component: "AbovePrompt",
  requestId: "band",
  viewport: { columns: 120, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const;

/** The idle mark the band draws now - its one row's text - or undefined. */
const markNow = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  // The castle band has a "sandcastle" wordmark of its own, in lighter sand and bold: the mark is told by its colour.
  const row = (await ui.findAll({ type: "Text", text: /^sandcastle/ })).find((r) => r.props.color === "#cdb894");
  await ui.unmount();
  return row?.text;
};

/** A set-up project with no run alive, a fresh shared count of `ids`, and every line and prompt noted. */
const world = (on: Parameters<TestBody>[1], ids: string[] = ["1", "2", "3"], store: Record<string, unknown> = {}) => {
  const w = {
    clock: mock.clock(on, { now: T0 }),
    // The personal machine settings, as `cat` prints them; empty is no file.
    settings: "",
    queueReads: 0,
    statuses: [] as (string | undefined)[],
    prompts: [] as string[],
    commands: [] as string[],
    hints: {} as Record<string, string | undefined>,
    store: new Map<string, unknown>(Object.entries({ [READY_KEY]: entry(1, ids), ...store })),
  };
  on("session.start", () => ({ cwd: "/work" }));
  on("classic.SessionStart", () => ({}));
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "session-1" }));
  on("fs.exists", () => ({ value: true }));
  on("fs.stat", () => ({ value: { kind: "file", size: 1, mtimeMs: 0, isLink: false } }));
  on("fs.read", () => ({ value: JSON.stringify({ orchestrator: "demo", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", tickets: { 1: { state: "merged" } }, finishedAt: "2026-01-01T01:00:00.000Z", exitCode: 0 }) }));
  on("process.run", ($, e) => {
    if (e.argv.includes("queue")) w.queueReads += 1;
    const settings = e.argv[0] === "sh" && String(e.argv[2]).includes("sandcastle-kit/config.json");
    // `ps` finds no run process: nothing is alive.
    return { value: { exitCode: e.argv[0] === "ps" ? 1 : 0, stdout: settings ? w.settings : "", ...RESULT } };
  });
  on("command.register", ($, e) => (w.commands.push(e.name), (w.hints[e.name] = e.argumentHint), { value: { command: e.name } }));
  on("store.get", ($, e) => ({ value: w.store.get(e.key) }));
  on("store.set", ($, e) => (w.store.set(e.key, e.value), { value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.status", ($, e) => (w.statuses.push(e.text), { value: undefined }));
  on("prompt.submit", ($, e) => (w.prompts.push(e.text), { text: e.text }));
  on("skill.prompt", ($, e) => ({ text: e.text }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
  return w;
};

test("the command is registered with the status command, once the project has .sandcastle/", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  expect(w.commands).toEqual(["sandcastle-status", "sandcastle-mark"]);
  // The typeahead shows the choices after the name, the same ones the usage line names.
  expect(w.hints["sandcastle-mark"]).toBe("[dismiss|hide|show]");
  expect((await $.command.run(MARK("pause"))).text).toContain(w.hints["sandcastle-mark"]!);
});

test("dismiss takes the count off at once and keeps the mark; the reply is text and no model turn", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  expect(await markNow($)).toBe(READY(3));
  const out = await $.command.run(MARK("dismiss"));
  expect(out.text).toMatch(/^Dismissed: the count stays quiet until a ticket not ready now becomes ready\.\nIdle mark: shown without a count: dismissed/);
  expect(out.text).toMatch(/\nCached count: 3 ready, read 1 min ago\.$/);
  expect(await markNow($)).toBe("sandcastle");
  expect(w.store.get(MARK_KEY)).toEqual({ hidden: false, dismissed: ["1", "2", "3"] });
  expect(w.prompts).toEqual([]);
  // Later looks keep it quiet.
  await w.clock.advance(5 * MIN);
  expect(await markNow($)).toBe("sandcastle");
});

test("a dismissal ends when a ticket not in it becomes ready, and an id leaving does not end it", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  await $.command.run(MARK("dismiss"));
  // One leaves: still quiet.
  w.store.set(READY_KEY, entry(0, ["1", "2"]));
  await w.clock.advance(15000);
  expect(await markNow($)).toBe("sandcastle");
  // A fourth becomes ready: the count is back.
  w.store.set(READY_KEY, entry(0, ["1", "2", "4"]));
  await w.clock.advance(15000);
  expect(await markNow($)).toBe(READY(3));
  expect(w.store.get(MARK_KEY)).toEqual({ hidden: false });
  // Over for good: the first ticket's neighbour leaving and returning does not bring the quiet back.
  w.store.set(READY_KEY, entry(0, ["1", "2"]));
  await w.clock.advance(15000);
  expect(await markNow($)).toBe(READY(2));
});

test("hide turns the mark off in this project, show brings it back and ends a dismissal too", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  await $.command.run(MARK("dismiss"));
  const hidden = await $.command.run(MARK("hide"));
  expect(hidden.text).toMatch(/^Hidden in this project until \/sandcastle-mark show\.\nIdle mark: hidden in this project/);
  expect(await markNow($)).toBeUndefined();
  expect(w.store.get(MARK_KEY)).toEqual({ hidden: true, dismissed: ["1", "2", "3"] });
  await w.clock.advance(5 * MIN);
  expect(await markNow($)).toBeUndefined();
  const shown = await $.command.run(MARK("show"));
  expect(shown.text).toMatch(/^Shown\.\nIdle mark: shown\.\nCached count: 3 ready/);
  expect(await markNow($)).toBe(READY(3));
  expect(w.store.get(MARK_KEY)).toEqual({ hidden: false });
  expect(w.prompts).toEqual([]);
});

test("no argument reports the state, the count and its age; the machine switch is named", async ($, on) => {
  const w = world(on, ["1", "2"]);
  await $.session.start(START);
  w.store.set(READY_KEY, entry(7, ["1", "2"]));
  expect((await $.command.run(MARK(""))).text).toBe("Idle mark: shown.\nCached count: 2 ready, read 7 min ago.");
  w.settings = JSON.stringify({ idleMark: false });
  expect((await $.command.run(MARK(""))).text).toMatch(/^Idle mark: hidden on this machine \("idleMark": false in the personal settings\)\./);
  // A report changes nothing.
  expect(w.store.has(MARK_KEY)).toBe(false);
  // A count too old to show is told from an empty queue.
  w.settings = "";
  w.store.set(READY_KEY, entry(90, ["1", "2"]));
  expect((await $.command.run(MARK(""))).text).toBe("Idle mark: shown.\nCached count: 2 ready, read 1 h 30 min ago; too old to show.");
});

test("an unknown argument gets the usage line and changes nothing", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  for (const args of ["pause", "hide now", "--help"]) {
    expect((await $.command.run(MARK(args))).text).toBe("Usage: /sandcastle-mark [dismiss|hide|show]");
  }
  expect(w.store.has(MARK_KEY)).toBe(false);
  expect(await markNow($)).toBe(READY(3));
});

test("a choice is read back from the store after a reload, and hiding makes no queue read", async ($, on) => {
  const hidden = world(on, ["1"], { [MARK_KEY]: { hidden: true } });
  // Stale, so a shown mark would read the queue: a hidden one does not.
  hidden.store.set(READY_KEY, entry(30, ["1"]));
  await $.session.start(START);
  await hidden.clock.advance(5 * MIN);
  expect(hidden.queueReads).toBe(0);
  expect(await markNow($)).toBeUndefined();
  expect((await $.command.run(MARK(""))).text).toMatch(/^Idle mark: hidden in this project/);
});

test("a dismissal is read back from the store after a reload", async ($, on) => {
  world(on, ["1", "2"], { [MARK_KEY]: { hidden: false, dismissed: ["1", "2", "3"] } });
  await $.session.start(START);
  expect(await markNow($)).toBe("sandcastle");
  expect((await $.command.run(MARK(""))).text).toMatch(/^Idle mark: shown without a count: dismissed/);
});

test("a store entry that is not a choice is ignored", async ($, on) => {
  world(on, ["1", "2"], { [MARK_KEY]: { hidden: "yes" } });
  await $.session.start(START);
  expect(await markNow($)).toBe(READY(2));
});
