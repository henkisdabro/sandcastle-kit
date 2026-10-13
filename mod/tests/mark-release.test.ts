// Run with `claude plugin test mod`: `/sandcastle-mark dismiss` and the release `N out` names - quieted
// until a newer one is tagged, apart from the dismissed ready ids - with the clock, the process runner
// and the store answered by the test. No session, no model, no tracker.

import { expect, mock, test, type TestBody } from "claude-code/testing";

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const entry = (ageMin: number, ids: string[]) => ({ at: T0 - ageMin * MIN, ids, ok: true, tried: T0 - ageMin * MIN });
const versions = (newest: string, pendingNotes: string[] = []) => ({
  at: T0 - MIN,
  ok: true,
  tried: T0 - MIN,
  facts: {
    kit: { version: "0.17.0", release: "0.17.0", past: 0 },
    newestRelease: { release: newest, checkedAt: new Date(T0 - 5 * MIN).toISOString() },
    project: { recorded: true, release: "0.17.0", pendingNotes },
  },
});
const RESULT = { stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
const START = { surface: "terminal", isInteractive: true, cwd: "/work" } as const;
const MARK = (args: string) => ({ command: "sandcastle-mark", args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } }) as const;
const READY_KEY = "ready:/work";
const VERSION_KEY = "version:/work";
const MARK_KEY = "mark:/work";

const BAND = {
  plugin: "sandcastle",
  component: "AbovePrompt",
  requestId: "band",
  viewport: { columns: 120, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const;

/** The idle mark the band draws now - its parts' text joined by a space - or undefined. With no run alive the row's icon leads. */
const markNow = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  // The fake of Claude Code's own prompt area draws one Text too.
  const rows = (await ui.findAll({ type: "Text" })).filter((r) => r.text !== "drawn by Claude Code");
  await ui.unmount();
  const [icon, ...parts] = rows;
  return icon?.text === "♜" ? parts.map((r) => String(r.text)).join(" ") : undefined;
};

const world = (on: Parameters<TestBody>[1], ids: string[], newest: string, notes: string[] = [], store: Record<string, unknown> = {}) => {
  const w = {
    clock: mock.clock(on, { now: T0 }),
    store: new Map<string, unknown>(Object.entries({ [READY_KEY]: entry(1, ids), [VERSION_KEY]: versions(newest, notes), ...store })),
  };
  on("session.start", () => ({ cwd: "/work" }));
  on("classic.SessionStart", () => ({}));
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "session-1" }));
  on("fs.exists", () => ({ value: true }));
  on("fs.stat", () => ({ value: { kind: "file", size: 1, mtimeMs: 0, isLink: false } }));
  on("fs.read", () => ({ value: JSON.stringify({ orchestrator: "demo", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", tickets: { 1: { state: "merged" } }, finishedAt: "2026-01-01T01:00:00.000Z", exitCode: 0 }) }));
  on("process.run", ($, e) => ({ value: { exitCode: e.argv[0] === "ps" ? 1 : 0, stdout: "", ...RESULT } }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("store.get", ($, e) => ({ value: w.store.get(e.key) }));
  on("store.set", ($, e) => (w.store.set(e.key, e.value), { value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.status", () => ({ value: undefined }));
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("skill.prompt", ($, e) => ({ text: e.text }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
  return w;
};

test("dismiss quiets a release that is out until a newer one is tagged; a new ticket does not bring it back", async ($, on) => {
  const w = world(on, ["1", "2"], "0.18.0");
  await $.session.start(START);
  expect(await markNow($)).toBe("sandcastle 0.17.0 · 2 ready · 0.18.0 out - /sandcastle update");
  const out = await $.command.run(MARK("dismiss"));
  expect(out.text).toMatch(/^Dismissed: the count stays quiet until a ticket not ready now becomes ready\. The 0\.18\.0 release stays quiet until a newer one is tagged\.\n/);
  expect(out.text).toMatch(/\nIdle mark: shown without a count: dismissed until a new ticket becomes ready, and release 0\.18\.0 dismissed until a newer one is tagged/);
  expect(await markNow($)).toBe("sandcastle 0.17.0");
  expect(w.store.get(MARK_KEY)).toEqual({ hidden: false, dismissed: ["1", "2"], dismissedRelease: "0.18.0" });
  // A third ticket is ready: the count is back, the release stays quiet, and the stored release is kept.
  w.store.set(READY_KEY, entry(0, ["1", "2", "3"]));
  await w.clock.advance(15000);
  expect(await markNow($)).toBe("sandcastle 0.17.0 · 3 ready - /sandcastle run");
  expect(w.store.get(MARK_KEY)).toEqual({ hidden: false, dismissedRelease: "0.18.0" });
});

test("a newer release brings the hint back and leaves a dismissed count quiet", async ($, on) => {
  const w = world(on, ["1", "2"], "0.18.0");
  await $.session.start(START);
  await $.command.run(MARK("dismiss"));
  w.store.set(VERSION_KEY, versions("0.19.0"));
  await w.clock.advance(15000);
  expect(await markNow($)).toBe("sandcastle 0.17.0 · 0.19.0 out - /sandcastle update");
  expect(w.store.get(MARK_KEY)).toEqual({ hidden: false, dismissed: ["1", "2"], dismissedRelease: "0.18.0" });
});

test("dismissing a newer release with Upgrading notes pending shows update needed", async ($, on) => {
  world(on, ["1"], "0.18.0", ["A new default."]);
  await $.session.start(START);
  await $.command.run(MARK("dismiss"));
  expect(await markNow($)).toBe("sandcastle 0.17.0 · update needed - /sandcastle update");
});

test("show clears the dismissed release too; a choice from before the release was kept still parses", async ($, on) => {
  const w = world(on, ["1"], "0.18.0");
  await $.session.start(START);
  await $.command.run(MARK("dismiss"));
  expect((await $.command.run(MARK("show"))).text).toMatch(/^Shown\.\nIdle mark: shown\./);
  expect(w.store.get(MARK_KEY)).toEqual({ hidden: false });
  expect(await markNow($)).toBe("sandcastle 0.17.0 · 1 ready · 0.18.0 out - /sandcastle update");
});

test("a stored choice of today's form still holds its dismissal", async ($, on) => {
  world(on, ["1"], "0.18.0", [], { [MARK_KEY]: { hidden: false, dismissed: ["1"] } });
  await $.session.start(START);
  expect(await markNow($)).toBe("sandcastle 0.17.0 · 0.18.0 out - /sandcastle update");
});
