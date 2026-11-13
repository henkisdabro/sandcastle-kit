// herdr-core (herdr-core): the run's status view as a core terminal (src/herdr-core.ts). A stub `hc` on PATH logs every
// call's argv, one word per field, and answers from files the test writes; this process is made a core terminal's
// (HC_TERMINAL_ID, which the stub answers with this process's parent as its root pid), so the dispatch in
// `openStatusPane`, `askingInPane` and `openSandboxView` is the real one. No real core, no Herdr.
//
//   pnpm test:file test/herdr-core.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { buildFixture } from "./status-fixture.ts";
import { needsScript, startSession } from "./status-run.ts";
import { quietly } from "./quiet.ts";
import { kitLikeProcess } from "./kit-process.ts";

const stub = mkdtempSync(join(tmpdir(), "sandcastle-hc-stub-"));
const bin = join(stub, "bin");
mkdirSync(bin);
const log = join(stub, "calls.log");
// `get T`: answers/get-T.json, else not found. `keys T`: answers/keys-T.json, when there, becomes T's next answer
// (Ctrl-C turning a view into a shell). `rm T`: T is not found after, by its address or by any name that answers with it. `run`: answers/runs/* one at a time, else answers/run.json, else fails;
// with answers/name-taken, a named slot (paned or a sub-agent) fails as hc does. Every other verb answers `{}`.
writeFileSync(
  join(bin, "hc"),
  `#!/bin/sh
A="${stub}/answers"
{ for w in "$@"; do printf '%s\\037' "$w"; done; echo; } >> '${log}'
case "$1" in
  get) if [ "$2" = t-mine ]; then echo '{"address":"t-mine","pid":${process.ppid},"state":"live","labels":{"herdr.space":"sp1","herdr.tab":"tb1","where":"x"}}'; exit 0; fi
       [ -f "$A/get-$2.json" ] && { cat "$A/get-$2.json"; exit 0; }
       echo '{"error":{"kind":"not_found"}}' >&2; exit 3 ;;
  keys) [ -f "$A/keys-$2.json" ] && cp "$A/keys-$2.json" "$A/get-$2.json"; echo '{}' ;;
  rm) rm -f "$A/get-$2.json"; grep -l "address\\":\\"$2\\"" "$A"/get-*.json 2>/dev/null | while read -r f; do rm -f "$f"; done; echo '{}' ;;
  run) case " $* " in *" --rm "*" --name "*) [ -f "$A/name-taken" ] && { echo '{"error":{"kind":"name_taken"}}' >&2; exit 1; } ;; esac
       f=$(ls "$A/runs" 2>/dev/null | head -n 1); [ -n "$f" ] && { cat "$A/runs/$f"; rm "$A/runs/$f"; exit 0; }
       [ -f "$A/run.json" ] && { cat "$A/run.json"; exit 0; }; echo '{"error":{"message":"core not running"}}' >&2; exit 1 ;;
  *) echo '{}' ;;
esac
`,
);
chmodSync(join(bin, "hc"), 0o755);
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t-mine" });

const { coreRecords, coreViewRecord, needsYouLine, openCoreStatus, openCoreView, projectKey, readCoreView, readSlotState, runRecords, slotAddresses, slotLink, slotName, slotStateFile, statusName, teardown, ticketName, askingInCore } =
  await import("../src/herdr-core.ts");
const { askingInPane, openSandboxView, viewRecord } = await import("../src/herdr.ts");
const { openStatusPane } = await import("../src/run.ts");
const { readRecord, snapshotOf } = await import("../src/status-snapshot.ts");
const { palette, renderFrame } = await import("../src/status-render.ts");
const { ticketRows } = await import("../src/status-rows.ts");
const { tabAwaitsReport } = await import("../src/live-runs.ts");
const { clear, record, windowTitle } = await import("../src/osc7501.ts");

const answers = join(stub, "answers");
const reset = (files: Record<string, unknown> = {}) => {
  rmSync(answers, { recursive: true, force: true });
  mkdirSync(answers);
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(dirname(join(answers, name)), { recursive: true });
    writeFileSync(join(answers, name), JSON.stringify(value));
  }
  writeFileSync(log, "");
};
const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split("\u001f").slice(0, -1));
const verbs = () => calls().map((c) => c[0]).filter((v) => v !== "get");

// Spaces and quotes in both paths: the argv form never quotes, and the one typed line quotes every word.
const project = () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-"))), "my 'odd' repo");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  return root;
};
const KIT = "/the kit's/dir";
const CALLER = { address: "t-mine", pid: 1, labels: { "herdr.space": "sp1", "herdr.tab": "tb1", where: "x" } };
const shellOf = (address: string, key: string, argv = ["/bin/zsh", "-l"]) => ({ address, state: "live", labels: { "sandcastle.root": key }, foreground: { argv } });

test("a fresh status view: argv only, the core flags, the caller's tab and this run's labels, and its record", () => {
  const root = project();
  reset({ "run.json": { address: "t7" } });
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i1" }), "t7");
  const run = calls().find((c) => c[0] === "run");
  assert.deepEqual(run, [
    "run", "--bg", "--json", "--no-notify", "--outlive-parent", "--keep", "--name", statusName(root), "--cwd", root,
    "--label", "herdr.space=sp1", "--label", "herdr.tab=tb1", "--label", `sandcastle.root=${projectKey(root)}`, "--label", "sandcastle.instance=i1",
    "--", "env", "SANDCASTLE_CORE_VIEW=i1", `${KIT}/bin/sandcastle`, "status",
  ]);
  assert.match(statusName(root), /^[a-z0-9_-]{1,32}$/);
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t7", slots: [] });
});

test("a caller with no tab labels starts a hidden view", () => {
  const root = project();
  reset({ "run.json": { address: "t7" } });
  openCoreStatus(root, { ...CALLER, labels: {} }, { kit: KIT, instance: "i1" });
  const run = calls().find((c) => c[0] === "run")!;
  assert.ok(!run.some((w) => w.startsWith("herdr.")));
});

test("the project's status view from an earlier run is stopped, removed and opened afresh by name, with this run's marker", () => {
  const root = project();
  const key = projectKey(root);
  reset({
    [`get-${statusName(root)}.json`]: shellOf("t3", key, ["node", "--import", "x", "/k/src/cli.ts", "status"]),
    "keys-t3.json": shellOf("t3", key),
    "run.json": { address: "t9" },
  });
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "old", status: "t3" }));
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i2" }), "t9");
  assert.deepEqual(verbs(), ["keys", "kill", "rm", "run"]);
  const run = calls().find((c) => c[0] === "run")!;
  assert.equal(run[run.indexOf("--name") + 1], statusName(root));
  assert.deepEqual(run.slice(run.indexOf("--") + 1), ["env", "SANDCASTLE_CORE_VIEW=i2", `${KIT}/bin/sandcastle`, "status"]);
  assert.equal(readCoreView(root)?.instance, "i2");
});

// hc 0.1.19: a `--keep` terminal gives a shell only for a program lost to a signal; an ordinary exit is final.
test("a status terminal left finished (an ordinary exit is final) is removed, and the view opened afresh by its name", () => {
  const root = project();
  const key = projectKey(root);
  reset({
    [`get-${statusName(root)}.json`]: shellOf("t3", key, ["node", "--import", "x", "/k/src/cli.ts", "status"]),
    "keys-t3.json": { address: "t3", state: "finished", labels: { "sandcastle.root": key } },
    "run.json": { address: "t9" },
  });
  const started = Date.now();
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i2" }), "t9");
  assert.ok(Date.now() - started < 2000, "no 5 s wait for a shell that never comes");
  assert.deepEqual(verbs(), ["keys", "rm", "run"]);
  assert.deepEqual(calls().find((c) => c[0] === "rm"), ["rm", "t3", "--json"]);
  const run = calls().find((c) => c[0] === "run")!;
  assert.equal(run[run.indexOf("--name") + 1], statusName(root));
  assert.deepEqual(readCoreView(root), { instance: "i2", status: "t9", slots: [] });
});

test("the status terminal running a person's program keeps it, and its name: this run's view starts unnamed", () => {
  const root = project();
  reset({ [`get-${statusName(root)}.json`]: shellOf("t3", projectKey(root), ["vim", "notes"]), "run.json": { address: "t8" } });
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i2" }), "t8");
  assert.deepEqual(verbs(), ["run"]);
  assert.ok(!calls().find((c) => c[0] === "run")!.includes("--name"));
});

test("a terminal of that name another project labelled is never touched", () => {
  const root = project();
  reset({ [`get-${statusName(root)}.json`]: shellOf("t3", "someoneelse"), "run.json": { address: "t8" } });
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i2" }), "t8");
  assert.deepEqual(verbs(), ["run"]);
});

test("a finished status terminal is removed and its name taken again", () => {
  const root = project();
  reset({ [`get-${statusName(root)}.json`]: { address: "t3", state: "finished" }, "run.json": { address: "t9" } });
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i2" }), "t9");
  assert.deepEqual(verbs(), ["rm", "run"]);
  assert.deepEqual(calls().find((c) => c[0] === "rm"), ["rm", "t3", "--json"]);
  assert.ok(calls().find((c) => c[0] === "run")!.includes("--name"));
});

test("an autonomy run's next turn keeps the view its first turn opened", () => {
  const root = project();
  reset({ "get-t3.json": shellOf("t3", projectKey(root), ["node", "/k/src/cli.ts", "status"]) });
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "i1", status: "t3", slots: [] }));
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i1" }), "t3");
  assert.deepEqual(verbs(), []);
});

test("hc failing opens nothing and says why; a view started before a later failure is ended", async () => {
  const root = project();
  reset();
  const out = await quietly(() => openCoreStatus(root, CALLER, { kit: KIT, instance: "i1" }));
  assert.equal(out.result, undefined);
  assert.match(out.lines.join("\n"), /Could not open the status view in herdr-core \(.*core not running/);
  assert.equal(readCoreView(root), undefined);

  // The record cannot be written (no logs directory): what was started goes.
  const bare = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-"))), "r");
  mkdirSync(bare);
  reset({ "run.json": { address: "t7" } });
  assert.equal((await quietly(() => openCoreStatus(bare, CALLER, { kit: KIT, instance: "i1" }))).result, undefined);
  assert.deepEqual(calls().filter((c) => c[0] === "kill" || c[0] === "rm"), [["kill", "t7", "--json"], ["rm", "t7", "--json"]]);
});

test("teardown ends only the addresses this instance recorded, and keeps the status view", () => {
  const root = project();
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "i1", status: "t3", slots: ["t5", "t6"] }));
  reset();
  teardown(root, "i2");
  assert.deepEqual(calls(), [], "a successor's record: nothing of this instance's in it");
  teardown(root, "i1");
  assert.deepEqual(calls(), [["kill", "t5", "--json"], ["rm", "t5", "--json"], ["kill", "t6", "--json"], ["rm", "t6", "--json"]]);
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t3", slots: [] });
});

const slotView = (root: string, panes = 2) => openCoreView(root, CALLER, { kit: KIT, instance: "i1", panes, slots: true, ref: (id) => `#${id}` });
const addresses = (...a: string[]) => Object.fromEntries(a.map((address, i) => [`runs/${i}.json`, { address }]));

test("slots: argv only, the core flags under the status terminal, this run's labels, a name each, and the record", () => {
  const root = project();
  reset(addresses("t7", "t8", "t9"));
  const view = slotView(root);
  assert.equal(view.status, "t7");
  view.claim("12", "Add cart");
  view.claim("14", "Fix it");
  view.claim("15", "No room");
  const runs = calls().filter((c) => c[0] === "run");
  assert.equal(runs.length, 3, "the status terminal and two slots: panes 2");
  assert.deepEqual(runs[1], [
    "run", "--bg", "--json", "--no-notify", "--outlive-parent", "--rm", "--parent", "t7", "--name", slotName(root, 0), "--cwd", root,
    "--label", "herdr.space=sp1", "--label", "herdr.tab=tb1", "--label", `sandcastle.root=${projectKey(root)}`, "--label", "sandcastle.instance=i1",
    "--", `${KIT}/bin/sandcastle`, "slot", "0", "--instance", "i1",
  ]);
  assert.equal(runs[2].at(-3), "1");
  assert.match(slotName(root, 99), /^[a-z0-9_-]{1,32}$/);
  assert.deepEqual(readCoreView(root), { instance: "i1", status: "t7", slots: ["t8", "t9"] });
  assert.deepEqual(readSlotState(slotStateFile(root, 0)), { address: "t8", issue: "12", ref: "#12", title: "Add cart", phase: "setup", state: "working" });
  assert.equal(readlinkSync(slotLink(root, 0)), "none.log");
});

test("a slot follows its ticket: the phase's log, the outcome, reuse by the next ticket, closed when released", () => {
  const root = project();
  // An earlier run's link and state would replay its log.
  writeFileSync(join(root, ".sandcastle/logs/core-slot-5.json"), "{}");
  writeFileSync(join(root, ".sandcastle/logs/herdr-pane-5.log"), "");
  reset(addresses("t7", "t8", "t9"));
  const view = slotView(root);
  assert.ok(!existsSync(join(root, ".sandcastle/logs/core-slot-5.json")) && !existsSync(join(root, ".sandcastle/logs/herdr-pane-5.log")));
  view.claim("12", "Add cart");
  view.claim("14", "Fix it");
  view.phase("12", "implement");
  assert.equal(readlinkSync(slotLink(root, 0)), "agent-issue-12-impl-12.log");
  assert.equal(readSlotState(slotStateFile(root, 0))?.phase, "implement");
  view.finish("12", "green");
  assert.deepEqual(readSlotState(slotStateFile(root, 0)), { address: "t8", issue: "12", ref: "#12", title: "Add cart", phase: "green", state: "idle" });
  view.landed("12", false, "conflict");
  assert.equal(readSlotState(slotStateFile(root, 0))?.state, "blocked", "a landing a person must act on");
  view.claim("15", "Next");
  assert.equal(calls().filter((c) => c[0] === "run").length, 3, "the free slot is reused");
  assert.equal(readSlotState(slotStateFile(root, 0))?.issue, "15");
  view.landed("12", true, "merged");
  assert.equal(readSlotState(slotStateFile(root, 0))?.issue, "15", "a later ticket's slot keeps its own");
  view.finish("14", "crashed");
  assert.equal(readSlotState(slotStateFile(root, 1))?.state, "blocked");
  assert.deepEqual(slotAddresses(join(root, ".sandcastle/logs")), ["#15 t8", "#14 t9"]);

  writeFileSync(log, "");
  view.finish("15", "merged", true);
  assert.deepEqual(calls(), [["kill", "t8", "--json"], ["rm", "t8", "--json"]]);
  assert.deepEqual(readCoreView(root)?.slots, ["t9"]);
  assert.ok(!existsSync(slotStateFile(root, 0)) && !existsSync(slotLink(root, 0)));
});

test("a slot's name a killed run's slot still holds: this one starts unnamed", () => {
  const root = project();
  reset({ ...addresses("t7", "t8"), "name-taken": {} });
  slotView(root).claim("12", "Add cart");
  const runs = calls().filter((c) => c[0] === "run");
  assert.equal(runs.length, 3);
  assert.ok(runs[1].includes("--name") && !runs[2].includes("--name"));
  assert.deepEqual(readCoreView(root)?.slots, ["t8"]);
});

test("slot teardown: this instance's slots only, never a successor's; an autonomy run's next turn ends the last turn's", () => {
  const root = project();
  reset(addresses("t7", "t8", "t9"));
  const view = slotView(root);
  view.claim("12", "a");
  view.claim("14", "b");
  writeFileSync(log, "");
  teardown(root, "i1");
  assert.deepEqual(calls(), [["kill", "t8", "--json"], ["rm", "t8", "--json"], ["kill", "t9", "--json"], ["rm", "t9", "--json"]]);

  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "i2", status: "t7", slots: ["t20"] }));
  reset();
  teardown(root, "i1");
  assert.deepEqual(calls(), [], "a successor's slots are untouched");

  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "i1", status: "t7", slots: ["t8"] }));
  reset({ "get-t7.json": shellOf("t7", projectKey(root), ["node", "/k/src/cli.ts", "status"]), ...addresses("t10") });
  slotView(root);
  assert.deepEqual(calls().filter((c) => c[0] !== "get"), [["kill", "t8", "--json"], ["rm", "t8", "--json"]]);
  assert.deepEqual(readCoreView(root)?.slots, []);
});

test("the status view names a live run's slot terminals by ticket and address, and a finished run's none", async () => {
  const root = project();
  const dir = join(root, ".sandcastle");
  reset(addresses("t7", "t8"));
  slotView(root).claim("12", "Add cart");
  const kit = kitLikeProcess();
  try {
    const frame = async (finished: boolean) => {
      writeFileSync(join(dir, "logs/run.json"), JSON.stringify({ pid: kit.pid, startedAt: "2026-11-03T00:00:00Z", ...(finished ? { finishedAt: "2026-11-03T01:00:00Z" } : {}), tickets: { "12": { state: "implement" } } }));
      const part = await readRecord(dir, process.env, new AbortController().signal);
      const loading = { status: "loading" } as const;
      const snapshot = snapshotOf(dir, { record: { status: "current", value: part }, git: loading, docker: loading, queue: { status: "current", value: [] }, pool: loading });
      return renderFrame(snapshot, ticketRows(snapshot), { cols: 160, rows: 60, showAll: true, colours: palette(false, false) });
    };
    assert.match(await frame(false), /terminals: #12 t8/);
    assert.doesNotMatch(await frame(true), /terminals:/);
  } finally {
    kit.kill();
  }
});

test("in a core terminal: panes \"all\" puts a slot in the caller's tab, \"none\" makes it a sub-agent, the view off opens none", () => {
  const p = { name: "shop", herdr: {} } as unknown as Project;
  const slotRun = (mode: "all" | "none") => {
    const root = project();
    reset(addresses("t7", "t8"));
    const view = openSandboxView({ ...p, root } as Project, 2, (id) => `#${id}`, undefined, mode);
    assert.equal(view.status, "t7");
    view.claim("12", "a");
    const runs = calls().filter((c) => c[0] === "run");
    assert.equal(runs.length, 2, `${mode}: the status terminal and one slot`);
    return { root, slot: runs[1] };
  };
  const paned = slotRun("all");
  assert.ok(paned.slot.includes("herdr.tab=tb1") && paned.slot.includes(slotName(paned.root, 0)));
  const sub = slotRun("none");
  assert.ok(!sub.slot.some((w) => w.startsWith("herdr.")), "no herdr.* label: the app gives it no pane");
  assert.equal(sub.slot[sub.slot.indexOf("--parent") + 1], "t7", "listed under the run's agent");
  assert.equal(sub.slot[sub.slot.indexOf("--name") + 1], ticketName(sub.root, "12"));

  const other = project();
  reset(addresses("t7", "t8"));
  process.env.SANDCASTLE_HERDR_VIEW = "0";
  try {
    const off = openSandboxView({ ...p, root: other } as Project, 2, (id) => `#${id}`, undefined, "all");
    off.claim("12", "a");
    assert.equal(off.status, undefined, "the caller opens the status view");
    assert.deepEqual(calls(), [], "SANDCASTLE_HERDR_VIEW=0: no slot");
  } finally {
    delete process.env.SANDCASTLE_HERDR_VIEW;
  }
});

test("a sub-agent slot is named after its ticket, so the next ticket gets a terminal of its own", () => {
  const root = project();
  reset(addresses("t7", "t8", "t9"));
  const view = openCoreView(root, CALLER, { kit: KIT, instance: "i1", panes: 1, slots: true, paned: false, ref: (id) => `#${id}` });
  view.claim("12", "Add cart");
  view.finish("12", "green");
  view.claim("14", "Fix it");
  const after = calls().filter((c) => c[0] !== "get");
  const runs = after.filter((c) => c[0] === "run");
  assert.equal(runs.length, 3);
  assert.equal(runs[2][runs[2].indexOf("--name") + 1], ticketName(root, "14"));
  assert.equal(runs[2].at(-3), "0", "the same slot: its log link and state file");
  assert.deepEqual(after.slice(after.indexOf(runs[1]) + 1, after.indexOf(runs[2])), [["kill", "t8", "--json"], ["rm", "t8", "--json"]], "the last ticket's terminal ends first");
  assert.deepEqual(readCoreView(root)?.slots, ["t9"]);
  assert.deepEqual(readSlotState(slotStateFile(root, 0)), { address: "t9", issue: "14", ref: "#14", title: "Fix it", phase: "setup", state: "working" });

  // A failed start leaves no address on record and the run goes on without slots.
  reset();
  view.finish("14", "green");
  quietly(() => view.claim("15", "Next"));
  assert.deepEqual(readCoreView(root)?.slots, []);
});

test("a ticket's terminal name: project and ticket, within hc's names", () => {
  const root = join(project(), "My Shop.app");
  mkdirSync(root);
  assert.equal(ticketName(root, "12"), "my-shop-app-12");
  assert.equal(ticketName(root, "0007-Add CSV export, now"), "my-shop-app-0007-add-csv-export");
  for (const issue of ["12", "x".repeat(80), "!!!", "PROJ-1234"]) assert.match(ticketName(root, issue), /^[a-z0-9_-]{1,32}$/);
  assert.equal(ticketName(join(project(), "日本"), "12"), "12", "a project name with nothing hc allows: the ticket alone");
});

test("in a core terminal, openStatusPane opens the core view; openSandboxView retires a Herdr TUI record and drives no herdr", () => {
  const root = project();
  // An earlier Herdr TUI run's own tab: the plugin would type the report into it, and register it as awaiting.
  writeFileSync(viewRecord(root), JSON.stringify({ tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] }));
  reset({ "run.json": { address: "t7" } });
  const p = { root, name: "shop", herdr: {} } as unknown as Project;
  process.env.SANDCASTLE_HERDR_VIEW = "0";
  let view;
  try {
    view = openSandboxView(p, 2, (id) => `#${id}`, undefined, "none");
  } finally {
    delete process.env.SANDCASTLE_HERDR_VIEW;
  }
  assert.equal(view.status, undefined);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, true);
  assert.equal(tabAwaitsReport(root), false);
  assert.equal(openStatusPane(p), "t7");
  assert.ok(!calls().some((c) => c.includes("w1:t2") || c.includes("w1:t2-1")), "no id from the Herdr TUI record reaches hc");
  assert.ok(!existsSync(join(root, ".sandcastle/logs/status-pane")));
});

test("a question in a core terminal: blocked with kind=question while asked, then cleared; nothing when piped", async () => {
  let written = "";
  const tty = { isTTY: true, write: (s: string) => (written += s) };
  assert.equal(await askingInCore("asks whether to run 2 ticket(s) again", async () => "yes", tty), "yes");
  assert.equal(written, record({ state: "blocked", app: "sandcastle", kind: "question", msg: "asks whether to run 2 ticket(s) again" }) + clear());
  written = "";
  await askingInCore("asks", async () => 1, { isTTY: false, write: (s: string) => (written += s) });
  assert.equal(written, "");
  // The dispatch: in a core terminal with stdout piped (as under the test runner), no Herdr TUI report and no record.
  reset();
  assert.equal(await askingInPane("asks", async () => 2), 2);
  assert.deepEqual(verbs(), []);
});

const ticket = (state: string, title?: string) => ({ state, ...(title ? { title } : {}) }) as never;
const run = (tickets: Record<string, never>, over: object = {}) => ({ name: "shop", hasRecord: true, live: true, record: {}, tickets, ...over });

test("the run's records: progress 0..100, needs-you as blocked/question, a child per ticket in flight, the end", () => {
  const live = runRecords(run({ a: ticket("implement", "Add cart"), b: ticket("merged"), c: ticket("queued"), "x/y": ticket("gates") }));
  assert.deepEqual([...live.keys()], ["root", "title", "child a", "child x_y"]);
  assert.equal(live.get("root"), record({ state: "working", app: "sandcastle", progress: 25, title: "sandcastle shop", msg: "1/4 · 2 working" }));
  assert.equal(live.get("title"), windowTitle("sandcastle shop · 1/4 · 2 working"));
  assert.equal(live.get("child a"), record({ id: "a", state: "working", app: "sandcastle", title: "Add cart", msg: "a implement" }));
  const held = runRecords(run({ a: ticket("held"), b: ticket("merged") }));
  assert.equal(held.get("root"), record({ state: "blocked", app: "sandcastle", kind: "question", progress: 50, title: "sandcastle shop", msg: "a needs you: held · 1/2 merged" }));
  const done = runRecords(run({ b: ticket("merged") }, { live: false, record: { finishedAt: "2026-11-03T00:00:00Z" } })).get("root")!;
  assert.equal(done, record({ state: "done", app: "sandcastle", progress: 100, title: "sandcastle shop", msg: "run finished: 1/1" }));
  assert.match(runRecords(run({ b: ticket("implement") }, { live: false })).get("root")!, /state=error/);
  assert.equal(runRecords(run({ b: ticket("implement") }, { live: false })).has("child b"), false);
  assert.equal(runRecords(run({}, { hasRecord: false })).size, 0);
});

test("the root stays working while a later turn retries the ticket that failed, and is blocked in the last turn or for a killed run", () => {
  const tickets = { a: ticket("not landed"), b: ticket("merged") };
  const drain = (turn: number) => ({ settings: { autonomy: "drain", turn, cap: 20 } });
  assert.equal(runRecords(run(tickets, { record: drain(2) })).get("root"), record({ state: "working", app: "sandcastle", progress: 50, title: "sandcastle shop", msg: "1/2" }));
  assert.equal(
    runRecords(run(tickets, { record: drain(20) })).get("root"),
    record({ state: "blocked", app: "sandcastle", kind: "question", progress: 50, title: "sandcastle shop", msg: "a needs you: not landed · 1/2 merged" }),
  );
  // Killed: a record with no finishedAt, but no turn will follow.
  assert.equal(
    runRecords(run(tickets, { live: false, record: drain(2) })).get("root"),
    record({ state: "blocked", app: "sandcastle", kind: "question", progress: 50, title: "sandcastle shop", msg: "run ended early: a needs you: not landed · 1/2 merged" }),
  );
});

test("the view's writer: only its own instance's, only on a terminal, only what changed; a ticket gone is cleared", () => {
  const dir = join(project(), ".sandcastle");
  writeFileSync(join(dir, "logs/core-view.json"), JSON.stringify({ instance: "i1", status: "t3" }));
  assert.equal(coreRecords(dir, {}, true), undefined, "no marker: a view a person typed in writes nothing");
  assert.equal(coreRecords(dir, { SANDCASTLE_CORE_VIEW: "i1" }, false), undefined, "piped: nothing");
  assert.equal(coreRecords(dir, { SANDCASTLE_CORE_VIEW: "i0" }, true)!.update(run({ a: ticket("implement") })), "", "another instance's terminal");

  const w = coreRecords(dir, { SANDCASTLE_CORE_VIEW: "i1" }, true)!;
  const first = w.update(run({ a: ticket("implement"), b: ticket("review") }));
  assert.equal((first.match(/\u001b\]7501;/g) ?? []).length, 3);
  assert.equal(w.update(run({ a: ticket("implement"), b: ticket("review") })), "", "a redraw says nothing");
  const next = w.update(run({ a: ticket("merged"), b: ticket("review") }));
  assert.ok(next.includes(clear("a")), "a's child record cleared once it left");
  assert.ok(next.includes("progress=50"));
  // A successor took the terminal over: this view goes quiet.
  writeFileSync(join(dir, "logs/core-view.json"), JSON.stringify({ instance: "i2", status: "t3" }));
  assert.equal(w.update(run({ a: ticket("merged"), b: ticket("merged") })), "");
  assert.equal(w.end(), clear());
  assert.equal(w.end(), "");
});

test("the live status view writes its records once, not on every paint, and only with its instance's marker", needsScript, async () => {
  const fixture = buildFixture("live", realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-view-"))));
  try {
    writeFileSync(join(fixture.root, ".sandcastle/logs/core-view.json"), JSON.stringify({ instance: "i1", status: "t3" }));
    const owned = await startSession(fixture, { args: ["1"], env: { SANDCASTLE_CORE_VIEW: "i1" } });
    try {
      const first = await owned.frame();
      await owned.frame(first.end);
      await owned.frame(owned.frames().at(-1)!.end);
      // Not a count of records: they follow the view's readings (the run record, the run's liveness by a `ps` of its
      // pid), so a slow or failed reading under load can honestly write a different record, and the next good one
      // another - however many paints that takes. What a write on every paint adds is the same record again, unchanged
      // since that key's last record, which is what is refused.
      // A child record a not-live reading cleared is sent again once the run reads live: a clear forgets its record.
      const sent = [...owned.output().matchAll(/\u001b\]7501;([^\u0007]*)\u0007/g)].map((m) => m[1]!);
      assert.ok(sent.some((r) => !r.startsWith("id=") && r !== "state=clear"), "a root record was written");
      const key = (r: string) => (r.startsWith("id=") ? r.split(":")[0] : "root");
      const last = new Map<string, string>();
      for (const r of sent) {
        if (r.endsWith("state=clear")) {
          last.delete(key(r));
          continue;
        }
        assert.notEqual(last.get(key(r)), r, `a record repeated unchanged: ${r}`);
        last.set(key(r), r);
      }
    } finally {
      owned.close();
    }
    const other = await startSession(fixture, { args: ["1"], env: { SANDCASTLE_CORE_VIEW: "i0" } });
    try {
      await other.frame();
      assert.ok(!other.output().includes("\u001b]7501;"));
    } finally {
      other.close();
    }
  } finally {
    fixture.stop();
  }
});

// Herdr toasts a blocked or done agent with its record's msg (#961): the msg leads with what the person is wanted for.
test("a blocked run's msg names the newest ticket that needs a person and why, and how many more do", () => {
  const t = (state: string, since: number, more: object = {}) => ({ state, since, ...more }) as never;
  const tickets = {
    "12": t("conflict", 200, { files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] }),
    "9": t("held", 100, { note: "human merge: .github/" }),
    "3": t("merged", 50),
  };
  assert.equal(needsYouLine(tickets, new Set()), "#12 needs you: conflict in src/a.ts, src/b.ts +2 (+1 more)");
  assert.equal(needsYouLine({ "9": tickets["9"] }, new Set()), "#9 needs you: held - human merge: .github/");
  // A ticket a later turn takes by itself is not the person's.
  assert.equal(needsYouLine(tickets, new Set(["12"])), "#9 needs you: held - human merge: .github/");
  assert.match(runRecords(run(tickets)).get("root")!, new RegExp(`msg=${Buffer.from("#12 needs you: conflict in src/a.ts, src/b.ts +2 (+1 more) · 1/3 merged").toString("base64")}`));
  // The run's end with a ticket still wanting the person: the msg says the run ended, and who.
  const msgOf = (over: object) => Buffer.from(/msg=([^:\x07]+)/.exec(runRecords(run(tickets, over)).get("root")!)![1], "base64").toString();
  assert.equal(msgOf({ live: false, record: { finishedAt: "2026-11-13T00:00:00Z" } }), "run finished: #12 needs you: conflict in src/a.ts, src/b.ts +2 (+1 more) · 1/3 merged");
  assert.equal(msgOf({ live: false }), "run ended early: #12 needs you: conflict in src/a.ts, src/b.ts +2 (+1 more) · 1/3 merged");
});

// The core cuts a record's msg at 160 code points (#969): a long note is cut itself, so the count after it stays.
test("a 300-character note is cut in a blocked run's msg, which keeps the merged count and (+N more)", () => {
  const t = (state: string, since: number, more: object = {}) => ({ state, since, ...more }) as never;
  const tickets = { "12": t("held", 200, { note: `human merge: ${"x".repeat(286)}` }), "9": t("held", 100, { note: "short" }), "3": t("merged", 50) };
  for (const over of [{}, { live: false, record: { finishedAt: "2026-11-13T00:00:00Z" } }, { live: false }]) {
    const msg = Buffer.from(/msg=([^:\x07]+)/.exec(runRecords(run(tickets, over)).get("root")!)![1], "base64").toString();
    assert.ok([...msg].length <= 160, msg);
    assert.match(msg, /^(run finished: |run ended early: )?#12 needs you: held - human merge: x+… \(\+1 more\) · 1\/3 merged$/);
  }
  // With room to spare the note is whole.
  assert.equal(needsYouLine(tickets, new Set(), 400), `#12 needs you: held - human merge: ${"x".repeat(286)} (+1 more)`);
});

// A ticket file's id is the bare slug: one long enough overruns the msg by itself, and the count must still stay.
test("a long ticket-file id is cut in a blocked run's msg, which keeps the merged count; no stray … with no note", () => {
  const t = (state: string, since: number, more: object = {}) => ({ state, since, ...more }) as never;
  const slug = `fix-${"a".repeat(200)}`;
  const tickets = { [slug]: t("held", 200), "3": t("merged", 50) };
  const msg = Buffer.from(/msg=([^:\x07]+)/.exec(runRecords(run(tickets, { live: false })).get("root")!)![1], "base64").toString();
  assert.ok([...msg].length <= 160, msg);
  assert.match(msg, /^run ended early: fix-a+… · 1\/2 merged$/);
  assert.equal(needsYouLine({ "12": t("held", 1) }, new Set(), 40), "#12 needs you: held");
});
