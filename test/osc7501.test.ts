// OSC 7501 strings (src/osc7501.ts) as herdr-core reads them: `:`-separated fields, base64 text,
// 0..100 progress, `state=clear` to remove a record. Golden strings, so a drift in the format shows here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { clear, record, windowTitle } from "../src/osc7501.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const OSC = (body: string) => `\u001b]7501;${body}\u0007`;

test("a root record, every field in order", () => {
  assert.equal(
    record({ state: "working", app: "sandcastle", progress: 50, title: "run", msg: "2/4 merged" }),
    OSC(`state=working:app=sandcastle:progress=50:title=${b64("run")}:msg=${b64("2/4 merged")}`),
  );
});

test("a child record leads with its id", () => {
  assert.equal(record({ id: "42", state: "working", title: "Fix login", msg: "review" }), OSC(`id=42:state=working:title=${b64("Fix login")}:msg=${b64("review")}`));
});

test("kind only on blocked; progress only on working or blocked, rounded and clamped", () => {
  assert.equal(record({ state: "blocked", kind: "question", progress: 33.4 }), OSC("state=blocked:kind=question:progress=33"));
  assert.equal(record({ state: "working", kind: "question", progress: 140 }), OSC("state=working:progress=100"));
  assert.equal(record({ state: "done", progress: 100 }), OSC("state=done"));
  assert.equal(record({ state: "working", progress: -5 }), OSC("state=working:progress=0"));
  assert.equal(record({ state: "working", progress: Number.NaN }), OSC("state=working"));
});

test("text: control characters out, cut at 160 code points, never half a character", () => {
  assert.equal(record({ state: "idle", msg: "a\u001b]0;x\u0007b\nc" }), OSC(`state=idle:msg=${b64("a ]0;x b c")}`));
  const long = "♜".repeat(200);
  assert.equal(record({ state: "idle", msg: long }), OSC(`state=idle:msg=${b64("♜".repeat(160))}`));
  assert.equal(record({ state: "idle", msg: "🏰".repeat(161) }), OSC(`state=idle:msg=${b64("🏰".repeat(160))}`));
});

test("an id or app that could break the sequence is refused", () => {
  assert.throws(() => record({ id: "a:b", state: "idle" }));
  assert.throws(() => record({ id: "", state: "idle" }));
  assert.throws(() => record({ state: "idle", app: "x\u0007" }));
  assert.throws(() => clear("a;b"));
});

test("clear: a child by id, or the root", () => {
  assert.equal(clear("42"), OSC("id=42:state=clear"));
  assert.equal(clear(), OSC("state=clear"));
});

test("window title: OSC 2, control characters out", () => {
  assert.equal(windowTitle("sandcastle · 2/4\u0007"), "\u001b]2;sandcastle · 2/4 \u0007");
});
