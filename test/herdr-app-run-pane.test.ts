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
const { paneIn } = await import("../src/herdr-app.ts");
type AppPorts = import("../src/herdr-app.ts").AppPorts;

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

type Calls = { modCurrent: number; paneOf: string[]; split: [string, object][]; close: string[] };
const fakeApp = (o: { current?: boolean; pane?: string; splitFails?: boolean } = {}) => {
  const calls: Calls = { modCurrent: 0, paneOf: [], split: [], close: [] };
  const app: AppPorts = {
    modCurrent: () => (calls.modCurrent++, o.current ?? true),
    paneOf: (t) => (calls.paneOf.push(t), "pane" in o ? o.pane : "p-caller"),
    split(pane, props) {
      calls.split.push([pane, props]);
      if (o.splitFails) throw new Error("no such mod");
      return "p-mod";
    },
    close: (pane) => void calls.close.push(pane),
  };
  return { app, calls };
};

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
  assert.deepEqual(calls.split, [["p-caller", { project: root, command: ["/k/bin/sandcastle", "status", "--json", "--frame"] }]]);
  assert.equal(run()[run().indexOf("--parent") + 1], "t-mine");
  assert.ok(!labelsOf(run()).some((l) => l.startsWith("herdr.")), run().join(" "));
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t9", slots: [], pane: "p-mod" });
  assert.equal(coreStatusLine(root, "t9"), "Status view: app pane p-mod (terminal t9)");
});

const terminalView = (root: string, run: string[]) => {
  assert.ok(!run.includes("--parent"), run.join(" "));
  assert.deepEqual(labelsOf(run).filter((l) => l.startsWith("herdr.")), ["herdr.space=sp1", "herdr.tab=tb1"]);
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t9", slots: [] });
  assert.equal(coreStatusLine(root, "t9"), "Status view: terminal t9");
};

test("a caller outside the app (no herdr.* labels) opens the terminal view and never asks the app", () => {
  const root = project();
  const { hc, run } = fakeHc();
  const { app, calls } = fakeApp();
  assert.equal(openCoreStatus(root, { address: "t-mine", pid: 1, labels: {} }, { kit: "/k", hc, instance: "i1", app }), "t9");
  assert.deepEqual(calls, { modCurrent: 0, paneOf: [], split: [], close: [] });
  assert.ok(!run().includes("--parent"));
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t9", slots: [] });
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
  const { app } = fakeApp({ splitFails: true });
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
  const next = fakeApp();
  await quietly(() => openCoreStatus(root, inApp, { kit: "/k", hc: fakeHc().hc, instance: "i1", app: next.app }));
  assert.deepEqual(next.calls.close, ["p-old"]);
  assert.equal(readCoreView(root)?.pane, "p-mod");

  // The next turn finds its own status terminal still running the view, and opens nothing.
  const turn = fakeApp();
  const live = (args: string[]) => (args[0] === "get" ? JSON.stringify({ address: "t9", state: "live", foreground: { argv: ["node", "/k/src/cli.ts", "status"] } }) : "{}");
  assert.equal(openCoreStatus(root, inApp, { kit: "/k", hc: live, instance: "i1", app: turn.app }), "t9");
  assert.deepEqual(turn.calls, { modCurrent: 0, paneOf: [], split: [], close: [] });
  assert.equal(readCoreView(root)?.pane, "p-mod");
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
