// REPORT_SCHEMA=1 (#820): Claude passes also return a schema-validated report. The schema file, the flag on the
// agent's command, and the capture that keeps the `structured_output` of the stream's `result` line with when the
// completion signal and that line came. No Docker, model or network: the stream lines are hand-built and the
// capture's clock is a variable.
//
//   pnpm test:file test/report-schema.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCode } from "@ai-hero/sandcastle";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-rs-xdg-"));
// The switch is read at import: one instance of the module with it off, one with it on.
process.env.REPORT_SCHEMA = "";
const off = (await import(new URL("../src/agents.ts?off", import.meta.url).href)) as typeof import("../src/agents.ts");
process.env.REPORT_SCHEMA = "1";
const on = await import("../src/agents.ts");
const { COMPLETION_SIGNAL, passReport, reportCapture, reportFrom } = on;

const SCHEMA_FILE = join(import.meta.dirname, "../container/report.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;

// ---- the schema file

const KEYWORDS = ["type", "properties", "required", "additionalProperties", "items", "enum", "description"];
/** Codex's strict mode, as the ticket states it: closed objects naming every property, and a short list of keywords. */
const strictProblems = (node: unknown, where = "$"): string[] => {
  if (typeof node !== "object" || node === null) return [];
  const o = node as Record<string, unknown>;
  const problems = Object.keys(o).filter((k) => !KEYWORDS.includes(k)).map((k) => `${where}: keyword ${k}`);
  if (o.type === "object") {
    const props = Object.keys((o.properties ?? {}) as object);
    if (o.additionalProperties !== false) problems.push(`${where}: additionalProperties is not false`);
    if (JSON.stringify([...((o.required ?? []) as string[])].sort()) !== JSON.stringify([...props].sort())) problems.push(`${where}: required differs from properties`);
    for (const [k, v] of Object.entries((o.properties ?? {}) as object)) problems.push(...strictProblems(v, `${where}.${k}`));
  }
  if (o.items) problems.push(...strictProblems(o.items, `${where}[]`));
  return problems;
};

test("the schema file is valid JSON and follows strict mode", () => {
  assert.deepEqual(strictProblems(schema), []);
  assert.deepEqual(strictProblems({ type: "object", properties: { a: { type: "string" } }, required: [] }), ["$: additionalProperties is not false", "$: required differs from properties"]);
  assert.deepEqual(strictProblems({ type: "string", pattern: "x" }), ["$: keyword pattern"]);
});

test("the schema names the five fields the tags carry, and describes each", () => {
  assert.deepEqual(Object.keys((schema.properties ?? {}) as object), ["signal", "unmet", "changelog", "followups", "ungated"]);
  for (const [name, field] of Object.entries((schema.properties ?? {}) as Record<string, { description?: string }>)) assert.ok(field.description, `${name} has a description`);
  assert.match((schema.properties as { changelog: { description: string } }).changelog.description, /Empty when the change needs no changelog line/);
});

// ---- the command

const options = { prompt: "do the ticket", dangerouslySkipPermissions: true };
const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

test("off, a Claude pass's command is what it was", () => {
  const { command } = off.implAgent().buildPrintCommand(options);
  assert.equal(command, "claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model 'claude-sonnet-5-5' --effort high --tools 'Bash,Read,Edit,Write,TaskStop' -p -");
  assert.equal(passReport(off.implAgent()), undefined);
  assert.equal(off.REPORT_SCHEMA, false);
});

test("on, the command carries the compact schema before its closing -p -", () => {
  const compact = JSON.stringify(schema);
  const { command } = on.implAgent().buildPrintCommand(options);
  assert.ok(command.endsWith(` --json-schema ${quoted(compact)} -p -`));
  assert.equal(command.replace(` --json-schema ${quoted(compact)}`, ""), off.implAgent().buildPrintCommand(options).command);
  assert.equal(on.REPORT_SCHEMA, true);
  // The shell reads the quoted schema back as the one argument, descriptions with apostrophes included.
  const back = execFileSync("sh", ["-c", `printf %s ${quoted(compact)}`], { encoding: "utf8" });
  assert.equal(back, compact);
});

test("a command of another shape is refused", () => {
  assert.throws(() => on.withSchema("claude --print -p - --extra", "{}"), /no longer has the shape/);
  assert.throws(() => on.withSchema("codex exec -p -", "{}"), /no longer has the shape/);
});

test("a Codex agent has no capture", () => {
  assert.equal(passReport({}), undefined);
});

// ---- the capture

const line = (o: unknown) => JSON.stringify(o);
const said = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolUse = (name: string, input: unknown) => line({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name, input }] } });
const toolResult = (content: string) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content }] } });
const result = (extra: Record<string, unknown> = {}) => line({ type: "result", subtype: "success", is_error: false, result: `Done.\n\n${COMPLETION_SIGNAL}`, num_turns: 2, ...extra });

const REPORT = {
  signal: COMPLETION_SIGNAL,
  unmet: { assessed: true, items: [{ who: "agent", text: "the README" }] },
  changelog: ["Added: the thing."],
  followups: ["a title - some evidence"],
  ungated: ["the look of it"],
};

// The library's own parser, whose events the capture is handed with each line.
const library = claudeCode("claude-sonnet-5-5", { effort: "high" });
/** A capture on a clock the test moves; `feed(raw)` at a time, as the agent's parser feeds it. */
const timed = () => {
  const clock = { t: 0 };
  const capture = reportCapture(() => clock.t);
  return {
    capture,
    clock,
    feed: (raw: string, at: number) => {
      clock.t = at;
      capture.line(raw, library.parseStreamLine(raw));
    },
  };
};

test("a valid report on the result line comes with its tries, turns and the last output", () => {
  const c = timed();
  c.feed(said("Working."), 0);
  c.feed(toolUse("StructuredOutput", REPORT), 10);
  c.feed(toolResult("Structured output provided successfully"), 20);
  c.feed(result({ structured_output: REPORT }), 30);
  c.capture.finish(40);
  assert.deepEqual(c.capture.read(), { report: REPORT, output: `Done.\n\n${COMPLETION_SIGNAL}`, tries: 1, turns: 2, gapMs: 0, silenceMs: 0 });
});

test("a report after a validation retry counts both tries", () => {
  const c = timed();
  c.feed(toolUse("StructuredOutput", { signal: "no" }), 0);
  c.feed(toolResult("validation failed"), 5);
  c.feed(toolUse("StructuredOutput", REPORT), 10);
  c.feed(result({ structured_output: REPORT, num_turns: 3 }), 20);
  const facts = c.capture.read();
  assert.deepEqual(facts.report, REPORT);
  assert.equal(facts.tries, 2);
  assert.equal(facts.turns, 3);
});

test("a result line with no structured_output is a missing report, not a throw", () => {
  const c = timed();
  c.feed(result(), 0);
  const facts = c.capture.read();
  assert.equal(facts.report, undefined);
  assert.equal(facts.missing, "no structured_output");
  assert.equal(facts.tries, 0);
});

test("no result line at all is a missing report", () => {
  const c = timed();
  c.feed(said("Working."), 0);
  assert.equal(c.capture.read().missing, "no result line");
});

test("retries exhausted is told from a report that never came", () => {
  const c = timed();
  c.feed(toolUse("StructuredOutput", { signal: "no" }), 0);
  c.feed(result({ subtype: "error_max_structured_output_retries", is_error: true }), 10);
  assert.equal(c.capture.read().missing, "retries exhausted");
});

test("an invalid report is refused with what is wrong with it", () => {
  const wrongSignal = { ...REPORT, signal: "done" };
  assert.deepEqual(reportFrom(wrongSignal), { missing: "invalid: signal is not the completion signal" });
  // Strict mode cannot say "not assessed means no items".
  const unassessed = { ...REPORT, unmet: { assessed: false, items: [{ who: "agent", text: "x" }] } };
  assert.deepEqual(reportFrom(unassessed), { missing: "invalid: unmet is not assessed but has items" });
  assert.match((reportFrom({ ...REPORT, extra: 1 }) as { missing: string }).missing, /^invalid: /);
  assert.match((reportFrom({ ...REPORT, changelog: "Added: x" }) as { missing: string }).missing, /^invalid: /);
  assert.match((reportFrom({ ...REPORT, unmet: { assessed: true, items: [{ who: "robot", text: "x" }] } }) as { missing: string }).missing, /^invalid: /);
  assert.match((reportFrom("a string") as { missing: string }).missing, /^invalid: /);
  assert.deepEqual(reportFrom({ ...REPORT, unmet: { assessed: false, items: [] } }), { report: { ...REPORT, unmet: { assessed: false, items: [] } } });
  const c = timed();
  c.feed(result({ structured_output: wrongSignal }), 0);
  const facts = c.capture.read();
  assert.equal(facts.report, undefined);
  assert.equal(facts.missing, "invalid: signal is not the completion signal");
});

test("each command starts the capture clean: it describes the last iteration only", () => {
  const agent = on.implAgent();
  const capture = passReport(agent);
  assert.ok(capture);
  agent.buildPrintCommand(options);
  agent.parseStreamLine(toolUse("StructuredOutput", REPORT));
  agent.parseStreamLine(result({ structured_output: REPORT }));
  assert.deepEqual(capture.read().report, REPORT);
  assert.equal(capture.read().tries, 1);
  agent.buildPrintCommand(options);
  assert.deepEqual(capture.read(), { missing: "no result line", output: "", tries: 0 });
});

test("the last iteration's output is the result text, else the text events", () => {
  const withResult = timed();
  withResult.feed(said("Thinking aloud."), 0);
  withResult.feed(result({ result: "The final message." }), 1);
  assert.equal(withResult.capture.read().output, "The final message.");
  const noResult = timed();
  noResult.feed(said("First. "), 0);
  noResult.feed(said("Second."), 1);
  assert.equal(noResult.capture.read().output, "First. Second.");
  const emptyResult = timed();
  emptyResult.feed(said("Said it here."), 0);
  emptyResult.feed(result({ result: "" }), 1);
  assert.equal(emptyResult.capture.read().output, "Said it here.");
});

// ---- the timing

test("gapMs runs from the text line that held the signal to the result line", () => {
  const c = timed();
  c.feed(said("Working."), 1_000);
  c.feed(said(`All done.\n${COMPLETION_SIGNAL}`), 2_000);
  c.feed(toolUse("StructuredOutput", REPORT), 2_500);
  c.feed(result({ structured_output: REPORT }), 4_200);
  const facts = c.capture.read();
  assert.equal(facts.gapMs, 2_200);
  assert.equal(facts.silenceMs, 1_700);
  assert.equal(facts.cutOff, undefined);
});

test("silenceMs is the longest stretch without a line after the signal", () => {
  const c = timed();
  c.feed(said(COMPLETION_SIGNAL), 0);
  c.feed(said("a"), 100);
  c.feed(said("b"), 200);
  c.feed(said("c"), 2_200);
  c.feed(result({ structured_output: REPORT }), 2_300);
  const facts = c.capture.read();
  assert.equal(facts.gapMs, 2_300);
  assert.equal(facts.silenceMs, 2_000);
});

test("a signal split over two text events arms the window on the second", () => {
  const c = timed();
  c.feed(said("<promise>COMPLE"), 0);
  c.feed(said("TE</promise>"), 500);
  c.feed(result({ structured_output: REPORT, result: "ok" }), 900);
  assert.equal(c.capture.read().gapMs, 400);
});

test("a result line that holds the signal itself arms and ends the window at once", () => {
  const c = timed();
  c.feed(said("Working."), 0);
  c.feed(result({ structured_output: REPORT }), 700);
  const facts = c.capture.read();
  assert.equal(facts.gapMs, 0);
  assert.equal(facts.silenceMs, 0);
});

test("no result line after the signal: both figures run to the pass's end, cut off", () => {
  const c = timed();
  c.feed(said(`${COMPLETION_SIGNAL}`), 1_000);
  c.feed(said("more"), 1_100);
  c.capture.finish(6_100);
  const facts = c.capture.read();
  assert.equal(facts.gapMs, 5_100);
  assert.equal(facts.silenceMs, 5_000);
  assert.equal(facts.cutOff, true);
  assert.equal(facts.missing, "no result line");
});

test("a signal found only in a tool_use or tool_result line starts no timing", () => {
  const c = timed();
  c.feed(toolUse("StructuredOutput", { ...REPORT, followups: [COMPLETION_SIGNAL] }), 0);
  c.feed(toolResult(`quoted: ${COMPLETION_SIGNAL}`), 100);
  c.feed(line({ type: "user", message: { content: [{ type: "text", text: COMPLETION_SIGNAL }] } }), 200);
  c.feed(result({ structured_output: REPORT, result: "ok" }), 300);
  c.capture.finish(900);
  const facts = c.capture.read();
  assert.equal(facts.gapMs, undefined);
  assert.equal(facts.silenceMs, undefined);
  assert.equal(facts.cutOff, undefined);
});

test("a signal the pass never gave has no timing even when the pass ends without a result", () => {
  const c = timed();
  c.feed(said("Working."), 0);
  c.capture.finish(10_000);
  const facts = c.capture.read();
  assert.equal(facts.gapMs, undefined);
  assert.equal(facts.cutOff, undefined);
});

test("the agent's own parser feeds the capture and still returns the library's events", () => {
  const agent = on.implAgent();
  const events = agent.parseStreamLine(said("hello"));
  assert.deepEqual(events, [{ type: "text", text: "hello" }]);
  assert.equal(passReport(agent)?.read().output, "hello");
  assert.deepEqual(off.implAgent().parseStreamLine(said("hello")), [{ type: "text", text: "hello" }]);
});
