// REPORT_SCHEMA=1 for the Codex cross-review (#822): `codex exec --output-schema` makes the pass's last
// `agent_message` the JSON report. The command's flag, the capture over hand-built `codex exec --json` lines (the
// shapes #821's probe recorded), the refusal's reason, the cut-off, and how the report reaches `saidOf`, the
// timings line and the cross-review's own log line. No Docker, model or network. burndown() needs Docker, so its
// call sites are held by source-match tests at the end.
//
//   pnpm test:file test/report-schema-codex.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codex, createBindMountSandboxProvider, createSandbox } from "@ai-hero/sandcastle";
import { quietly } from "./quiet.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-rsc-xdg-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-rsc-cache-"));
// Both switches are read at import: one instance of the module with the report schema off, one with it on.
process.env.CROSS_REVIEW = "1";
process.env.REPORT_SCHEMA = "";
const off = (await import(new URL("../src/agents.ts?off", import.meta.url).href)) as typeof import("../src/agents.ts");
process.env.REPORT_SCHEMA = "1";
const on = await import("../src/agents.ts");
const { agentFailure, codexReportCapture, COMPLETION_SIGNAL, passReport, withOutputSchema } = on;
const { gapOf: gapOfText, reportTiming, reviewGap, saidOf } = await import("../src/burndown.ts");
const { MANAGED_SETTINGS } = await import("../src/sandbox.ts");

const line = (o: unknown) => JSON.stringify(o);
const parser = codex("gpt-6-astra");

// ---- the lines `codex exec --json` prints (#821's probe)

const thread = line({ type: "thread.started", thread_id: "thr-1" });
const message = (text: string) => line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
const command = line({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "pnpm test" } });
const completed = line({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });

const REPORT = {
  signal: COMPLETION_SIGNAL,
  unmet: { assessed: true, items: [{ who: "agent", text: "the docs lack the flag" }] },
  changelog: ["Fixed: add() returns the sum."],
  followups: ["a cross-review problem - its evidence"],
  ungated: ["look at the colour"],
};
const REPORT_JSON = JSON.stringify(REPORT);

// The refusal #821 recorded: no model turn, an `error` line, then `turn.failed` carrying the API's 400 body as a JSON string.
const BODY = {
  error: {
    message: "Invalid schema for response_format 'codex_output_schema': 'schema.additionalProperties' is required to be supplied and to be false when strict is true.",
    type: "invalid_request_error",
    param: "text.format.schema",
    code: "invalid_json_schema",
  },
};
const refusal = (body: string) => [thread, line({ type: "error", message: body }), line({ type: "turn.failed", error: { message: body } })];
const REFUSAL = refusal(JSON.stringify(BODY));

/** A capture on a clock the test moves, fed the lines through the library's own parser. */
const clocked = (make = codexReportCapture) => {
  let t = 0;
  const capture = make(() => t);
  return {
    capture,
    at(ms: number, raw: string) {
      t = ms;
      capture.line(raw, parser.parseStreamLine(raw));
    },
    finish(ms: number) {
      t = ms;
      capture.finish(ms);
    },
  };
};
const read = (lines: string[]) => {
  const c = clocked();
  lines.forEach((l, i) => c.at(i * 10, l));
  return c.capture.read();
};

// ---- the command

const options = { prompt: "review it", dangerouslySkipPermissions: true };
const crossAgent = async (agents: typeof import("../src/agents.ts")) => {
  const agent = await agents.crossReview("T-1", async (a) => a);
  assert.ok(agent, "CROSS_REVIEW=1 builds the codex provider");
  return agent;
};
const SCHEMA_FLAG = " --output-schema /etc/claude-code/report.schema.json";

test("with the switch off the codex command is today's; on, it carries --output-schema before the readout suffix", async () => {
  const plain = (await crossAgent(off)).buildPrintCommand(options).command;
  const withSchema = (await crossAgent(on)).buildPrintCommand(options).command;
  assert.match(plain, /^codex exec --json .*; rc=\$\?; .*; exit \$rc$/);
  assert.ok(!plain.includes("--output-schema"));
  assert.equal(withSchema, plain.replace("; rc=$?;", `${SCHEMA_FLAG}; rc=$?;`), "the same command with the flag inserted ahead of the suffix and nothing else");
  assert.ok(withSchema.indexOf("--output-schema") < withSchema.indexOf("; rc=$?;"));
  assert.equal(passReport(await crossAgent(off)), undefined);
  assert.ok(passReport(await crossAgent(on)), "the agent object gives its capture to the pass");
});

test("the schema file is where the sandbox has it, and a command of another shape is refused", () => {
  assert.equal(`${MANAGED_SETTINGS}/report.schema.json`, SCHEMA_FLAG.trim().split(" ")[1]);
  assert.equal(withOutputSchema("codex exec --json -m x"), `codex exec --json -m x${SCHEMA_FLAG}`);
  assert.throws(() => withOutputSchema("claude -p --output-format stream-json"), /update withOutputSchema in src\/agents\.ts/);
  assert.throws(() => withOutputSchema("codex --json -m x"), /update withOutputSchema/);
});

// ---- the capture

test("the report is the last agent_message, whatever prose came before", () => {
  const facts = read([thread, message("I'll check calc.py."), command, message("Fixed it."), command, message(REPORT_JSON), completed]);
  assert.deepEqual(facts.report, REPORT);
  assert.equal(facts.missing, undefined);
  assert.equal(facts.output, REPORT_JSON, "the pass's output is the result, which the library takes from the last message");
  assert.ok(!("tries" in facts) && !("turns" in facts), "a Codex pass has neither");
});

test("no agent message, a last message that is not JSON, and JSON of the wrong shape are each a missing report, not a throw", () => {
  assert.equal(read([thread, command, completed]).missing, "no agent message");
  const prose = read([thread, message(REPORT_JSON), message("Looks good.\n" + COMPLETION_SIGNAL), completed]);
  assert.equal(prose.report, undefined, "an earlier valid message does not stand in for a last one that is prose");
  assert.equal(prose.missing, "not JSON");
  const wrong = read([thread, message(JSON.stringify({ ...REPORT, extra: 1 })), completed]);
  assert.match(wrong.missing ?? "", /^invalid: not an object with the report's five fields$/);
  assert.match(read([thread, message(JSON.stringify({ ...REPORT, signal: "done" }))]).missing ?? "", /^invalid: signal is not the completion signal$/);
  assert.match(read([thread, message("[1, 2]")]).missing ?? "", /^invalid: /);
});

// The reason is read from `"code":"<value>"` anywhere in turn.failed's message: three shapes of the recorded body.
for (const [name, body] of [
  ["at the top of the JSON body", JSON.stringify({ ...BODY.error })],
  ["nested under error", JSON.stringify(BODY)],
  ["after a text prefix", `400 Bad Request: ${JSON.stringify(BODY)}`],
] as const) {
  test(`a refused schema is failed: invalid_json_schema, with the code ${name}`, () => {
    const facts = read(refusal(body));
    assert.equal(facts.report, undefined);
    assert.equal(facts.missing, "failed: invalid_json_schema");
  });
}

test("a failed turn with no code names the first 80 characters of its message", () => {
  const facts = read(refusal("x".repeat(200)));
  assert.equal(facts.missing, `failed: ${"x".repeat(80)}`);
  assert.equal(read([thread, line({ type: "turn.failed", error: {} })]).missing, "failed: turn failed");
});

test("a failed turn after a prose message is still the failure, not 'not JSON'", () => {
  assert.equal(read([thread, message("Working."), ...REFUSAL.slice(1)]).missing, "failed: invalid_json_schema");
});

// ---- the timing

test("a signal in a prose message with no JSON message after it is cut off, with figures that run to the pass's end", () => {
  const c = clocked();
  c.at(0, thread);
  c.at(1000, message(`Done.\n${COMPLETION_SIGNAL}`));
  c.at(1500, command);
  c.finish(5000);
  const facts = c.capture.read();
  assert.equal(facts.cutOff, true);
  assert.equal(facts.gapMs, 4000);
  assert.equal(facts.silenceMs, 3500, "the longest stretch with no line: from the last line to the finish");
  assert.equal(facts.missing, "not JSON");
});

test("a valid report after the signal gives the gap to the report's line and the silence between, and no cut-off", () => {
  const c = clocked();
  c.at(0, thread);
  c.at(1000, message(`Done.\n${COMPLETION_SIGNAL}`));
  c.at(1400, command);
  c.at(3000, message(REPORT_JSON));
  c.at(3100, completed);
  c.finish(9000);
  const facts = c.capture.read();
  assert.equal(facts.cutOff, undefined);
  assert.equal(facts.gapMs, 2000);
  assert.equal(facts.silenceMs, 1600);
  assert.deepEqual(facts.report, REPORT);
});

test("a signal that comes only in the report's message arms the window on it: no gap, no silence", () => {
  const c = clocked();
  c.at(0, thread);
  c.at(2000, message(REPORT_JSON));
  c.at(2100, completed);
  c.finish(2200);
  const facts = c.capture.read();
  assert.deepEqual([facts.gapMs, facts.silenceMs, facts.cutOff], [0, 0, undefined]);
});

test("a pass whose signal never came has no timing figures, and a second command starts the capture clean", () => {
  const c = clocked();
  c.at(0, message("No signal here."));
  const facts = c.capture.read();
  assert.deepEqual([facts.gapMs, facts.silenceMs, facts.cutOff], [undefined, undefined, undefined]);
  c.at(10, message(REPORT_JSON));
  c.capture.reset();
  assert.equal(c.capture.read().missing, "no agent message");
});

test("the JSON of a valid report holds the completion signal exactly, so the library's match arms on it", () => {
  assert.ok(REPORT_JSON.includes("<promise>COMPLETE</promise>"));
  assert.equal(COMPLETION_SIGNAL, "<promise>COMPLETE</promise>");
  const events = parser.parseStreamLine(message(REPORT_JSON));
  assert.ok(events.some((e) => e.type === "result" && e.result.includes(COMPLETION_SIGNAL)));
});

// ---- what a report says

test("a Codex report gives saidOf its unmet, ungated and changelog lines and its follow-ups, from the pass's capture", () => {
  const facts = read([thread, message("Looking."), message(REPORT_JSON), completed]);
  const said = saidOf(REPORT_JSON, facts);
  assert.equal(said.unmet, "the docs lack the flag");
  assert.equal(said.ungated, "look at the colour");
  assert.deepEqual(said.changelog.lines, ["Fixed: add() returns the sum."]);
  assert.deepEqual(said.followups, [{ title: "a cross-review problem", evidence: "its evidence" }]);
});

test("a Codex timings entry's report has no tries key", () => {
  const ok = reportTiming(read([thread, message(REPORT_JSON), completed]));
  assert.deepEqual(ok, { came: "report", gapMs: 0, silenceMs: 0 }, "the signal is in the report's own message");
  assert.ok(!("tries" in ok));
  const missing = reportTiming(read([thread, command, completed]));
  assert.deepEqual(missing, { came: "missing", missing: "no agent message" });
  assert.ok(!("tries" in reportTiming(read(REFUSAL), "boom")));
});

test("reportTiming keeps the capture's own failed: reason over the thrown error's text, as it keeps retries exhausted", () => {
  const facts = read(REFUSAL);
  assert.deepEqual(reportTiming(facts, "codex exited with code 1"), { came: "missing", missing: "failed: invalid_json_schema" });
  assert.equal(reportTiming(read([thread, command]), "codex exited with code 1").missing, "failed: codex exited with code 1");
});

test("the cross-review's gap is not read from text that parses as JSON when the switch is on, and always is for a review", () => {
  const said = saidOf("x");
  const gappy = "Fine.\n\nOne small inaccuracy\nremains in the README. It is minor.\n";
  assert.ok(reviewGap({ stdout: gappy, said }, true, true), "prose is read for a gap");
  // A report's strings are the schema's, not a reviewer's prose; one with escaped quotes is a text `gapOf` would flag.
  const json = JSON.stringify({ ...REPORT, ungated: ['The "gap" remains open, not fixed'] });
  assert.ok(gapOfText(json), "without the skip, this JSON reads as a gap");
  assert.equal(reviewGap({ stdout: json, said }, true, true), undefined);
  assert.equal(reviewGap({ stdout: "[\"a gap remains\"]", said }, true, true), undefined, "JSON of the wrong shape is JSON too");
  assert.ok(reviewGap({ stdout: json, said }, true, false), "with the switch off the cross-review is read as before");
  assert.ok(reviewGap({ stdout: json, said }, false, true), "a Claude review is read as before");
});

// ---- a failed pass

test("with the switch on, a cross-review whose run throws returns nothing and says the report schema was on", async () => {
  const { result, lines } = await quietly(() =>
    on.crossReview("#12", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(result, undefined);
  assert.deepEqual(lines, [
    "#12: gpt-6-astra cross-review failed with REPORT_SCHEMA=1 (boom); continuing without it - if Codex refused the report schema, every cross-review fails while the switch is on.",
  ]);
  const plain = await quietly(() =>
    off.crossReview("#12", async () => {
      throw new Error("boom");
    }),
  );
  assert.deepEqual(plain.lines, ["#12: gpt-6-astra cross-review failed (boom); continuing without it."], "off, the line is today's");
});

// A fake sandbox whose agent command prints the recorded refusal and exits 1, through Sandcastle's own agent invocation.
const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-rsc-")));
const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
writeFileSync(join(root, "tracked.txt"), "tracked\n");
git("add", "-A");
git("commit", "-q", "-m", "start");
mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });

const refusedPass = async (agent: Awaited<ReturnType<typeof crossAgent>>) => {
  const provider = createBindMountSandboxProvider({
    name: "fake",
    create: async ({ worktreePath }) => ({
      worktreePath,
      exec: async (cmd, opts) => {
        if (!/^(export [A-Za-z_]\w*='[^']*'; )*codex /.test(cmd)) return { stdout: "", stderr: "", exitCode: 0 };
        for (const l of REFUSAL) opts?.onLine?.(l);
        return { stdout: `${REFUSAL.join("\n")}\n`, stderr: "", exitCode: 1 };
      },
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      close: async () => {},
    }),
  });
  const sandbox = await createSandbox({ cwd: root, branch: `agent/rsc-${Math.random().toString(36).slice(2, 10)}`, baseBranch: "main", sandbox: provider });
  try {
    return await sandbox.run({
      agent,
      prompt: "review it",
      name: "review-codex-1",
      completionSignal: COMPLETION_SIGNAL,
      logging: { type: "file", path: join(root, ".sandcastle", "logs", `pass-${Math.random().toString(36).slice(2, 8)}.log`) },
    });
  } finally {
    await sandbox.close();
  }
};

test("a Codex agent fed the recorded refusal gives a timings entry failed: invalid_json_schema, and a cross-review line that names it", async () => {
  const agent = await crossAgent(on);
  let thrown: unknown;
  const { result, lines } = await quietly(() =>
    on.crossReview("#12", async () => {
      try {
        return await refusedPass(agent);
      } catch (error) {
        thrown = error;
        throw error;
      }
    }),
  );
  // crossReview built its own agent; the timings entry is read from the one the pass was given, as `pass` does.
  assert.equal(result, undefined);
  assert.ok(thrown, "the library throws for a failed turn, as it does for the pass");
  assert.match(lines.filter((l) => l.includes("cross-review"))[0], /^#12: gpt-6-astra cross-review failed with REPORT_SCHEMA=1 \(.*\); continuing without it - if Codex refused the report schema/);

  const given = await crossAgent(on);
  await quietly(() => refusedPass(given).catch(() => {}));
  const facts = passReport(given)?.read();
  assert.ok(facts);
  const timing = reportTiming(facts, agentFailure(thrown));
  assert.equal(timing.came, "missing");
  assert.equal(timing.missing, "failed: invalid_json_schema");
  assert.ok(!("tries" in timing));
});

test("a refused schema reaches the cross-review's own line as invalid_json_schema", async () => {
  // crossReview reads the reason from the agent it built, so the run callback must use that agent.
  const { result, lines } = await quietly(() => on.crossReview("#12", (agent) => refusedPass(agent as Awaited<ReturnType<typeof crossAgent>>)));
  assert.equal(result, undefined);
  assert.match(lines.filter((l) => l.includes("cross-review"))[0], /cross-review failed with REPORT_SCHEMA=1 \(invalid_json_schema\); continuing without it/);
});

// ---- the call sites (burndown() needs Docker)

const burndown = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");

test("pass files the follow-ups of the capture for every agent, Codex included", () => {
  assert.match(burndown, /const capture = passReport\(opts\.agent\);/);
  assert.match(burndown, /const facts = capture\?\.read\(\);\n\s+if \(facts\) ctx\.reportTimings\?\.set\(issue\.id, reportTiming\(facts\)\);\n\s+const said = saidOf\(r\.stdout \?\? "", facts\);\n\s+for \(const f of said\.followups\) ctx\.followUps\?\.push\(/);
  assert.doesNotMatch(burndown, /(?:claude|codex|isCodex|cross)\S*\s*\?[^\n]*passReport/i, "no agent is skipped");
});

test("the review loop reads the cross-review's gap through reviewGap, and its follow-ups and lines through the pass's said", () => {
  assert.match(burndown, /for \(const \[r, isCross\] of \[\[review, false\], \[cross, true\]\] as const\) \{/);
  assert.match(burndown, /const g = r && reviewGap\(r, isCross\);/);
  assert.match(burndown, /noteChangelog\(r\?\.said\);/);
  assert.match(burndown, /const m = r\?\.said\.unmet;/);
  assert.match(burndown, /schema && cross && isJson\(r\.stdout\) \? undefined : gapOf\(r\.stdout, r\.said\)/);
});

test("reportTiming and crossReview prefer the capture's failed: reason", () => {
  assert.match(burndown, /facts\.missing\?\.startsWith\("failed: "\) \? facts\.missing : `failed: \$\{failed\}`/);
  const agents = readFileSync(join(import.meta.dirname, "../src/agents.ts"), "utf8");
  assert.match(agents, /reason\?\.startsWith\("failed: "\) \? reason\.slice\("failed: "\.length\) : agentFailure\(error\)/);
});
