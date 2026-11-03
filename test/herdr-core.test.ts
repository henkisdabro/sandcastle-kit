// herdr-core (Herdr 2): the run's status view as a core terminal (src/herdr-core.ts). A stub `hc` on PATH logs every
// call's argv, one word per field, and answers from files the test writes; this process is made a core terminal's
// (HC_TERMINAL_ID, which the stub answers with this process's parent as its root pid), so the dispatch in
// `openStatusPane`, `askingInPane` and `openSandboxView` is the real one. No real core, no Herdr.
//
//   pnpm test:file test/herdr-core.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { buildFixture } from "./status-fixture.ts";
import { needsScript, startSession } from "./status-run.ts";
import { quietly } from "./quiet.ts";

const stub = mkdtempSync(join(tmpdir(), "sandcastle-hc-stub-"));
const bin = join(stub, "bin");
mkdirSync(bin);
const log = join(stub, "calls.log");
// `get T`: answers/get-T.json, else not found. `keys T`: answers/keys-T.json, when there, becomes T's next answer
// (Ctrl-C turning a view into a shell). `run`: answers/run.json, else fails. Every other verb answers `{}`.
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
  run) [ -f "$A/run.json" ] && { cat "$A/run.json"; exit 0; }; echo '{"error":{"message":"core not running"}}' >&2; exit 1 ;;
  *) echo '{}' ;;
esac
`,
);
chmodSync(join(bin, "hc"), 0o755);
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t-mine" });

const { coreRecords, coreViewRecord, openCoreStatus, projectKey, readCoreView, runRecords, statusName, teardown, askingInCore } = await import("../src/herdr-core.ts");
const { askingInPane, openSandboxView, viewRecord } = await import("../src/herdr.ts");
const { openStatusPane } = await import("../src/run.ts");
const { tabAwaitsReport } = await import("../src/live-runs.ts");
const { clear, record, windowTitle } = await import("../src/osc7501.ts");

const answers = join(stub, "answers");
const reset = (files: Record<string, unknown> = {}) => {
  rmSync(answers, { recursive: true, force: true });
  mkdirSync(answers);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(answers, name), JSON.stringify(value));
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

test("the project's status view from an earlier run is stopped and run again in place, with this run's marker", () => {
  const root = project();
  const key = projectKey(root);
  reset({
    [`get-${statusName(root)}.json`]: shellOf("t3", key, ["node", "--import", "x", "/k/src/cli.ts", "status"]),
    "keys-t3.json": shellOf("t3", key),
  });
  writeFileSync(coreViewRecord(root), JSON.stringify({ instance: "old", status: "t3" }));
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i2" }), "t3");
  assert.deepEqual(calls().filter((c) => c[0] !== "get"), [
    ["keys", "t3", "ctrl+c", "--json"],
    ["label", "t3", "sandcastle.instance=i2", "--json"],
    ["send", "t3", `cd '${root.replaceAll("'", "'\\''")}' && env SANDCASTLE_CORE_VIEW=i2 '/the kit'\\''s/dir/bin/sandcastle' status`, "--json"],
  ]);
  assert.equal(readCoreView(root)?.instance, "i2");
});

test("a bare shell in the project's status terminal is typed into, with no Ctrl-C", () => {
  const root = project();
  reset({ [`get-${statusName(root)}.json`]: shellOf("t3", projectKey(root)) });
  assert.equal(openCoreStatus(root, CALLER, { kit: KIT, instance: "i2" }), "t3");
  assert.deepEqual(verbs(), ["label", "send"]);
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

test("in a core terminal, openStatusPane opens the core view; openSandboxView retires a Herdr 1 record and drives no herdr", () => {
  const root = project();
  // An earlier Herdr 1 run's own tab: the plugin would type the report into it, and register it as awaiting.
  writeFileSync(viewRecord(root), JSON.stringify({ tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: [] }));
  reset({ "run.json": { address: "t7" } });
  const p = { root, name: "shop", herdr: {} } as unknown as Project;
  const view = openSandboxView(p, 2, (id) => `#${id}`);
  assert.equal(view.status, undefined);
  assert.equal(JSON.parse(readFileSync(viewRecord(root), "utf8")).reported, true);
  assert.equal(tabAwaitsReport(root), false);
  assert.equal(openStatusPane(p), "t7");
  assert.ok(!calls().some((c) => c.includes("w1:t2") || c.includes("w1:t2-1")), "no id from the Herdr 1 record reaches hc");
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
  // The dispatch: in a core terminal with stdout piped (as under the test runner), no Herdr 1 report and no record.
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
  assert.equal(held.get("root"), record({ state: "blocked", app: "sandcastle", kind: "question", progress: 50, title: "sandcastle shop", msg: "1/2 · 1 needs you" }));
  assert.match(runRecords(run({ b: ticket("merged") }, { live: false, record: { finishedAt: "2026-11-03T00:00:00Z" } })).get("root")!, /state=done/);
  assert.match(runRecords(run({ b: ticket("implement") }, { live: false })).get("root")!, /state=error/);
  assert.equal(runRecords(run({ b: ticket("implement") }, { live: false })).has("child b"), false);
  assert.equal(runRecords(run({}, { hasRecord: false })).size, 0);
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
      assert.equal((owned.output().match(/\u001b\]7501;state=/g) ?? []).length, 1, "one root record over three paints");
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
