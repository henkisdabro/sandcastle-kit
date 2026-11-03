// `sandcastle slot`, what a herdr-core slot terminal runs (src/core-slot.ts): it tails the slot's log link, writes the
// terminal's record and title when the run's slot state changes, prints an agent's log as plain text, and ends
// itself once the run is not live or a later run owns the project's view. In process, with a made-up run and a
// probe that says which pid is the kit; `tail` is the machine's own.
//
//   pnpm test:file test/core-slot.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { plainLog, runSlot } from "../src/core-slot.ts";
import { clear, record, windowTitle } from "../src/osc7501.ts";
import { launcherLines, runKit } from "./cli-spawn.ts";

const SLOT = new URL("../src/core-slot.ts", import.meta.url).pathname;

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A project with a live run (pid 4242, which the probe says is the kit) and this instance's view record. */
const project = () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-slot-"))), "my 'odd' repo");
  const logs = join(root, ".sandcastle/logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "run.json"), JSON.stringify({ pid: 4242, startedAt: "2026-11-03T00:00:00Z" }));
  writeFileSync(join(logs, "core-view.json"), JSON.stringify({ instance: "i1", status: "t7", slots: ["t8"] }));
  return { root, logs, rm: () => rmSync(join(root, ".."), { recursive: true, force: true }) };
};
const state = (logs: string, phase: string, s = "working") =>
  writeFileSync(join(logs, "core-slot-0.json"), JSON.stringify({ address: "t8", issue: "12", ref: "#12", title: "Add cart", phase, state: s }));
const sink = () => {
  const o = { text: "", write: (s: string) => void (o.text += s) };
  return o;
};
let alive = true;
const probe = (pid: number) => (pid === 4242 && alive ? "node /k/src/cli.ts run" : undefined);

test("a slot: its ticket and step as records once per change, the log as plain text, the next phase's log, the end", async () => {
  const p = project();
  alive = true;
  try {
    writeFileSync(join(p.logs, "agent-issue-12-impl-12.log"), "hello \u001b]7501;state=done:app=evil\u0007 world\n");
    symlinkSync("agent-issue-12-impl-12.log", join(p.logs, "herdr-pane-0.log"));
    state(p.logs, "implement");
    const out = sink();
    const done = runSlot(["0", "--instance", "i1"], { root: p.root, out, probe, pollMs: 20 });
    const first = record({ state: "working", app: "sandcastle", title: "#12 Add cart", msg: "implement" }) + windowTitle("#12 Add cart · implement");
    await until("the log", () => out.text.includes("world"));
    await until("the record", () => out.text.includes(first));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(out.text.split(first).length, 2, "said once over several looks");
    // The agent's OSC is inert text: its ESC and BEL are gone, so the core never reads it.
    assert.ok(out.text.includes("hello ]7501;state=done:app=evil world\n"));
    assert.ok(!out.text.replace(first, "").includes("\u001b"), "no escape but the slot's own");

    // The next phase: the link repointed, as the run does it, and the state moved.
    writeFileSync(join(p.logs, "agent-issue-12-review-12.log"), "reviewing now\n");
    rmSync(join(p.logs, "herdr-pane-0.log"));
    symlinkSync("agent-issue-12-review-12.log", join(p.logs, "herdr-pane-0.log"));
    state(p.logs, "review");
    await until("the review record", () => out.text.includes(record({ state: "working", app: "sandcastle", title: "#12 Add cart", msg: "review" })));
    await until("the review log", () => out.text.includes("reviewing now"));
    state(p.logs, "conflict", "blocked");
    await until("the blocked record", () => out.text.includes(record({ state: "blocked", app: "sandcastle", title: "#12 Add cart", msg: "conflict" })));

    // A later run took the project's view: this slot ends, its record cleared.
    writeFileSync(join(p.logs, "core-view.json"), JSON.stringify({ instance: "i2", status: "t7", slots: [] }));
    assert.equal(await done, 0);
    assert.ok(out.text.endsWith(clear()));
  } finally {
    p.rm();
  }
});

test("a slot whose run is not live ends at once; a lock the kit holds keeps it, whatever the record says", async () => {
  const p = project();
  try {
    alive = false;
    const out = sink();
    assert.equal(await runSlot(["0", "--instance", "i1"], { root: p.root, out, probe, pollMs: 20 }), 0);
    assert.equal(out.text, clear());

    // Killed with no exit handler: the record never finished, the pid is gone. And then a lock the kit holds.
    writeFileSync(join(p.logs, "run.json"), JSON.stringify({ pid: 999, finishedAt: "2026-11-03T00:00:00Z" }));
    writeFileSync(join(p.logs, "run.lock"), "4242 token");
    alive = true;
    const stop = new AbortController();
    const held = runSlot(["0", "--instance", "i1"], { root: p.root, out: sink(), probe, pollMs: 20, stop: stop.signal });
    let ended = false;
    void held.then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(ended, false, "the lock's pid is the kit's: live");
    alive = false;
    assert.equal(await held, 0);
  } finally {
    p.rm();
  }
});

test("plain log text: every control character but newline and tab, ESC and the C1 controls among them", () => {
  assert.equal(plainLog("a\u001b[31mred\u001b[0m\tb\r\n\u009d7501;x\u0007c"), "a[31mred[0m\tb\n7501;xc");
});

test("the launcher runs `slot` alone, and the verb says its usage and help", () => {
  assert.ok(launcherLines.some((l) => l.startsWith('if [ "${1:-}" = slot ]') && l.includes("src/core-slot.ts")));
  const bad = runKit(["slot"], { script: SLOT, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /Usage: sandcastle slot <n> --instance <id>/);
  const help = runKit(["slot", "--help"], { script: SLOT, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /slot <n> --instance <id>/);
});
