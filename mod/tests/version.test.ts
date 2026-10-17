// Run with `claude plugin test mod`: the idle mark's kit version - when the mod reads
// `sandcastle --version --json`, what it shares through the store, how the line is drawn in sand
// and that no read happens while the mark is hidden or the project is not set up - with the clock,
// the process runner and the store answered by the test. No session, no model, no kit.

import { expect, mock, test, type TestBody } from "claude-code/testing";

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const RESULT = { stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
const START = { surface: "terminal", isInteractive: true, cwd: "/work" } as const;
const SKILL = { skill: "sandcastle", text: "the skill" };
const ENDED = { durationMs: 1000, isAborted: false, turnId: "turn-1", reason: "answer" } as const;
const MARK = (args: string) => ({ command: "sandcastle-mark", args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } }) as const;
const READY_KEY = "ready:/work";
const VERSION_KEY = "version:/work";
const MARK_KEY = "mark:/work";
const ready = (ids: string[]) => ({ at: T0 - MIN, ids, ok: true, tried: T0 - MIN });
const queue = (...ids: string[]) => JSON.stringify(ids.map((id) => ({ id, title: `Ticket ${id}`, updated: null, blockedOn: [] })));
const facts = (kit: object, project: object | null, newestRelease: object | null = null) => ({ kit: { version: "0.17.0", release: "0.17.0", past: 0, ...kit }, newestRelease, project });
const SETTLED = { recorded: true, release: "0.17.0", pendingNotes: [] };
const NEEDED = { recorded: false, release: null, pendingNotes: [] };
const BEHIND = { recorded: true, release: "0.16.0", pendingNotes: [] };

/** What a band mounted now asks of the mod: the idle mark is one row of it, drawn when no run is. */
const BAND = {
  plugin: "sandcastle",
  component: "AbovePrompt",
  requestId: "band",
  viewport: { columns: 120, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const;

/** The idle mark's pieces as the band draws them: text, colour and weight. With no run alive the row's icon leads and nothing else is drawn. */
const markNow = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  // The fake of Claude Code's own prompt area draws one Text too.
  const rows = (await ui.findAll({ type: "Text" })).filter((r) => r.text !== "drawn by Claude Code");
  await ui.unmount();
  const [icon, ...parts] = rows;
  return icon?.text === "♜" ? parts.map((r) => ({ text: String(r.text), color: r.props.color, bold: r.props.bold === true })) : undefined;
};
const plain = async ($: Parameters<TestBody>[0]) => (await markNow($))?.map((p) => p.text).join(" ");

/** A set-up project with no run alive, a fresh count, and a `--version --json` the test answers and notes. */
const world = (on: Parameters<TestBody>[1], store: Record<string, unknown> = {}) => {
  const w = {
    clock: mock.clock(on, { now: T0 }),
    // What `--version --json` prints and exits with.
    out: JSON.stringify(facts({}, SETTLED)),
    exit: 0,
    // How long a version read takes, as a slow `git` would.
    slow: 0,
    setUp: true,
    settings: "",
    versionReads: [] as { argv: readonly string[]; cwd?: string; timeoutMs?: number }[],
    queueReads: 0,
    queueOut: queue("1", "2"),
    store: new Map<string, unknown>(Object.entries({ [READY_KEY]: ready(["1", "2"]), ...store })),
  };
  on("session.start", () => ({ cwd: "/work" }));
  on("classic.SessionStart", () => ({}));
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "session-1" }));
  on("fs.exists", () => ({ value: true }));
  on("fs.stat", ($, e) => ({ value: { kind: String(e.path).endsWith("/.sandcastle/config.ts") && !w.setUp ? "dir" : "file", size: 1, mtimeMs: 0, isLink: false, realPath: String(e.path) === "/kit/mod" ? "/kit/mod" : undefined } }));
  on("fs.read", () => ({ value: JSON.stringify({ orchestrator: "demo", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", tickets: { 1: { state: "merged" } }, finishedAt: "2026-01-01T01:00:00.000Z", exitCode: 0 }) }));
  on("process.run", async ($, e) => {
    if (e.argv.includes("--version")) {
      w.versionReads.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs });
      if (w.slow) await w.clock.sleep(w.slow);
      return { value: { exitCode: w.exit, stdout: w.out, ...RESULT } };
    }
    if (e.argv.includes("queue")) {
      w.queueReads += 1;
      return { value: { exitCode: 0, stdout: w.queueOut, ...RESULT } };
    }
    const settings = e.argv[0] === "sh" && String(e.argv[2]).includes("sandcastle-kit/config.json");
    return { value: { exitCode: e.argv[0] === "ps" ? 1 : 0, stdout: settings ? w.settings : "", ...RESULT } };
  });
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("store.get", ($, e) => ({ value: w.store.get(e.key) }));
  on("store.set", ($, e) => (w.store.set(e.key, e.value), { value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.status", () => ({ value: undefined }));
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("skill.prompt", ($, e) => ({ text: e.text }));
  on("turn.complete", ($, e) => ({ text: e.answer }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
  return w;
};

test("the first look reads the version once with the kit's own command in the project, and the next look shows it on the mark", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  await w.clock.settle();
  expect(w.versionReads.length).toBe(1);
  expect(w.versionReads[0]).toEqual({ argv: [expect.stringMatching(/\/bin\/sandcastle$|^sandcastle$/), "--version", "--json"], cwd: "/work", timeoutMs: 20000 });
  expect(w.store.get(VERSION_KEY)).toEqual({ at: T0, facts: facts({}, SETTLED), ok: true, tried: T0 });
  // The draw never waited for the read: the first line has no version; the next look has.
  expect(await plain($)).toBe("sandcastle · 2 ready - /sandcastle run");
  await w.clock.advance(15000);
  expect(await plain($)).toBe("sandcastle 0.17.0 · 2 ready - /sandcastle run");
  expect(w.versionReads.length).toBe(1);
});

test("update needed and a newer release out are drawn bold in the castle's bright sand, never a notice colour, and the project's older release not at all", async ($, on) => {
  const w = world(on, { [VERSION_KEY]: { at: T0 - MIN, facts: facts({}, NEEDED), ok: true, tried: T0 - MIN } });
  await $.session.start(START);
  expect(await markNow($)).toEqual([
    { text: "sandcastle 0.17.0 · 2 ready ·", color: "#cdb894", bold: false },
    { text: "update needed", color: "#e8d6b4", bold: true },
    { text: "- /sandcastle update", color: "#cdb894", bold: false },
  ]);
  w.store.set(VERSION_KEY, { at: T0 - MIN, facts: facts({}, BEHIND, { release: "0.18.0", checkedAt: "2026-10-13T05:12:00.000Z" }), ok: true, tried: T0 - MIN });
  await w.clock.advance(15000);
  expect(await markNow($)).toEqual([
    { text: "sandcastle 0.17.0 · 2 ready ·", color: "#cdb894", bold: false },
    { text: "0.18.0 out", color: "#e8d6b4", bold: true },
    { text: "- /sandcastle update", color: "#cdb894", bold: false },
  ]);
  w.store.set(VERSION_KEY, { at: T0 - MIN, facts: facts({}, BEHIND), ok: true, tried: T0 - MIN });
  await w.clock.advance(15000);
  expect(await markNow($)).toEqual([{ text: "sandcastle 0.17.0 · 2 ready - /sandcastle run", color: "#cdb894", bold: false }]);
});

test("a clone past its release tag shows the release and how far past it", async ($, on) => {
  const w = world(on, { [VERSION_KEY]: { at: T0 - MIN, facts: facts({ release: "0.16.0", version: "0.16.0 +3 (1c4f46f)", past: 3 }, { ...SETTLED, release: "0.16.0" }), ok: true, tried: T0 - MIN } });
  await $.session.start(START);
  await w.clock.settle();
  expect(await plain($)).toBe("sandcastle 0.16.0+3 · 2 ready - /sandcastle run");
});

test("a fresh entry means no read, an old one is read again after ten minutes, and the entry is shared", async ($, on) => {
  const w = world(on, { [VERSION_KEY]: { at: T0 - 3 * MIN, facts: facts({}, SETTLED), ok: true, tried: T0 - 3 * MIN } });
  await $.session.start(START);
  await w.clock.advance(5 * MIN);
  expect(w.versionReads.length).toBe(0);
  expect(await plain($)).toBe("sandcastle 0.17.0 · 2 ready - /sandcastle run");
  await w.clock.advance(5 * MIN);
  expect(w.versionReads.length).toBe(1);
});

test("no read while the mark is hidden in the project, switched off on the machine, or the project is not set up", async ($, on) => {
  const hidden = world(on, { [MARK_KEY]: { hidden: true } });
  await $.session.start(START);
  await hidden.clock.advance(11 * MIN);
  expect(hidden.versionReads.length).toBe(0);
  expect(hidden.queueReads).toBe(0);
  expect(hidden.store.has(VERSION_KEY)).toBe(false);
  expect(await plain($)).toBeUndefined();
  // `show` brings the mark back, and the next look reads.
  await $.command.run(MARK("show"));
  await hidden.clock.advance(15000);
  expect(hidden.versionReads.length).toBe(1);
});

test("no read when the machine switch is off", async ($, on) => {
  const w = world(on);
  w.settings = JSON.stringify({ idleMark: false });
  await $.session.start(START);
  await w.clock.advance(11 * MIN);
  expect(w.versionReads.length).toBe(0);
  expect(w.store.has(VERSION_KEY)).toBe(false);
});

test("no read in a project that is not set up", async ($, on) => {
  const w = world(on);
  w.setUp = false;
  await $.session.start(START);
  await w.clock.advance(11 * MIN);
  expect(w.versionReads.length).toBe(0);
  expect(w.store.has(VERSION_KEY)).toBe(false);
  expect(await markNow($)).toBeUndefined();
});

test("a failed or garbled read keeps the last good facts for an hour and then the mark stands without a version, never an error", async ($, on) => {
  const w = world(on, { [VERSION_KEY]: { at: T0 - 20 * MIN, facts: facts({}, NEEDED), ok: true, tried: T0 - 20 * MIN } });
  w.exit = 1;
  w.out = "sandcastle: not found";
  await $.session.start(START);
  await w.clock.settle();
  expect(w.versionReads.length).toBe(1);
  expect(w.store.get(VERSION_KEY)).toEqual({ at: T0 - 20 * MIN, facts: facts({}, NEEDED), ok: false, tried: T0 });
  expect(await plain($)).toBe("sandcastle 0.17.0 · 2 ready · update needed - /sandcastle update");
  // Output that is no facts is a failed read too.
  w.exit = 0;
  w.out = "[]";
  await w.clock.advance(11 * MIN);
  expect(w.versionReads.length).toBe(2);
  expect(w.store.get(VERSION_KEY)).toMatchObject({ ok: false });
  // 20 minutes old at the start, so the hour is up 40 minutes in.
  await w.clock.advance(31 * MIN);
  expect(await plain($)).toBe("sandcastle · 2 ready - /sandcastle run");
});

test("the end of the skill's turn reads the version again along with the count, though both entries are fresh", async ($, on) => {
  const w = world(on, { [VERSION_KEY]: { at: T0 - MIN, facts: facts({}, NEEDED), ok: true, tried: T0 - MIN } });
  await $.session.start(START);
  await w.clock.advance(15000);
  expect(w.versionReads.length).toBe(0);
  // Using the skill is a trigger, and both reads see it before either consumes it.
  await $.skill.prompt(SKILL);
  await w.clock.advance(15000);
  expect(w.versionReads.length).toBe(1);
  expect(w.queueReads).toBe(1);
  // The skill ran `/sandcastle update`: the project's record changed during the turn.
  w.out = JSON.stringify(facts({}, SETTLED));
  await $.turn.complete({ ...ENDED, answer: "updated" });
  await w.clock.advance(15000);
  expect(w.versionReads.length).toBe(2);
  expect(w.queueReads).toBe(2);
  await w.clock.advance(15000);
  expect(await plain($)).toBe("sandcastle 0.17.0 · 2 ready - /sandcastle run");
});

test("a slow version read holds nothing up: no second read beside it, and a trigger meanwhile earns one more after it", async ($, on) => {
  const w = world(on, { [VERSION_KEY]: { at: T0 - 30 * MIN, facts: facts({}, SETTLED), ok: true, tried: T0 - 30 * MIN } });
  w.slow = 5000;
  await $.session.start(START);
  await w.clock.settle();
  // Looks while the read is out are due too, and add nothing.
  await w.clock.advance(3000);
  expect(w.versionReads.length).toBe(1);
  await $.skill.prompt(SKILL);
  await w.clock.advance(15000);
  expect(w.versionReads.length).toBe(2);
  await w.clock.advance(60000);
  expect(w.versionReads.length).toBe(2);
});

test("a bare /sandcastle-mark reports the full kit version, the recorded release and the pending notes, or that none are held", async ($, on) => {
  const w = world(on, { [VERSION_KEY]: { at: T0 - 4 * MIN, facts: facts({ version: "0.17.0 +3 (1c4f46f, local changes)", past: 3 }, { recorded: true, release: "0.16.0", pendingNotes: ["A new default."] }), ok: true, tried: T0 - 4 * MIN } });
  await $.session.start(START);
  const report = (await $.command.run(MARK(""))).text;
  expect(report).toContain("Kit version: 0.17.0 +3 (1c4f46f, local changes), read 4 min ago.");
  expect(report).toContain("Project's recorded release: 0.16.0.");
  expect(report).toContain("Pending Upgrading notes:\n  - A new default.");
  expect(report).toContain("Newest release: not known");
  w.store.set(VERSION_KEY, { at: T0 - 4 * MIN, facts: facts({}, SETTLED), ok: true, tried: T0 - 4 * MIN });
  expect((await $.command.run(MARK(""))).text).toContain("Pending Upgrading notes: none held.");
  // Hidden, the report still tells the facts held, and reads nothing.
  await $.command.run(MARK("hide"));
  const reads = w.versionReads.length;
  expect((await $.command.run(MARK(""))).text).toMatch(/^Idle mark: hidden in this project[^]*Kit version: 0\.17\.0, read 4 min ago\./);
  expect(w.versionReads.length).toBe(reads);
});
