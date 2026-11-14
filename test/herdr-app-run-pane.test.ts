// A run in the Herdr app opens the mod pane in place of the terminal status view (#959), through injected `hc` and
// app ports: no app, no core. In the app (the caller's `herdr.*` labels and a pane in the window) with the mod current,
// the mod pane splits beside the caller and the status terminal runs as the caller's sub-agent with no pane; anything
// short of that - not in the app, the mod missing or stale, the split failing - opens the terminal view as before.
//
//   pnpm test:file test/herdr-app-run-pane.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

const { coreStatusLine, coreViewRecord, openCoreStatus, readCoreView } = await import("../src/herdr-core.ts");
const { modPanesIn, paneIn } = await import("../src/herdr-app.ts");
type AppPorts = import("../src/herdr-app.ts").AppPorts;
type ModPane = import("../src/herdr-app.ts").ModPane;

const project = () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-app-pane-"))), "repo");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  return root;
};

// An hc with no terminals: every `get` is not found, `run` starts t9 (or fails with `runFails`).
const fakeHc = (runFails = false) => {
  const calls: string[][] = [];
  const hc = (args: string[]) => {
    calls.push(args);
    if (args[0] === "get") throw new Error("not_found");
    if (args[0] === "run") {
      if (runFails) throw new Error("hc is down");
      return JSON.stringify({ address: "t9" });
    }
    return "{}";
  };
  return { hc, calls, run: () => calls.find((c) => c[0] === "run")! };
};

type Calls = { modCurrent: number; paneOf: string[]; split: [string, object][]; close: string[]; focus: string[] };
type Fake = {
  current?: boolean;
  pane?: string;
  /** The pane that has the keyboard before the split. */
  focused?: string;
  /** The `sandcastle` mod panes in the layout before the run. */
  layout?: ModPane[];
  /** The split fails having made no pane; `lost`: it made one and its answer was lost; `twice`: it made two. */
  split?: "fails" | "lost" | "twice" | "crowded";
  layoutUnreadable?: boolean;
  closeThrows?: boolean;
  modCurrentThrows?: boolean;
};
const fakeApp = (o: Fake = {}) => {
  const calls: Calls = { modCurrent: 0, paneOf: [], split: [], close: [], focus: [] };
  const layout: ModPane[] = [...(o.layout ?? [])];
  const app: AppPorts = {
    modCurrent() {
      calls.modCurrent++;
      if (o.modCurrentThrows) throw new Error("ENOENT: herdr-app/main.js");
      return o.current ?? true;
    },
    paneOf: (t) => (calls.paneOf.push(t), "pane" in o ? o.pane : "p-caller"),
    focused: () => o.focused,
    modPanes() {
      if (o.layoutUnreadable) throw new Error("hc is down");
      return layout.map((p) => ({ ...p }));
    },
    split(pane, props) {
      calls.split.push([pane, props]);
      const project = (props as { project: string }).project;
      if (o.split === "fails") throw new Error("no such mod");
      layout.push({ pane: "p-mod", project, run: (props as { run: string }).run });
      if (o.split === "twice") layout.push({ pane: "p-mod2", project, run: (props as { run: string }).run });
      // A person's log pane and status pane, and another run's pane, appear while the split's answer is lost.
      if (o.split === "crowded") layout.push({ pane: "p-log", project }, { pane: "p-by-hand", project }, { pane: "p-other-run", project, run: "other" });
      if (o.split) throw new Error("timed out");
      return "p-mod";
    },
    close(pane) {
      calls.close.push(pane);
      if (o.closeThrows) throw new Error("no window");
      layout.splice(layout.findIndex((p) => p.pane === pane), 1);
    },
    focus: (pane) => void calls.focus.push(pane),
  };
  return { app, calls, layout };
};
const untouched = { modCurrent: 0, paneOf: [], split: [], close: [], focus: [] };

const inApp = { address: "t-mine", pid: 1, labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } };
const labelsOf = (run: string[]) => run.flatMap((a, i) => (run[i - 1] === "--label" ? [a] : []));

test("in the app with the mod current: the mod pane beside the caller, the status terminal its sub-agent with no pane", async () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app, calls } = fakeApp();
  const { result, lines } = await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc, instance: "i1", app }));
  assert.equal(result, "t9");
  assert.deepEqual(lines, []);
  assert.deepEqual(calls.paneOf, ["t-mine"]);
  assert.deepEqual(calls.split, [["p-caller", { project: root, command: ["/k/bin/sandcastle", "status", "--json", "--frame"], run: "i1" }]]);
  assert.equal(run()[run().indexOf("--parent") + 1], "t-mine");
  assert.ok(!labelsOf(run()).some((l) => l.startsWith("herdr.")), run().join(" "));
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t9", slots: [], pane: "p-mod", caller: "t-mine", pid: process.pid });
  assert.equal(coreStatusLine(root, "t9"), "Status view: app pane p-mod (terminal t9)");
});

const terminalView = (root: string, run: string[]) => {
  assert.ok(!run.includes("--parent"), run.join(" "));
  assert.deepEqual(labelsOf(run).filter((l) => l.startsWith("herdr.")), ["herdr.space=sp1", "herdr.tab=tb1"]);
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t9", slots: [], caller: "t-mine", pid: process.pid });
  assert.equal(coreStatusLine(root, "t9"), "Status view: terminal t9");
};

test("a caller outside the app (no herdr.* labels) opens the terminal view and never asks the app", () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app, calls } = fakeApp();
  assert.equal(openCoreStatus(root, { address: "t-mine", pid: 1, labels: {} }, { kit: "/k", hc, instance: "i1", app }), "t9");
  assert.deepEqual(calls, untouched);
  assert.ok(!run().includes("--parent"));
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t9", slots: [], caller: "t-mine", pid: process.pid });
});

test("the mod not current (missing, foreign or stale: doctor not ok) opens the terminal view", () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app, calls } = fakeApp({ current: false });
  openCoreStatus(root, inApp, { kit: "/k", hc, instance: "i1", app });
  assert.deepEqual(calls.split, []);
  terminalView(root, run());
});

test("no pane for the caller in a running window (no window, or a sub-agent) opens the terminal view", () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app, calls } = fakeApp({ pane: undefined });
  openCoreStatus(root, inApp, { kit: "/k", hc, instance: "i1", app });
  assert.deepEqual(calls.split, []);
  terminalView(root, run());
});

test("a mod pane that fails to open says so in one line and opens the terminal view", async () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app } = fakeApp({ split: "fails" });
  const { result, lines } = await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc, instance: "i1", app }));
  assert.equal(result, "t9");
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /Could not open the Herdr app pane \(no such mod\): the terminal status view opens instead/);
  terminalView(root, run());
});

test("a status terminal that fails to start closes the mod pane this call opened", async () => {
  const root = project();
  const { hc } = fakeHc(true);
  const { app, calls } = fakeApp();
  const { result } = await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc, instance: "i1", app }));
  assert.equal(result, undefined);
  assert.deepEqual(calls.close, ["p-mod"]);
});

test("the next run closes the mod pane an earlier run recorded; the same run's next turn keeps its own", async () => {
  const root = project();
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "old", status: "t3", slots: [], pane: "p-old" }));
  const next = fakeApp({ layout: [{ pane: "p-old", project: root }] });
  await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app: next.app }));
  assert.deepEqual(next.calls.close, ["p-old"]);
  assert.equal(readCoreView(root)?.pane, "p-mod");

  // The next turn finds its own status terminal still running the view, and opens nothing.
  const turn = fakeApp();
  const live = (args: string[]) => (args[0] === "get" ? JSON.stringify({ address: "t9", state: "live", foreground: { argv: ["node", "/k/src/cli.ts", "status"] } }) : "{}");
  assert.equal(openCoreStatus(root, inApp, { kit: "/k", hc: live, instance: "i1", app: turn.app }), "t9");
  assert.deepEqual(turn.calls, untouched);
  assert.equal(readCoreView(root)?.pane, "p-mod");
});

// The same run's status terminal gone (its program died, or hc could not say): the start falls through and opens a
// fresh view, and the pane its first turn opened must not be left beside the new one with nothing recording it.
test("a fall-through of the same run closes the pane it recorded before splitting a new one", async () => {
  const root = project();
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "i1", status: "t3", slots: [], pane: "p-first" }));
  const { app, calls, layout } = fakeApp({ layout: [{ pane: "p-first", project: root }] });
  await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app }));
  assert.deepEqual(calls.close, ["p-first"]);
  assert.deepEqual(layout.map((p) => p.pane), ["p-mod"]);
  assert.equal(readCoreView(root)?.pane, "p-mod");
});

test("a recorded pane that will not close does not stop the start", async () => {
  const root = project();
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "old", status: "t3", slots: [], pane: "p-old" }));
  const { app, calls } = fakeApp({ layout: [{ pane: "p-old", project: root }], closeThrows: true });
  const { result, lines } = await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app }));
  assert.equal(result, "t9");
  assert.deepEqual(lines, []);
  assert.deepEqual(calls.close, ["p-old"]);
  assert.equal(readCoreView(root)?.pane, "p-mod");
});

// The record holds a bare id: closed only while the app's layout shows it as this project's sandcastle mod pane.
for (const [why, layout, unreadable] of [
  ["gone from the layout", [{ pane: "p-other", project: "/elsewhere" }], false],
  ["another project's", [{ pane: "p-old", project: "/elsewhere" }], false],
  ["not a sandcastle pane, or no props", [{ pane: "p-old" }], false],
  ["in a layout that cannot be read", [{ pane: "p-old", project: "" }], true],
] as const) {
  test(`a recorded pane ${why} is left alone`, async () => {
    const root = project();
    writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "old", status: "t3", slots: [], pane: "p-old" }));
    const { app, calls } = fakeApp({ layout: layout.map((p) => ({ ...p })), layoutUnreadable: unreadable });
    await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app }));
    assert.deepEqual(calls.close, []);
  });
}

test("a split whose answer was lost adopts the one pane it made", async () => {
  const root = project();
  const { app, calls } = fakeApp({ split: "lost" });
  const { result, lines } = await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app }));
  assert.equal(result, "t9");
  assert.deepEqual(lines, []);
  assert.deepEqual(calls.close, []);
  assert.equal(readCoreView(root)?.pane, "p-mod");
});

test("a lost split that made more than one pane closes them all and opens the terminal view", async () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app, calls, layout } = fakeApp({ split: "twice", layout: [{ pane: "p-theirs", project: root }] });
  const { lines } = await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc, instance: "i1", app }));
  assert.deepEqual(calls.close, ["p-mod", "p-mod2"]);
  assert.deepEqual(layout.map((p) => p.pane), ["p-theirs"], "a pane that was there before is not this split's");
  assert.equal(lines.length, 1);
  terminalView(root, run());
});

test("a failed split with the layout unreadable falls back without closing anything", async () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app, calls } = fakeApp({ split: "lost", layoutUnreadable: true });
  await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc, instance: "i1", app }));
  assert.deepEqual(calls.close, []);
  terminalView(root, run());
});

test("the keyboard goes back to the pane that had it before the split, whichever that was", async () => {
  const elsewhere = fakeApp({ focused: "p-another-tab" });
  await quietly(() => openCoreStatus(project(), inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app: elsewhere.app }));
  assert.deepEqual(elsewhere.calls.focus, ["p-another-tab"]);
});

// `herdr-app status` failed, timed out or named no pane: the keyboard goes to the caller's pane, as before #966.
test("with no focused pane to give back, the keyboard goes to the caller's pane", async () => {
  const none = fakeApp({ focused: undefined });
  await quietly(() => openCoreStatus(project(), inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app: none.app }));
  assert.deepEqual(none.calls.focus, ["p-caller"]);
});

// A split the app completed after its answer timed out is recorded nowhere. The run lock means one run owns the
// project, so every pane a run opened for it but the one on record is a stray; a person's own pane has no `run`.
test("a start closes this project's run panes the record does not name, and leaves a person's and another project's", async () => {
  const root = project();
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "old", status: "t3", slots: [], pane: "p-old" }));
  const { app, calls, layout } = fakeApp({
    layout: [
      { pane: "p-old", project: root, run: "old" },
      { pane: "p-late", project: root, run: "old" },
      { pane: "p-by-hand", project: root },
      { pane: "p-other", project: "/elsewhere", run: "old" },
    ],
  });
  await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app }));
  assert.deepEqual(calls.close.sort(), ["p-late", "p-old"]);
  assert.deepEqual(layout.map((p) => p.pane), ["p-by-hand", "p-other", "p-mod"]);
});

test("the same run's next turn keeps its own pane and closes a stray beside it", async () => {
  const root = project();
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "i1", status: "t9", slots: [], pane: "p-mine" }));
  const { app, calls } = fakeApp({ layout: [{ pane: "p-mine", project: root, run: "old" }, { pane: "p-late", project: root, run: "old" }] });
  const live = (args: string[]) => (args[0] === "get" ? JSON.stringify({ address: "t9", state: "live", foreground: { argv: ["node", "/k/src/cli.ts", "status"] } }) : "{}");
  assert.equal(openCoreStatus(root, inApp, { kit: "/k", hc: live, instance: "i1", app }), "t9");
  assert.deepEqual(calls.close, ["p-late"]);
  assert.deepEqual(calls.split, []);
});

test("an unreadable layout closes no stray", async () => {
  const root = project();
  const { app, calls } = fakeApp({ layoutUnreadable: true });
  await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app }));
  assert.deepEqual(calls.close, []);
});

test("modPanesIn reads the sandcastle mod panes and their projects from the core's layout document", () => {
  const doc = {
    spaces: [
      {
        id: "sp1",
        tabs: [
          {
            id: "tb1",
            root: {
              type: "row",
              id: "tb1",
              children: [
                { type: "block", id: "p1", content: { terminal: "t1" } },
                { type: "block", id: "p2", content: { mod: "sandcastle", props: { project: "/a", run: "i1" } } },
                { type: "column", id: "c1", children: [{ type: "block", id: "p3", content: { mod: "files", props: { project: "/a" } } }, { type: "block", id: "p4", content: { mod: "sandcastle" } }] },
              ],
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(modPanesIn(doc), [{ pane: "p2", project: "/a", run: "i1" }, { pane: "p4" }]);
  assert.deepEqual(modPanesIn(null), []);
});

test("paneIn finds a terminal's pane on this machine only: a remote space's ids are another core's", () => {
  const listed = {
    spaces: [
      { machine: "xps", tabs: [{ terminals: [{ terminal: "t7", pane: "xps/p1" }] }] },
      { machine: null, tabs: [{ terminals: [{ terminal: "t8", pane: "p2" }, { terminal: "t7", pane: "p3" }] }] },
    ],
  };
  assert.equal(paneIn(listed, "t7"), "p3");
  assert.equal(paneIn(listed, "t9"), undefined);
});

// A lost split's panes are told by this instance's `run` prop: a person's log or status pane, or another run's,
// that appeared meanwhile is neither adopted nor closed.
test("a lost split adopts only a pane carrying this run's instance, never a person's or another run's", async () => {
  const root = project();
  const { app, calls, layout } = fakeApp({ split: "crowded" });
  const { result, lines } = await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app }));
  assert.equal(result, "t9");
  assert.deepEqual(lines, []);
  assert.deepEqual(calls.close, []);
  assert.equal(readCoreView(root)?.pane, "p-mod");
  assert.deepEqual(layout.map((p) => p.pane).sort(), ["p-by-hand", "p-log", "p-mod", "p-other-run"]);
});

// The kit pulled mid-run: reading its herdr-app/ files throws. The run still starts, with the terminal view.
test("a mod check that throws counts as not current: the start opens the terminal view and does not fail", async () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app, calls } = fakeApp({ modCurrentThrows: true });
  const { result } = await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc, instance: "i1", app }));
  assert.equal(result, "t9");
  assert.deepEqual(calls.split, []);
  terminalView(root, run());
});
