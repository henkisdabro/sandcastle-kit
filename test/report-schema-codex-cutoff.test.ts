// A report superseded by prose is missing, but it was received: it was not cut off before arrival.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codex } from "@ai-hero/sandcastle";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-codex-cutoff-"));
const { codexReportCapture, COMPLETION_SIGNAL } = await import("../src/agents.ts");

test("a report followed by prose is missing without claiming its arrival was cut off", () => {
  let now = 0;
  const capture = codexReportCapture(() => now);
  const parser = codex("test-model");
  const message = (at: number, text: string) => {
    now = at;
    const raw = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
    capture.line(raw, parser.parseStreamLine(raw));
  };
  message(1000, COMPLETION_SIGNAL);
  message(2000, JSON.stringify({
    signal: COMPLETION_SIGNAL,
    unmet: { assessed: true, items: [] },
    changelog: [],
    followups: [],
    ungated: [],
  }));
  message(3500, "One last note.");
  capture.finish(9000);
  const facts = capture.read();
  assert.equal(facts.report, undefined, "only the last message supplies the report");
  assert.equal(facts.missing, "not JSON");
  assert.equal(facts.cutOff, undefined, "a valid report did arrive after the signal");
  assert.equal(facts.gapMs, 2500, "the gap ends at the last message, not at finish");
  assert.equal(facts.silenceMs, 1500);

  capture.reset();
  message(10000, COMPLETION_SIGNAL);
  capture.finish(13000);
  assert.equal(capture.read().cutOff, true, "a prior iteration's report cannot prevent a cut-off");
});
